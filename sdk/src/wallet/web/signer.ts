import type { Address, WalletClient } from "viem";
import type { PcashActionSigner } from "@pcash/sdk/eip712";

async function assertViemIdentity(
  client: WalletClient,
  address: Address,
  expectedChainId: bigint,
): Promise<void> {
  const chainId = BigInt(await client.getChainId());
  if (chainId !== expectedChainId) {
    throw new Error(`wallet changed to chain ${chainId}, expected chain ${expectedChainId}`);
  }
  const selected = (await client.getAddresses())[0];
  if (selected === undefined) throw new Error("wallet has no connected account");
  if (selected.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`wallet changed account from ${address} to ${selected}`);
  }
}

/** Bridge PCASH authorization requests to a viem wallet client. */
export function viemPcashActionSigner(
  client: WalletClient,
  address: Address,
): PcashActionSigner {
  const numericAddress = BigInt(address);
  return {
    address: numericAddress,
    async signTypedData(request): Promise<string> {
      if (request.authorizingAddress !== numericAddress) {
        throw new Error("selected wallet account does not match the PCASH action's authorizing address");
      }
      await assertViemIdentity(client, address, BigInt(request.typedData.domain.chainId));
      const { EIP712Domain: _domainFields, ...types } = request.typedData.types;
      return client.signTypedData({
        account: address,
        domain: request.typedData.domain,
        types,
        primaryType: request.typedData.primaryType,
        message: request.typedData.message as Record<string, unknown>,
      } as never);
    },
  };
}
