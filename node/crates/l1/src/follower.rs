//! Reorg-aware L1 cursor.
//!
//! The follower yields [`L1BlockData`] in ascending height, tracks head and
//! finalized, and checks parent-hash continuity. On a mismatch it reports a
//! [`Reorg`] without advancing. The node can then find the common ancestor,
//! restore the matching state savepoint, and derive the replacement branch.
//!
//! The follower does not itself hold savepoints or decide finality policy. The
//! caller treats a reorg below the locally finalized height as fatal.

use alloy_primitives::B256;

use crate::client::L1Client;
use crate::error::Result;
use crate::types::L1BlockData;

/// A parent-hash discontinuity detected at the cursor.
///
/// `at_number` is the height the cursor tried to advance to. `expected_parent`
/// is the hash of the block previously yielded at `at_number - 1`;
/// `actual_parent` is the `parent_hash` the RPC now reports for `at_number`, or,
/// at head before block `at_number` exists, the hash it reports for
/// `at_number - 1`.
/// The caller walks back from `at_number - 1` on block hashes to the most recent
/// still-canonical block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reorg {
    pub at_number: u64,
    pub expected_parent: B256,
    pub actual_parent: B256,
}

pub fn check_continuity(
    expected_parent: Option<B256>,
    actual_parent: B256,
    at_number: u64,
) -> Option<Reorg> {
    match expected_parent {
        Some(expected) if expected != actual_parent => Some(Reorg {
            at_number,
            expected_parent: expected,
            actual_parent,
        }),
        _ => None,
    }
}

/// The outcome of one [`Follower::next`] step.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// A new block was fetched and the cursor advanced past it.
    Block(L1BlockData),
    /// A parent-hash discontinuity: the cursor did NOT advance. The caller must
    /// walk back and [`Follower::rewind_to`] a still-canonical height.
    Reorg(Reorg),
    /// The cursor has caught up to the head; nothing new to yield yet.
    AtHead,
}

/// A cursor over L1 blocks with head/finalized tracking and reorg detection.
pub struct Follower {
    client: L1Client,
    /// Next height to fetch.
    cursor: u64,
    /// Hash of the last block yielded (`cursor - 1`), or `None` at a cold start /
    /// after a rewind with no anchor.
    last_hash: Option<B256>,
    head: u64,
    finalized: u64,
}

impl Follower {
    /// Start a follower at `start_height`. Head/finalized are zero until the
    /// first [`Follower::refresh`] or [`Follower::next`].
    pub fn new(client: L1Client, start_height: u64) -> Self {
        Self {
            client,
            cursor: start_height,
            last_hash: None,
            head: 0,
            finalized: 0,
        }
    }

    /// The next height the cursor will fetch.
    pub fn cursor(&self) -> u64 {
        self.cursor
    }

    /// Hash of the most recently yielded block, if any.
    pub fn last_hash(&self) -> Option<B256> {
        self.last_hash
    }

    /// Last observed L1 head height (`latest`).
    pub fn head(&self) -> u64 {
        self.head
    }

    /// Last observed L1 `finalized` height.
    pub fn finalized(&self) -> u64 {
        self.finalized
    }

    /// Borrow the underlying client.
    pub fn client(&self) -> &L1Client {
        &self.client
    }

    /// Refresh the cached head height from the RPC.
    pub async fn refresh_head(&mut self) -> Result<()> {
        self.head = self.client.latest_block_number().await?;
        Ok(())
    }

    /// Refresh the cached finalized height from the RPC.
    pub async fn refresh_finalized(&mut self) -> Result<()> {
        self.finalized = self.client.finalized_block_number().await?;
        Ok(())
    }

    /// Refresh cached head and finalized heights from the RPC.
    pub async fn refresh(&mut self) -> Result<()> {
        self.refresh_head().await?;
        self.refresh_finalized().await
    }

    /// Move the cursor to `number`, anchoring continuity on `parent_hash_anchor`
    /// — the hash of block `number - 1` on the chain the caller believes is
    /// canonical (or `None` to skip the next continuity check, e.g. when
    /// restarting from a fresh snapshot boundary).
    ///
    /// This is the walk-back primitive: after a [`Reorg`], the caller finds the
    /// deepest still-canonical block `k` (by comparing hashes) and calls
    /// `rewind_to(k + 1, Some(hash_of_k))`.
    pub fn rewind_to(&mut self, number: u64, parent_hash_anchor: Option<B256>) {
        self.cursor = number;
        self.last_hash = parent_hash_anchor;
    }

    pub async fn next(&mut self) -> Result<Step> {
        if self.cursor > self.head {
            self.refresh().await?;
            if self.cursor > self.head {
                return self.recheck_last_yielded().await;
            }
        }

        let data = self.client.block_data_by_number(self.cursor).await?;
        Ok(self.accept_prefetched(data))
    }

    /// At head no next block arrives whose parent hash would show a reorg, so
    /// one that replaced the last yielded block at its own height would stay
    /// unseen until a later block appears. Compare that block's hash with the
    /// RPC's. A head below it may be a lagging endpoint rather than a shorter
    /// chain, so that case waits for the next block's continuity check. A
    /// caller that waits at head without calling [`Self::next`] runs this each
    /// time it polls.
    pub async fn recheck_last_yielded(&self) -> Result<Step> {
        let (Some(expected), Some(last)) = (self.last_hash, self.cursor.checked_sub(1)) else {
            return Ok(Step::AtHead);
        };
        if self.head < last {
            return Ok(Step::AtHead);
        }
        let actual = self.client.block_hash_by_number(last).await?;
        Ok(
            match check_continuity(Some(expected), actual, self.cursor) {
                Some(reorg) => Step::Reorg(reorg),
                None => Step::AtHead,
            },
        )
    }

