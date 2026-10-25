#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]

use std::sync::{Arc, Mutex};

use alloy_primitives::B256;
use pcash_derive::private_value_profiles::S;
use pcash_rpc::dto::{
    BlockId, OutputItemDto, OutputMaterialDto, OutputOriginDto, OutputPageDto, OutputTargetDto,
};
use pcash_rpc::OutputRequest;

use crate::follow::{sync, BoardSource, SyncOutcome};
use crate::post::{encode_post_data, post_schema, BoardNetwork, Post};
use crate::store::{BoardStore, Cursor};

const NETWORK: BoardNetwork = BoardNetwork {
    chain_id: 7,
    genesis_hash: B256::repeat_byte(0xee),
};
const BOARD: B256 = B256::repeat_byte(0xb0);
/// Outputs each test transaction creates, so a post's transaction spans
/// several output indices.
const OUTPUTS_PER_TRANSACTION: u64 = 3;

/// An arena whose public segment carries `data` as a board post.
fn post_arena(data: &[u8]) -> Vec<u8> {
    let mut list = post_schema().to_vec();
    assert!(data.len() < 0x4000);
    let length = data.len();
    if length < 0x80 {
        list.push(length as u8);
    } else {
        list.extend([(length as u8 & 0x7f) | 0x80, (length >> 7) as u8]);
    }
    list.extend_from_slice(data);
    let mut arena = vec![0u8; S.arena_bytes];
    arena[32..40].copy_from_slice(b"PCASHPUB");
    arena[40..42].copy_from_slice(&(list.len() as u16).to_be_bytes());
    arena[42..42 + list.len()].copy_from_slice(&list);
    arena
}

#[derive(Clone)]
struct FakeTransaction {
    arena: Vec<u8>,
    transaction_type: u8,
}

#[derive(Clone)]
struct FakeBlock {
    hash: B256,
    transactions: Vec<FakeTransaction>,
}

/// A node whose canonical chain is `blocks`, with its index ready at the tip.
#[derive(Default)]
struct FakeNode {
    blocks: Mutex<Vec<FakeBlock>>,
    network: Option<BoardNetwork>,
}

impl FakeNode {
    fn push(&self, hash: u8, transactions: Vec<FakeTransaction>) {
        self.blocks.lock().unwrap().push(FakeBlock {
            hash: B256::repeat_byte(hash),
            transactions,
        });
    }

    /// Replace every block from `number` on.
    fn reorg(&self, number: usize) {
        self.blocks.lock().unwrap().truncate(number);
    }

    fn outputs(&self) -> (Vec<OutputItemDto>, BlockId) {
        let blocks = self.blocks.lock().unwrap();
        let mut outputs = Vec::new();
        let mut index = 0u64;
        for (number, block) in blocks.iter().enumerate() {
            for (position, transaction) in block.transactions.iter().enumerate() {
                for slot in 0..OUTPUTS_PER_TRANSACTION {
                    outputs.push(OutputItemDto {
                        output_index: index,
                        output_commitment: B256::ZERO,
                        origin: OutputOriginDto {
                            block_number: number as u64,
                            block_hash: block.hash,
                            block_timestamp: 1_000 + number as u64,
                        },
                        material: OutputMaterialDto::Ordinary {
                            output_data: Vec::new().into(),
                            transaction_id: B256::with_last_byte(position as u8),
                            transaction_type: transaction.transaction_type,
                            private_value_shape: Some(0),
                            output_slot: slot as u16,
                            content_hash: B256::with_last_byte(index as u8),
                            nullifiers: Vec::new(),
                            arena: (slot == 0).then(|| transaction.arena.clone().into()),
                        },
                    });
                    index += 1;
                }
            }
        }
        let tip = blocks.last().unwrap();
        (
            outputs,
            BlockId {
                block_number: blocks.len() as u64 - 1,
                block_hash: tip.hash,
            },
        )
    }
}

impl BoardSource for FakeNode {
    fn ready_cursor(&self) -> Result<(BoardNetwork, Option<BlockId>), String> {
        Ok((self.network.unwrap_or(NETWORK), Some(self.outputs().1)))
    }

