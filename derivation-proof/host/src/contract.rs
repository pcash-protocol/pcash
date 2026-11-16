//! `PcashState`: PCASH checkpoints on Ethereum, each advanced by `proveBlock`
//! with an aggregation proof. Proofs are checked by SP1's PLONK verifier, or by
//! `ExecutedVerifier` standing in for it in development.
//!
//! Transactions are signed with a key when one is given, and otherwise sent
//! with `eth_sendTransaction` from an account the Ethereum node holds
//! unlocked, as Anvil's are.

use std::path::Path;

use alloy_network::EthereumWallet;
use alloy_primitives::{address, b256, keccak256, Address, Bytes, B256, U256};
use alloy_provider::network::TransactionBuilder;
use alloy_provider::{DynProvider, Provider, ProviderBuilder, RootProvider};
use alloy_rpc_types_eth::{BlockId, BlockNumberOrTag, TransactionRequest};
use alloy_signer_local::PrivateKeySigner;
use alloy_sol_types::{SolCall, SolValue};
use eyre::{ensure, eyre, Result};

alloy_sol_types::sol! {
    interface IPcashState {
        function getAnchorRoot() external view returns (bytes32, uint256);
        function INTERVAL() external view returns (uint256);
        function CONFIG_HASH() external view returns (bytes32);
        function AGGREGATION_VKEY() external view returns (bytes32);
        function RANGE_VKEY_COMMITMENT() external view returns (bytes32);
        function VERIFIER() external view returns (address);
        function proveBlock(uint256 blockNumber, bytes32 root, uint256 l1BlockNumber, bytes proof) external;
    }

}

/// SP1's v6.1.0 PLONK verifier, which has no owner, and the keccak-256 of its
/// code, both the same on Ethereum and Sepolia.
const SP1_PLONK_VERIFIER: Address = address!("c3c6dDDAc8829b233Dc6536Ec024775a57b0AF2A");
const SP1_PLONK_VERIFIER_CODE_HASH: B256 = b256!("a5c9448eec43538d11533b207300fd13277c14c0800d33549a9492e7e8bdf84b");
/// The `VERIFIER_HASH` of that code: the SHA-256 of the PLONK key it checks
/// proofs against, which must be the SDK's.
#[cfg(test)]
const SP1_PLONK_VERIFIER_HASH: B256 = b256!("5a093a2fcb46394f5cadfe55c44d4d572fad9cec7aeb38026b0278322ef07fac");

/// A contract the Foundry project at `contracts` compiled.
fn artifact(contracts: &Path, name: &str) -> Result<serde_json::Value> {
    let path = contracts.join("out").join(format!("{name}.sol")).join(format!("{name}.json"));
    let json = std::fs::read(&path).map_err(|error| eyre!("{}: {error}", path.display()))?;
    Ok(serde_json::from_slice(&json)?)
}

pub struct Ethereum {
    provider: DynProvider,
    pub from: Address,
}

/// `PcashState`'s constructor arguments that vary.
pub struct ContractConfig {
    pub interval: u64,
    pub start_block: u64,
    pub start_root: B256,
    pub pcash_chain_id: u32,
    pub inbox: Address,
    pub genesis_l1_block: u64,
    pub genesis_l1_block_hash: B256,
    pub aggregation_vkey: B256,
    pub range_vkey: B256,
}

impl Ethereum {
    /// Send from an account the node holds unlocked.
    pub fn unlocked(rpc: &str, from: Address) -> Result<Self> {
        Ok(Self {
            provider: RootProvider::new_http(rpc.parse()?).erased(),
            from,
        })
    }