    /// Apply the continuity check to an already-fetched block at the cursor and,
    /// if continuous, advance the cursor past it.
    ///
    /// Catch-up callers use this method for the same continuity and cursor
    /// update as [`Follower::next`]. `data` must be at the current cursor.
    /// Returns [`Step::Reorg`] with no advance on a parent-hash discontinuity, or
    /// [`Step::Block`] after advancing the cursor by one.
    pub fn accept_prefetched(&mut self, data: L1BlockData) -> Step {
        debug_assert_eq!(
            data.header.number, self.cursor,
            "accept_prefetched: block {} does not match cursor {}",
            data.header.number, self.cursor
        );
        if let Some(reorg) = check_continuity(self.last_hash, data.header.parent_hash, self.cursor)
        {
            return Step::Reorg(reorg);
        }

        self.last_hash = Some(data.header.hash);
        self.cursor += 1;
        Step::Block(data)
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::*;
    use alloy_primitives::b256;

    const A: B256 = b256!("0x1111111111111111111111111111111111111111111111111111111111111111");
    const B: B256 = b256!("0x2222222222222222222222222222222222222222222222222222222222222222");

    #[test]
    fn cold_start_never_reorgs() {
        // No expected parent yet: any parent hash is accepted.
        assert_eq!(check_continuity(None, A, 100), None);
    }

    #[test]
    fn continuous_chain_is_ok() {
        // Block 101's parent hash equals block 100's hash.
        assert_eq!(check_continuity(Some(A), A, 101), None);
    }

    #[test]
    fn discontinuity_flags_reorg() {
        // Expected parent A, but RPC reports parent B at height 101.
        let r = check_continuity(Some(A), B, 101).expect("should detect reorg");
        assert_eq!(
            r,
            Reorg {
                at_number: 101,
                expected_parent: A,
                actual_parent: B
            }
        );
    }

    /// An RPC whose chain is a head height and a hash per height.
    #[derive(Clone)]
    struct Chain(std::sync::Arc<std::sync::Mutex<(u64, std::collections::HashMap<u64, B256>)>>);

    impl Chain {
        fn set(&self, head: u64, hashes: &[(u64, B256)]) {
            let mut chain = self.0.lock().unwrap();
            chain.0 = head;
            chain.1 = hashes.iter().copied().collect();
        }
    }

    impl tower::Service<alloy_json_rpc::RequestPacket> for Chain {
        type Response = alloy_json_rpc::ResponsePacket;
        type Error = alloy_transport::TransportError;
        type Future = alloy_transport::TransportFut<'static>;

        fn poll_ready(
            &mut self,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::result::Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn call(&mut self, request: alloy_json_rpc::RequestPacket) -> Self::Future {
            let alloy_json_rpc::RequestPacket::Single(request) = request else {
                panic!("unexpected batch")
            };
            let (head, hashes) = self.0.lock().unwrap().clone();
            let params: serde_json::Value =
                request.params().map_or(serde_json::Value::Null, |raw| {
                    serde_json::from_str(raw.get()).unwrap()
                });
            let payload = match request.method() {
                "eth_blockNumber" => serde_json::json!(format!("{head:#x}")),
                "eth_getBlockByNumber" => {
                    let number = match params[0].as_str().unwrap() {
                        "finalized" => head,
                        hex => u64::from_str_radix(hex.trim_start_matches("0x"), 16).unwrap(),
                    };
                    let mut block: serde_json::Value = serde_json::from_str(include_str!(concat!(
                        env!("CARGO_MANIFEST_DIR"),
                        "/tests/fixtures/block_3000000.json"
                    )))
                    .unwrap();
                    block["number"] = serde_json::json!(format!("{number:#x}"));
                    block["hash"] =
                        serde_json::json!(hashes.get(&number).copied().unwrap_or(B256::ZERO));
                    block
                }
                method => panic!("unexpected RPC method {method}"),
            };
            let id = request.id().clone();
            Box::pin(async move {
                Ok(alloy_json_rpc::ResponsePacket::Single(
                    alloy_json_rpc::Response {
                        id,
                        payload: alloy_json_rpc::ResponsePayload::Success(
                            serde_json::value::to_raw_value(&payload).unwrap(),
                        ),
                    },
                ))
            })
        }
    }

    #[tokio::test]
    async fn at_head_a_replaced_last_block_is_a_reorg() {
        let chain = Chain(Default::default());
        let mut follower = Follower::new(L1Client::from_transport(chain.clone(), true), 0);
        // Block 100 with hash A was the last one yielded.
        follower.rewind_to(101, Some(A));

        chain.set(100, &[(100, A)]);
        assert_eq!(follower.next().await.unwrap(), Step::AtHead);

        // Same height, different block: reported before block 101 exists.
        chain.set(100, &[(100, B)]);
        assert_eq!(
            follower.next().await.unwrap(),
            Step::Reorg(Reorg {
                at_number: 101,
                expected_parent: A,
                actual_parent: B
            })
        );
        assert_eq!(follower.cursor(), 101);

        // A head below the last yielded block may be a lagging endpoint, and a
        // cold start has no hash to compare.
        chain.set(99, &[(99, B)]);
        assert_eq!(follower.next().await.unwrap(), Step::AtHead);
        follower.rewind_to(101, None);
        chain.set(100, &[(100, B)]);
        assert_eq!(follower.next().await.unwrap(), Step::AtHead);
    }
}