    fn get_outputs(&self, request: OutputRequest) -> Result<OutputPageDto, String> {
        let (outputs, tip) = self.outputs();
        assert_eq!(request.target, tip);
        let start = request.from_output_index - request.from_output_index % OUTPUTS_PER_TRANSACTION;
        Ok(OutputPageDto {
            from_output_index: start,
            target: OutputTargetDto {
                block: tip,
                output_count: outputs.len() as u64,
            },
            outputs: outputs.into_iter().skip(start as usize).collect(),
            continuation: None,
            complete: true,
        })
    }

    fn is_canonical(&self, block_hash: B256) -> Result<bool, String> {
        Ok(self
            .blocks
            .lock()
            .unwrap()
            .iter()
            .any(|block| block.hash == block_hash))
    }
}

struct Posts(u8);

impl Posts {
    /// A post and the transaction carrying it.
    fn post(&mut self, parent: Option<&Post>, text: &str) -> (Post, FakeTransaction) {
        self.0 += 1;
        let data = encode_post_data(
            BOARD,
            parent.map(|parent| parent.id),
            B256::repeat_byte(self.0),
            text,
        );
        let arena = post_arena(&data);
        let records = pcash_derive::public_records::read_public_records(&arena).unwrap();
        (
            crate::post::decode_post(NETWORK, &records).unwrap(),
            FakeTransaction {
                arena,
                transaction_type: pcash_derive::KIND_PRIVATE_VALUE,
            },
        )
    }
}

fn synced(node: &FakeNode, store: &BoardStore) -> Cursor {
    match sync(node, store).unwrap() {
        SyncOutcome::Synced(cursor) => cursor,
        outcome => panic!("expected a sync, got {outcome:?}"),
    }
}

fn thread_ids(store: &BoardStore) -> Vec<(B256, u64)> {
    store
        .read()
        .unwrap()
        .threads(BOARD, None, 100)
        .unwrap()
        .items
        .into_iter()
        .map(|thread| (thread.root.post.post.id, thread.post_count))
        .collect()
}

fn reply_ids(store: &BoardStore, root: B256) -> Vec<B256> {
    store
        .read()
        .unwrap()
        .replies(root, None, 100)
        .unwrap()
        .items
        .into_iter()
        .map(|post| post.post.post.id)
        .collect()
}

#[test]
fn threads_follow_parents_and_order_by_activity() {
    let node = FakeNode::default();
    let store = BoardStore::in_memory(NETWORK).unwrap();
    let mut posts = Posts(0);
    let (root, root_tx) = posts.post(None, "first thread");
    let (reply, reply_tx) = posts.post(Some(&root), "a reply");
    let (nested, nested_tx) = posts.post(Some(&reply), "a nested reply");
    let (second, second_tx) = posts.post(None, "second thread");
    let not_a_post = FakeTransaction {
        arena: vec![0; S.arena_bytes],
        transaction_type: pcash_derive::KIND_PRIVATE_VALUE,
    };
    let other_kind = FakeTransaction {
        transaction_type: pcash_derive::KIND_USER_ACCOUNT_UPDATE,
        ..root_tx.clone()
    };
    node.push(1, vec![root_tx.clone(), not_a_post, reply_tx]);
    node.push(2, vec![nested_tx, other_kind, second_tx]);
    let cursor = synced(&node, &store);
    assert_eq!(cursor.block_number, 1);
    assert_eq!(cursor.next_output_index, 6 * OUTPUTS_PER_TRANSACTION);
    assert_eq!(thread_ids(&store), vec![(second.id, 1), (root.id, 3)]);
    assert_eq!(reply_ids(&store, root.id), vec![reply.id, nested.id]);

    // The same record published again is the same post, kept at its first inclusion.
    let (late, late_tx) = posts.post(Some(&nested), "a late reply");
    node.push(3, vec![root_tx, late_tx]);
    synced(&node, &store);
    assert_eq!(thread_ids(&store), vec![(root.id, 4), (second.id, 1)]);
    let read = store.read().unwrap();
    assert_eq!(read.post_count().unwrap(), 5);
    let late = read.post(late.id).unwrap().unwrap();
    assert_eq!(late.thread, root.id);
    assert!(!late.missing_parent);
    assert_eq!(
        read.thread_of(nested.id)
            .unwrap()
            .unwrap()
            .root
            .post
            .post
            .id,
        root.id
    );
    assert_eq!(read.post(root.id).unwrap().unwrap().post.block_number, 0);
    assert_eq!(
        read.board_posts(BOARD, None, 100)
            .unwrap()
            .items
            .iter()
            .map(|post| post.post.post.id)
            .collect::<Vec<_>>(),
        vec![late.post.post.id, second.id, nested.id, reply.id, root.id]
    );
    assert!(read.threads(B256::ZERO, None, 10).unwrap().items.is_empty());
}

