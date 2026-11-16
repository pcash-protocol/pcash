//! A PCASH node's JSON-RPC: its status and block hashes.

use alloy_primitives::B256;
use alloy_provider::{Provider, RootProvider};
use eyre::{eyre, Result};

pub async fn status(node_rpc: &str) -> Result<serde_json::Value> {
    let provider = RootProvider::<alloy_provider::network::Ethereum>::new_http(node_rpc.parse()?);
    Ok(provider.raw_request("pcash_status".into(), ()).await?)
}

/// A JSON-RPC quantity: a `0x` hex string.
pub fn quantity(value: &serde_json::Value) -> Result<u64> {
    let text = value.as_str().ok_or_else(|| eyre!("not a quantity: {value}"))?;
    Ok(u64::from_str_radix(text.trim_start_matches("0x"), 16)?)
}

/// The node's hash for PCASH block `number` (`pcash_getBlockHeader`).
pub async fn block_hash(node_rpc: &str, number: u64) -> Result<B256> {
    let provider = RootProvider::<alloy_provider::network::Ethereum>::new_http(node_rpc.parse()?);
    let response: serde_json::Value = provider
        .raw_request("pcash_getBlockHeader".into(), (format!("{number:#x}"),))
        .await?;
    let hash = response["boundary"]["blockHash"]
        .as_str()
        .ok_or_else(|| eyre!("no boundary.blockHash in {response}"))?;
    Ok(hash.parse()?)
}
