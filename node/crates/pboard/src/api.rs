//! The `pboard_*` JSON-RPC namespace: paged reads of the board index.
//!
//! Each response reads one committed snapshot of the index. The index lags
//! the node; `pboard_status` reports the block it has reached.

use std::sync::Arc;

use alloy_primitives::B256;
use jsonrpsee::types::{ErrorObject, ErrorObjectOwned, Params};
use jsonrpsee::RpcModule;
use pcash_rpc::dto::BlockId;
use pcash_rpc::server::{register_read, BlockingReads};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::{BoardRead, BoardStore, Page, PostView, StoreError, ThreadView};

pub const DEFAULT_PAGE_ITEMS: u64 = 50;
pub const MAX_PAGE_ITEMS: u64 = 200;

const INVALID_PARAMS: i32 = -32602;
const BOARD_UNAVAILABLE: i32 = -32030;

fn invalid_params(message: impl Into<String>) -> ErrorObjectOwned {
    ErrorObject::owned(INVALID_PARAMS, message.into(), None::<()>)
}

fn unavailable(error: StoreError) -> ErrorObjectOwned {
    ErrorObject::owned(BOARD_UNAVAILABLE, error.to_string(), None::<()>)
}

fn encode<T: Serialize>(value: &T) -> Result<Value, ErrorObjectOwned> {
    serde_json::to_value(value).map_err(|error| {
        ErrorObject::owned(
            -32603,
            format!("response serialization failed: {error}"),
            None::<()>,
        )
    })
}