#[test]
fn pages_continue_where_the_last_ended() {
    let node = FakeNode::default();
    let store = BoardStore::in_memory(NETWORK).unwrap();
    let mut posts = Posts(0);
    let (root, root_tx) = posts.post(None, "root");
    let mut transactions = vec![root_tx];
    let mut replies = Vec::new();
    for text in ["a", "b", "c", "d", "e"] {
        let (reply, tx) = posts.post(Some(&root), text);
        replies.push(reply.id);
        transactions.push(tx);
    }
    let mut roots = Vec::new();
    for text in ["x", "y", "z"] {
        let (thread, tx) = posts.post(None, text);
        roots.push(thread.id);
        transactions.push(tx);
    }
    node.push(1, transactions);
    synced(&node, &store);
    let read = store.read().unwrap();

    let mut seen = Vec::new();
    let mut cursor = None;
    loop {
        let page = read.replies(root.id, cursor, 2).unwrap();
        seen.extend(page.items.iter().map(|post| post.post.post.id));
        match page.next {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(seen, replies);

    let first = read.threads(BOARD, None, 3).unwrap();
    let ids = first
        .items
        .iter()
        .map(|thread| thread.root.post.post.id)
        .collect::<Vec<_>>();
    assert_eq!(ids, vec![roots[2], roots[1], roots[0]]);
    let rest = read.threads(BOARD, first.next, 3).unwrap();
    assert_eq!(rest.items.len(), 1);
    assert_eq!(rest.items[0].root.post.post.id, root.id);
    assert_eq!(rest.next, None);

    let newest = read.board_posts(BOARD, None, 4).unwrap();
    let older = read.board_posts(BOARD, newest.next, 100).unwrap();
    assert_eq!(newest.items.len() + older.items.len(), 9);
    assert_eq!(older.items.last().unwrap().post.post.id, root.id);
}

#[test]
fn a_reply_before_its_parent_joins_the_parent_thread() {
    let node = FakeNode::default();
    let store = BoardStore::in_memory(NETWORK).unwrap();
    let mut posts = Posts(0);
    let (parent, parent_tx) = posts.post(None, "parent");
    let (early, early_tx) = posts.post(Some(&parent), "published first");
    let (under, under_tx) = posts.post(Some(&early), "under the early reply");
    node.push(1, vec![early_tx, under_tx]);
    synced(&node, &store);
    assert_eq!(thread_ids(&store), vec![(early.id, 2)]);
    assert!(
        store
            .read()
            .unwrap()
            .post(early.id)
            .unwrap()
            .unwrap()
            .missing_parent
    );

    node.push(2, vec![parent_tx]);
    synced(&node, &store);
    assert_eq!(thread_ids(&store), vec![(parent.id, 3)]);
    assert_eq!(reply_ids(&store, parent.id), vec![early.id, under.id]);
    let read = store.read().unwrap();
    let early_view = read.post(early.id).unwrap().unwrap();
    assert_eq!(
        (early_view.thread, early_view.missing_parent),
        (parent.id, false)
    );
    assert_eq!(read.post(under.id).unwrap().unwrap().thread, parent.id);
}

#[test]
fn a_reorg_rewinds_to_a_canonical_checkpoint() {
    let node = FakeNode::default();
    let store = BoardStore::in_memory(NETWORK).unwrap();
    let mut posts = Posts(0);
    let (root, root_tx) = posts.post(None, "root");
    let (parent, parent_tx) = posts.post(None, "replaced parent");
    let (orphaned, orphaned_tx) = posts.post(Some(&parent), "reply that survives");
    node.push(1, vec![root_tx]);
    node.push(2, vec![orphaned_tx.clone()]);
    let kept = synced(&node, &store);
    node.push(3, vec![parent_tx]);
    synced(&node, &store);
    assert_eq!(thread_ids(&store), vec![(parent.id, 2), (root.id, 1)]);

    node.reorg(2);
    let (replacement, replacement_tx) = posts.post(Some(&root), "on the new branch");
    node.push(4, vec![replacement_tx]);
    assert_eq!(
        sync(&node, &store).unwrap(),
        SyncOutcome::Rewound(Some(kept))
    );
    // The surviving reply leads its own thread again until its parent returns.
    assert_eq!(thread_ids(&store), vec![(orphaned.id, 1), (root.id, 1)]);
    synced(&node, &store);
    assert_eq!(thread_ids(&store), vec![(root.id, 2), (orphaned.id, 1)]);
    assert_eq!(reply_ids(&store, root.id), vec![replacement.id]);
    let read = store.read().unwrap();
    assert!(read.post(parent.id).unwrap().is_none());
    assert!(read.post(orphaned.id).unwrap().unwrap().missing_parent);

    // Without a canonical checkpoint the board rebuilds from the first output.
    node.reorg(0);
    node.push(5, vec![orphaned_tx]);
    assert_eq!(sync(&node, &store).unwrap(), SyncOutcome::Rewound(None));
    assert_eq!(store.read().unwrap().post_count().unwrap(), 0);
    synced(&node, &store);
    assert_eq!(thread_ids(&store), vec![(orphaned.id, 1)]);
}

#[test]
fn the_index_belongs_to_one_chain() {
    let store = BoardStore::in_memory(NETWORK).unwrap();
    let node = FakeNode {
        network: Some(BoardNetwork {
            chain_id: 8,
            ..NETWORK
        }),
        ..FakeNode::default()
    };
    node.push(1, Vec::new());
    assert!(matches!(
        sync(&node, &store),
        Err(crate::SyncError::WrongNetwork { chain_id: 8, .. })
    ));
    let directory = std::env::temp_dir().join(format!("pboard-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("board.redb");
    drop(BoardStore::open(&path, NETWORK).unwrap());
    let other = BoardNetwork {
        chain_id: 8,
        ..NETWORK
    };
    assert!(matches!(
        BoardStore::open(&path, other),
        Err(crate::StoreError::WrongNetwork)
    ));
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn the_rpc_serves_threads_and_posts() {
    let node = FakeNode::default();
    let store = Arc::new(BoardStore::in_memory(NETWORK).unwrap());
    let mut posts = Posts(0);
    let (root, root_tx) = posts.post(None, "hello");
    let (reply, reply_tx) = posts.post(Some(&root), "hi");
    node.push(1, vec![root_tx, reply_tx]);
    synced(&node, &store);
    let module = crate::api::build_module(Arc::clone(&store));

    let status: serde_json::Value = module.call("pboard_status", [(); 0]).await.unwrap();
    assert_eq!(status["postCount"], "0x2");
    assert_eq!(status["cursor"]["nextOutputIndex"], "0x6");
    let threads: serde_json::Value = module
        .call("pboard_getThreads", [serde_json::json!({ "board": BOARD })])
        .await
        .unwrap();
    assert_eq!(threads["items"][0]["root"]["text"], "hello");
    assert_eq!(threads["items"][0]["postCount"], "0x2");
    assert_eq!(threads["nextCursor"], serde_json::Value::Null);
    let thread: serde_json::Value = module
        .call("pboard_getThread", [serde_json::json!({ "id": reply.id })])
        .await
        .unwrap();
    assert_eq!(thread["thread"]["root"]["id"], serde_json::json!(root.id));
    assert_eq!(
        thread["replies"]["items"][0]["parent"],
        serde_json::json!(root.id)
    );
    assert_eq!(
        thread["replies"]["items"][0]["threadId"],
        serde_json::json!(root.id)
    );
    let missing: serde_json::Value = module.call("pboard_getPost", [B256::ZERO]).await.unwrap();
    assert!(missing.is_null());
    let refused = module
        .call::<_, serde_json::Value>(
            "pboard_getPosts",
            [serde_json::json!({ "board": BOARD, "limit": "0x0" })],
        )
        .await;
    assert!(refused.is_err());
}