    /// Sign with `key`.
    pub fn signing(rpc: &str, key: PrivateKeySigner) -> Result<Self> {
        let from = key.address();
        let provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(key))
            .connect_http(rpc.parse()?)
            .erased();
        Ok(Self { provider, from })
    }

    /// Call `to` at `block`; `None` when it held no code then.
    async fn call_at<C: SolCall>(&self, to: Address, call: C, block: BlockId) -> Result<Option<C::Return>> {
        let request = TransactionRequest::default()
            .with_to(to)
            .with_input(Bytes::from(call.abi_encode()));
        let output = self.provider.call(request).block(block).await?;
        if output.is_empty() {
            return Ok(None);
        }
        Ok(Some(C::abi_decode_returns(&output)?))
    }

    async fn call<C: SolCall>(&self, to: Address, call: C) -> Result<C::Return> {
        self.call_at(to, call, BlockId::latest())
            .await?
            .ok_or_else(|| eyre!("no contract at {to}"))
    }

    async fn send(&self, request: TransactionRequest) -> Result<alloy_rpc_types_eth::TransactionReceipt> {
        let receipt = self
            .provider
            .send_transaction(request.with_from(self.from))
            .await?
            .get_receipt()
            .await?;
        ensure!(receipt.status(), "transaction {} reverted", receipt.transaction_hash);
        Ok(receipt)
    }

    async fn transact<C: SolCall>(&self, to: Address, call: C) -> Result<()> {
        self.send(
            TransactionRequest::default()
                .with_to(to)
                .with_input(Bytes::from(call.abi_encode())),
        )
        .await?;
        Ok(())
    }

    async fn deploy(&self, contracts: &Path, name: &str, arguments: Vec<u8>) -> Result<Address> {
        let bytecode = artifact(contracts, name)?["bytecode"]["object"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| eyre!("{name} has no bytecode"))?;
        let mut code = alloy_primitives::hex::decode(bytecode)?;
        code.extend(arguments);
        let receipt = self
            .send(TransactionRequest::default().with_deploy_code(Bytes::from(code)))
            .await?;
        receipt
            .contract_address
            .ok_or_else(|| eyre!("{name} deployment created no contract"))
    }

    /// Deploy `PcashState` anchored at `config.start_block`, verifying proofs
    /// with SP1's PLONK verifier, or with a new `ExecutedVerifier`.
    pub async fn deploy_pcash_state(&self, contracts: &Path, config: &ContractConfig, executed_verifier: bool) -> Result<Address> {
        let verifier = if executed_verifier {
            self.deploy(contracts, "ExecutedVerifier", Vec::new()).await?
        } else {
            ensure!(
                self.is_sp1_plonk_verifier(SP1_PLONK_VERIFIER).await?,
                "SP1's PLONK verifier is not at {SP1_PLONK_VERIFIER} on this chain"
            );
            SP1_PLONK_VERIFIER
        };
        let arguments = (
            U256::from(config.interval),
            config.start_root,
            U256::from(config.start_block),
            config.pcash_chain_id,
            config.inbox,
            config.genesis_l1_block,
            config.genesis_l1_block_hash,
            verifier,
            config.aggregation_vkey,
            config.range_vkey,
        )
            .abi_encode_params();
        let contract = self.deploy(contracts, "PcashState", arguments).await?;
        println!("verifier {verifier}, contract {contract}");
        Ok(contract)
    }

    pub async fn anchor(&self, contract: Address) -> Result<(B256, u64)> {
        let anchor = self.call(contract, IPcashState::getAnchorRootCall {}).await?;
        Ok((anchor._0, u64::try_from(anchor._1)?))
    }

    /// The contract's anchor block as of Ethereum's finalized block; `None`
    /// before the contract's deployment is final.
    pub async fn finalized_anchor(&self, contract: Address) -> Result<Option<u64>> {
        let anchor = self
            .call_at(contract, IPcashState::getAnchorRootCall {}, BlockNumberOrTag::Finalized.into())
            .await?;
        Ok(anchor.map(|anchor| u64::try_from(anchor._1)).transpose()?)
    }

    pub async fn interval(&self, contract: Address) -> Result<u64> {
        Ok(u64::try_from(self.call(contract, IPcashState::INTERVALCall {}).await?)?)
    }

    /// The contract's configuration hash and the aggregation and range program
    /// keys it expects.
    pub async fn config(&self, contract: Address) -> Result<(B256, B256, B256)> {
        Ok((
            self.call(contract, IPcashState::CONFIG_HASHCall {}).await?,
            self.call(contract, IPcashState::AGGREGATION_VKEYCall {}).await?,
            self.call(contract, IPcashState::RANGE_VKEY_COMMITMENTCall {}).await?,
        ))
    }

    pub async fn verifier(&self, contract: Address) -> Result<Address> {
        self.call(contract, IPcashState::VERIFIERCall {}).await
    }

    /// Whether the code at `address` is the Foundry project's `name` as
    /// compiled, for a contract without immutables.
    pub async fn code_is(&self, address: Address, contracts: &Path, name: &str) -> Result<bool> {
        let artifact = artifact(contracts, name)?;
        let object = artifact["deployedBytecode"]["object"]
            .as_str()
            .ok_or_else(|| eyre!("{name} has no deployed bytecode"))?;
        Ok(self.provider.get_code_at(address).await?.as_ref() == alloy_primitives::hex::decode(object)?.as_slice())
    }

    /// Whether the code at `address` is SP1's v6.1.0 PLONK verifier.
    pub async fn is_sp1_plonk_verifier(&self, address: Address) -> Result<bool> {
        Ok(keccak256(self.provider.get_code_at(address).await?) == SP1_PLONK_VERIFIER_CODE_HASH)
    }

    pub async fn latest_block(&self) -> Result<u64> {
        Ok(self.provider.get_block_number().await?)
    }

    /// Ethereum's finalized block: its number and hash.
    pub async fn finalized_block(&self) -> Result<(u64, B256)> {
        let block = self
            .provider
            .get_block_by_number(BlockNumberOrTag::Finalized)
            .await?
            .ok_or_else(|| eyre!("no finalized block"))?;
        Ok((block.header.number, block.header.hash))
    }

    pub async fn prove_block(&self, contract: Address, pcash_block: u64, root: B256, l1_block: u64, proof: Bytes) -> Result<()> {
        let call = IPcashState::proveBlockCall {
            blockNumber: U256::from(pcash_block),
            root,
            l1BlockNumber: U256::from(l1_block),
            proof,
        };
        self.transact(contract, call).await
    }
}

#[cfg(test)]
mod tests {
    use alloy_primitives::B256;
    use sha2::{Digest, Sha256};

    #[test]
    fn the_plonk_verifier_takes_the_sdks_proofs() {
        let key = B256::from_slice(&Sha256::digest(*sp1_verifier::PLONK_VK_BYTES));
        assert_eq!(key, super::SP1_PLONK_VERIFIER_HASH);
    }
}