fn page_limit(limit: Option<u64>) -> Result<usize, ErrorObjectOwned> {
    let limit = limit.unwrap_or(DEFAULT_PAGE_ITEMS);
    if limit == 0 || limit > MAX_PAGE_ITEMS {
        return Err(invalid_params(format!(
            "limit must be between 1 and {MAX_PAGE_ITEMS}"
        )));
    }
    Ok(limit as usize)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardCursorDto {
    pub block: BlockId,
    #[serde(with = "alloy_serde::quantity")]
    pub next_output_index: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardStatusDto {
    /// The block the index has reached; null before its first sync.
    pub cursor: Option<BoardCursorDto>,
    #[serde(with = "alloy_serde::quantity")]
    pub post_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostDto {
    pub id: B256,
    pub board: B256,
    pub parent: Option<B256>,
    pub nonce: B256,
    pub text: String,
    /// The root post of the post's thread.
    pub thread_id: B256,
    /// The post replies to a post that is not on its board.
    pub missing_parent: bool,
    pub origin: BlockId,
    /// Block timestamp, in seconds.
    #[serde(with = "alloy_serde::quantity")]
    pub timestamp: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub output_index: u64,
    pub transaction_id: B256,
    pub content_hash: B256,
}

impl From<PostView> for PostDto {
    fn from(view: PostView) -> Self {
        let post = view.post;
        Self {
            id: post.post.id,
            board: post.post.board,
            parent: post.post.parent,
            nonce: post.post.nonce,
            text: post.post.text,
            thread_id: view.thread,
            missing_parent: view.missing_parent,
            origin: BlockId {
                block_number: post.block_number,
                block_hash: post.block_hash,
            },
            timestamp: post.timestamp,
            output_index: post.output_index,
            transaction_id: post.transaction_id,
            content_hash: post.content_hash,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDto {
    pub root: PostDto,
    /// The root and every reply.
    #[serde(with = "alloy_serde::quantity")]
    pub post_count: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub latest_output_index: u64,
    #[serde(with = "alloy_serde::quantity")]
    pub latest_timestamp: u64,
}

impl From<ThreadView> for ThreadDto {
    fn from(view: ThreadView) -> Self {
        Self {
            root: view.root.into(),
            post_count: view.post_count,
            latest_output_index: view.latest_output_index,
            latest_timestamp: view.latest_timestamp,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDto<T> {
    pub items: Vec<T>,
    /// Pass as the next request's `cursor`; null on the last page.
    #[serde(with = "alloy_serde::quantity::opt")]
    pub next_cursor: Option<u64>,
}

impl<T, U: Into<T>> From<Page<U>> for PageDto<T> {
    fn from(page: Page<U>) -> Self {
        Self {
            items: page.items.into_iter().map(Into::into).collect(),
            next_cursor: page.next,
        }
    }
}

/// One thread: its root and a page of its replies in chain order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPageDto {
    pub thread: ThreadDto,
    pub replies: PageDto<PostDto>,
}

/// `pboard_getThreads` and `pboard_getPosts`: one board, newest first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BoardQuery {
    pub board: B256,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub cursor: Option<u64>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub limit: Option<u64>,
}

/// `pboard_getThread`: the thread a post belongs to, root or reply, and its
/// replies after `cursor`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ThreadQuery {
    pub id: B256,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub cursor: Option<u64>,
    #[serde(
        default,
        with = "alloy_serde::quantity::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub limit: Option<u64>,
}

fn snapshot(store: &BoardStore) -> Result<BoardRead, ErrorObjectOwned> {
    store.read().map_err(unavailable)
}

fn one<T: for<'de> Deserialize<'de>>(params: Params) -> Result<T, ErrorObjectOwned> {
    params.one::<T>().map_err(|e| invalid_params(e.to_string()))
}

/// Build the `pboard_*` module over the board index.
#[allow(
    clippy::expect_used,
    reason = "the static pboard method names are registered exactly once"
)]
pub fn build_module(store: Arc<BoardStore>) -> RpcModule<Arc<BoardStore>> {
    let mut m = RpcModule::new(store);
    let reads = BlockingReads::default();
    register_read(&reads, &mut m, "pboard_status", |_, store, ()| {
        let read = snapshot(store)?;
        encode(&BoardStatusDto {
            cursor: read
                .cursor()
                .map_err(unavailable)?
                .map(|cursor| BoardCursorDto {
                    block: BlockId {
                        block_number: cursor.block_number,
                        block_hash: cursor.block_hash,
                    },
                    next_output_index: cursor.next_output_index,
                }),
            post_count: read.post_count().map_err(unavailable)?,
        })
    })
    .expect("register pboard_status");
    register_read(&reads, &mut m, "pboard_getThreads", |params, store, ()| {
        let query: BoardQuery = one(params)?;
        let limit = page_limit(query.limit)?;
        let page = snapshot(store)?
            .threads(query.board, query.cursor, limit)
            .map_err(unavailable)?;
        encode(&PageDto::<ThreadDto>::from(page))
    })
    .expect("register pboard_getThreads");
    register_read(&reads, &mut m, "pboard_getPosts", |params, store, ()| {
        let query: BoardQuery = one(params)?;
        let limit = page_limit(query.limit)?;
        let page = snapshot(store)?
            .board_posts(query.board, query.cursor, limit)
            .map_err(unavailable)?;
        encode(&PageDto::<PostDto>::from(page))
    })
    .expect("register pboard_getPosts");
    register_read(&reads, &mut m, "pboard_getThread", |params, store, ()| {
        let query: ThreadQuery = one(params)?;
        let limit = page_limit(query.limit)?;
        let read = snapshot(store)?;
        let Some(thread) = read.thread_of(query.id).map_err(unavailable)? else {
            return Ok(Value::Null);
        };
        let replies = read
            .replies(thread.root.post.post.id, query.cursor, limit)
            .map_err(unavailable)?;
        encode(&ThreadPageDto {
            thread: thread.into(),
            replies: replies.into(),
        })
    })
    .expect("register pboard_getThread");
    register_read(&reads, &mut m, "pboard_getPost", |params, store, ()| {
        let id: B256 = one(params)?;
        match snapshot(store)?.post(id).map_err(unavailable)? {
            Some(post) => encode(&PostDto::from(post)),
            None => Ok(Value::Null),
        }
    })
    .expect("register pboard_getPost");
    m
}
