//! The board index: every board post at its first canonical inclusion, the
//! threads they form, and the cursor of the output feed they were read from.
//!
//! A post's thread is the root its parent chain reaches among indexed posts
//! of the same board. A reply indexed before its parent starts its own thread
//! until the parent arrives, when the reply's whole thread joins the parent's.
//!
//! Keys are big-endian, so a range read returns chain order:
//!
//! - post: `outputIndex(8)`, where the post's transaction's first output sits
//! - board feed, thread posts, children: `id(32) ‖ outputIndex(8)`
//! - thread activity: `board(32) ‖ latestOutputIndex(8)`
//! - checkpoint: `pcashBlockNumber(8)`

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "board rows are written only by this store, together with every row naming them"
)]

use std::path::Path;

use alloy_primitives::B256;
use pcash_state::codec::codec_struct;
use pcash_state::Codec;
use redb::{
    Database, Durability, ReadTransaction, ReadableDatabase, ReadableTable, ReadableTableMetadata,
    Table, TableDefinition, WriteTransaction,
};

use crate::post::{BoardNetwork, Post};

type Bytes = &'static [u8];

const T_META: TableDefinition<&str, Bytes> = TableDefinition::new("meta");
const T_POSTS: TableDefinition<Bytes, Bytes> = TableDefinition::new("posts");
const T_POST_IDS: TableDefinition<Bytes, Bytes> = TableDefinition::new("post_ids");
const T_CHILDREN: TableDefinition<Bytes, ()> = TableDefinition::new("children");
const T_BOARD_POSTS: TableDefinition<Bytes, ()> = TableDefinition::new("board_posts");
const T_THREAD_POSTS: TableDefinition<Bytes, ()> = TableDefinition::new("thread_posts");
const T_THREADS: TableDefinition<Bytes, Bytes> = TableDefinition::new("threads");
const T_THREAD_ACTIVITY: TableDefinition<Bytes, Bytes> = TableDefinition::new("thread_activity");
const T_CHECKPOINTS: TableDefinition<Bytes, Bytes> = TableDefinition::new("checkpoints");

const M_NETWORK: &str = "network";
const M_CURSOR: &str = "cursor";

/// Synced cursors kept for finding where a reorg left the canonical chain.
/// A reorg deeper than this rebuilds the board from the first output.
pub const CHECKPOINTS: usize = 256;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("board index storage: {0}")]
    Storage(String),
    #[error("board index belongs to another chain")]
    WrongNetwork,
}

fn storage(error: impl std::fmt::Display) -> StoreError {
    StoreError::Storage(error.to_string())
}

fn decode<T: Codec>(bytes: &[u8]) -> T {
    T::decode(bytes).expect("board rows are written by this store")
}

/// Where the next sync starts: the output count at the end of `block`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cursor {
    pub block_number: u64,
    pub block_hash: B256,
    pub next_output_index: u64,
}

codec_struct!(Cursor {
    block_number,
    block_hash,
    next_output_index
});

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Checkpoint {
    block_hash: B256,
    next_output_index: u64,
}

codec_struct!(Checkpoint {
    block_hash,
    next_output_index
});

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NetworkRow {
    chain_id: u32,
    genesis_hash: B256,
}

codec_struct!(NetworkRow {
    chain_id,
    genesis_hash
});

/// A post and where the chain first included it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexedPost {
    pub post: Post,
    pub output_index: u64,
    pub block_number: u64,
    pub block_hash: B256,
    /// Block timestamp, in seconds.
    pub timestamp: u64,
    pub transaction_id: B256,
    pub content_hash: B256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PostRow {
    id: B256,
    board: B256,
    parent: Option<B256>,
    nonce: B256,
    text: Vec<u8>,
    output_index: u64,
    block_number: u64,
    block_hash: B256,
    timestamp: u64,
    transaction_id: B256,
    content_hash: B256,
    thread: B256,
}

codec_struct!(PostRow {
    id,
    board,
    parent,
    nonce,
    text,
    output_index,
    block_number,
    block_hash,
    timestamp,
    transaction_id,
    content_hash,
    thread
});

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ThreadRow {
    board: B256,
    post_count: u64,
    latest_output_index: u64,
    latest_timestamp: u64,
}

codec_struct!(ThreadRow {
    board,
    post_count,
    latest_output_index,
    latest_timestamp
});

/// One indexed post as readers see it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PostView {
    pub post: IndexedPost,
    /// The root post of the thread this post belongs to.
    pub thread: B256,
    /// The post names a parent that is not on its board.
    pub missing_parent: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadView {
    pub root: PostView,
    /// The root and every reply.
    pub post_count: u64,
    pub latest_output_index: u64,
    pub latest_timestamp: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page<T> {
    pub items: Vec<T>,
    /// The output index to continue from, when more items remain.
    pub next: Option<u64>,
}

fn id_key(id: B256, output_index: u64) -> [u8; 40] {
    let mut key = [0u8; 40];
    key[..32].copy_from_slice(id.as_slice());
    key[32..].copy_from_slice(&output_index.to_be_bytes());
    key
}

fn key_index(key: &[u8]) -> u64 {
    u64::from_be_bytes(key[key.len() - 8..].try_into().unwrap())
}

impl PostRow {
    fn new(post: &IndexedPost, thread: B256) -> Self {
        Self {
            id: post.post.id,
            board: post.post.board,
            parent: post.post.parent,
            nonce: post.post.nonce,
            text: post.post.text.as_bytes().to_vec(),
            output_index: post.output_index,
            block_number: post.block_number,
            block_hash: post.block_hash,
            timestamp: post.timestamp,
            transaction_id: post.transaction_id,
            content_hash: post.content_hash,
            thread,
        }
    }

    fn indexed(self) -> IndexedPost {
        IndexedPost {
            post: Post {
                id: self.id,
                board: self.board,
                parent: self.parent,
                nonce: self.nonce,
                text: String::from_utf8(self.text).expect("post text is decoded UTF-8"),
            },
            output_index: self.output_index,
            block_number: self.block_number,
            block_hash: self.block_hash,
            timestamp: self.timestamp,
            transaction_id: self.transaction_id,
            content_hash: self.content_hash,
        }
    }
}

/// The tables one write transaction changes.
struct Tables<'t> {
    posts: Table<'t, Bytes, Bytes>,
    post_ids: Table<'t, Bytes, Bytes>,
    children: Table<'t, Bytes, ()>,
    board_posts: Table<'t, Bytes, ()>,
    thread_posts: Table<'t, Bytes, ()>,
    threads: Table<'t, Bytes, Bytes>,
    thread_activity: Table<'t, Bytes, Bytes>,
}

impl<'t> Tables<'t> {
    fn open(write: &'t WriteTransaction) -> Result<Self, StoreError> {
        Ok(Self {
            posts: write.open_table(T_POSTS).map_err(storage)?,
            post_ids: write.open_table(T_POST_IDS).map_err(storage)?,
            children: write.open_table(T_CHILDREN).map_err(storage)?,
            board_posts: write.open_table(T_BOARD_POSTS).map_err(storage)?,
            thread_posts: write.open_table(T_THREAD_POSTS).map_err(storage)?,
            threads: write.open_table(T_THREADS).map_err(storage)?,
            thread_activity: write.open_table(T_THREAD_ACTIVITY).map_err(storage)?,
        })
    }

    fn row_of(&self, id: B256) -> Result<Option<PostRow>, StoreError> {
        let Some(index) = self.post_ids.get(id.as_slice()).map_err(storage)? else {
            return Ok(None);
        };
        let row = self
            .posts
            .get(index.value())
            .map_err(storage)?
            .expect("every post id names a post");
        Ok(Some(decode(row.value())))
    }

    fn set_thread(&mut self, root: B256, thread: Option<ThreadRow>) -> Result<(), StoreError> {
        if let Some(old) = self.threads.remove(root.as_slice()).map_err(storage)? {
            let old: ThreadRow = decode(old.value());
            self.thread_activity
                .remove(id_key(old.board, old.latest_output_index).as_slice())
                .map_err(storage)?;
        }
        if let Some(thread) = thread {
            self.threads
                .insert(root.as_slice(), thread.encode().as_slice())
                .map_err(storage)?;
            self.thread_activity
                .insert(
                    id_key(thread.board, thread.latest_output_index).as_slice(),
                    root.as_slice(),
                )
                .map_err(storage)?;
        }
        Ok(())
    }

    /// Index one post newer than every post already here. A repeated
    /// identifier is the same post published again, listed at its first
    /// inclusion only.
    fn insert(&mut self, post: &IndexedPost) -> Result<(), StoreError> {
        let id = post.post.id;
        if self.post_ids.get(id.as_slice()).map_err(storage)?.is_some() {
            return Ok(());
        }
        let board = post.post.board;
        let index = post.output_index;
        let parent = match post.post.parent {
            Some(parent) => self.row_of(parent)?.filter(|row| row.board == board),
            None => None,
        };
        let root = parent.map_or(id, |parent| parent.thread);
        let mut thread = match self.threads.get(root.as_slice()).map_err(storage)? {
            Some(row) => decode(row.value()),
            None => ThreadRow {
                board,
                post_count: 0,
                latest_output_index: index,
                latest_timestamp: post.timestamp,
            },
        };
        thread.post_count += 1;
        thread.latest_output_index = index;
        thread.latest_timestamp = post.timestamp;

        // Replies that arrived before this post lead threads of their own,
        // which now join this post's thread.
        let orphans = self
            .children
            .range(id_key(id, 0).as_slice()..=id_key(id, u64::MAX).as_slice())
            .map_err(storage)?
            .map(|entry| entry.map(|(key, _)| key_index(key.value())))
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage)?;
        for child in orphans {
            let child: PostRow = decode(
                self.posts
                    .get(child.to_be_bytes().as_slice())
                    .map_err(storage)?
                    .expect("children name posts")
                    .value(),
            );
            if child.board != board {
                continue;
            }
            let orphan: ThreadRow = decode(
                self.threads
                    .get(child.id.as_slice())
                    .map_err(storage)?
                    .expect("a reply without its parent leads a thread")
                    .value(),
            );
            thread.post_count += orphan.post_count;
            self.set_thread(child.id, None)?;
            let members = self
                .thread_posts
                .range(id_key(child.id, 0).as_slice()..=id_key(child.id, u64::MAX).as_slice())
                .map_err(storage)?
                .map(|entry| entry.map(|(key, _)| key_index(key.value())))
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage)?;
            for member in members {
                let key = member.to_be_bytes();
                let mut row: PostRow = decode(
                    self.posts
                        .get(key.as_slice())
                        .map_err(storage)?
                        .expect("thread members are posts")
                        .value(),
                );
                row.thread = root;
                self.posts
                    .insert(key.as_slice(), row.encode().as_slice())
                    .map_err(storage)?;
                self.thread_posts
                    .remove(id_key(child.id, member).as_slice())
                    .map_err(storage)?;
                self.thread_posts
                    .insert(id_key(root, member).as_slice(), ())
                    .map_err(storage)?;
            }
        }

        self.posts
            .insert(
                index.to_be_bytes().as_slice(),
                PostRow::new(post, root).encode().as_slice(),
            )
            .map_err(storage)?;
        self.post_ids
            .insert(id.as_slice(), index.to_be_bytes().as_slice())
            .map_err(storage)?;
        if let Some(parent) = post.post.parent {
            self.children
                .insert(id_key(parent, index).as_slice(), ())
                .map_err(storage)?;
        }
        self.board_posts
            .insert(id_key(board, index).as_slice(), ())
            .map_err(storage)?;
        self.thread_posts
            .insert(id_key(root, index).as_slice(), ())
            .map_err(storage)?;
        self.set_thread(root, Some(thread))
    }
}

/// The board index over its own `redb` file, separate from the node's stores.
pub struct BoardStore {
    db: Database,
    network: BoardNetwork,
}

impl BoardStore {
    /// Open or create the index at `path` for `network`. An index built for
    /// another chain is refused.
    pub fn open(path: impl AsRef<Path>, network: BoardNetwork) -> Result<Self, StoreError> {
        Self::with_database(Database::create(path).map_err(storage)?, network)
    }

    /// A fresh index in process memory.
    pub fn in_memory(network: BoardNetwork) -> Result<Self, StoreError> {
        let db = Database::builder()
            .create_with_backend(redb::backends::InMemoryBackend::new())
            .map_err(storage)?;
        Self::with_database(db, network)
    }

    fn with_database(db: Database, network: BoardNetwork) -> Result<Self, StoreError> {
        let mut write = db.begin_write().map_err(storage)?;
        write
            .set_durability(Durability::Immediate)
            .map_err(storage)?;
        {
            let mut meta = write.open_table(T_META).map_err(storage)?;
            let row = NetworkRow {
                chain_id: network.chain_id,
                genesis_hash: network.genesis_hash,
            };
            let stored = meta
                .get(M_NETWORK)
                .map_err(storage)?
                .map(|stored| decode::<NetworkRow>(stored.value()));
            match stored {
                Some(stored) if stored != row => return Err(StoreError::WrongNetwork),
                Some(_) => {}
                None => {
                    meta.insert(M_NETWORK, row.encode().as_slice())
                        .map_err(storage)?;
                }
            }
            drop(meta);
            Tables::open(&write)?;
            write.open_table(T_CHECKPOINTS).map_err(storage)?;
        }
        write.commit().map_err(storage)?;
        Ok(Self { db, network })
    }

    pub fn network(&self) -> BoardNetwork {
        self.network
    }

    pub fn cursor(&self) -> Result<Option<Cursor>, StoreError> {
        self.read()?.cursor()
    }

    /// Index `posts`, read from the feed up to `cursor`, in output order.
    pub fn apply(&self, posts: &[IndexedPost], cursor: Cursor) -> Result<(), StoreError> {
        let write = self.db.begin_write().map_err(storage)?;
        {
            let mut tables = Tables::open(&write)?;
            for post in posts {
                tables.insert(post)?;
            }
        }
        {
            let mut meta = write.open_table(T_META).map_err(storage)?;
            meta.insert(M_CURSOR, cursor.encode().as_slice())
                .map_err(storage)?;
            let mut checkpoints = write.open_table(T_CHECKPOINTS).map_err(storage)?;
            checkpoints
                .insert(
                    cursor.block_number.to_be_bytes().as_slice(),
                    Checkpoint {
                        block_hash: cursor.block_hash,
                        next_output_index: cursor.next_output_index,
                    }
                    .encode()
                    .as_slice(),
                )
                .map_err(storage)?;
            while checkpoints.len().map_err(storage)? > CHECKPOINTS as u64 {
                checkpoints.pop_first().map_err(storage)?;
            }
        }
        write.commit().map_err(storage)
    }

    /// Synced cursors, newest first.
    pub fn checkpoints(&self) -> Result<Vec<Cursor>, StoreError> {
        let read = self.db.begin_read().map_err(storage)?;
        let table = read.open_table(T_CHECKPOINTS).map_err(storage)?;
        table
            .iter()
            .map_err(storage)?
            .rev()
            .map(|entry| {
                let (key, value) = entry.map_err(storage)?;
                let checkpoint: Checkpoint = decode(value.value());
                Ok(Cursor {
                    block_number: key_index(key.value()),
                    block_hash: checkpoint.block_hash,
                    next_output_index: checkpoint.next_output_index,
                })
            })
            .collect()
    }

    /// Drop every post read after `cursor`, or every post without one, and
    /// rebuild the threads from the posts that remain.
    pub fn rewind(&self, cursor: Option<Cursor>) -> Result<(), StoreError> {
        let write = self.db.begin_write().map_err(storage)?;
        {
            let keep = cursor.map_or(0, |cursor| cursor.next_output_index);
            let tables = Tables::open(&write)?;
            let posts = tables
                .posts
                .range(..keep.to_be_bytes().as_slice())
                .map_err(storage)?
                .map(|entry| entry.map(|(_, value)| decode::<PostRow>(value.value()).indexed()))
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage)?;
            drop(tables);
            for table in [T_POSTS, T_POST_IDS, T_THREADS, T_THREAD_ACTIVITY] {
                write.delete_table(table).map_err(storage)?;
            }
            for table in [T_CHILDREN, T_BOARD_POSTS, T_THREAD_POSTS] {
                write.delete_table(table).map_err(storage)?;
            }
            let mut tables = Tables::open(&write)?;
            for post in &posts {
                tables.insert(post)?;
            }
            let mut meta = write.open_table(T_META).map_err(storage)?;
            let mut checkpoints = write.open_table(T_CHECKPOINTS).map_err(storage)?;
            if let Some(cursor) = cursor {
                meta.insert(M_CURSOR, cursor.encode().as_slice())
                    .map_err(storage)?;
            } else {
                meta.remove(M_CURSOR).map_err(storage)?;
            }
            let kept = cursor.map(|cursor| cursor.block_number);
            checkpoints
                .retain(|number, _| kept.is_some_and(|kept| key_index(number) <= kept))
                .map_err(storage)?;
        }
        write.commit().map_err(storage)
    }

    /// One committed view for every query in a response.
    pub fn read(&self) -> Result<BoardRead, StoreError> {
        Ok(BoardRead {
            read: self.db.begin_read().map_err(storage)?,
        })
    }
}

/// A committed snapshot of the board index.
pub struct BoardRead {
    read: ReadTransaction,
}

impl BoardRead {
    pub fn cursor(&self) -> Result<Option<Cursor>, StoreError> {
        let meta = self.read.open_table(T_META).map_err(storage)?;
        Ok(meta
            .get(M_CURSOR)
            .map_err(storage)?
            .map(|cursor| decode(cursor.value())))
    }

    pub fn post_count(&self) -> Result<u64, StoreError> {
        self.read
            .open_table(T_POST_IDS)
            .map_err(storage)?
            .len()
            .map_err(storage)
    }

    fn row_at(&self, output_index: u64) -> Result<PostRow, StoreError> {
        let posts = self.read.open_table(T_POSTS).map_err(storage)?;
        let row = posts
            .get(output_index.to_be_bytes().as_slice())
            .map_err(storage)?
            .expect("index keys name posts");
        Ok(decode(row.value()))
    }

    fn row_of(&self, id: B256) -> Result<Option<PostRow>, StoreError> {
        let ids = self.read.open_table(T_POST_IDS).map_err(storage)?;
        let Some(index) = ids.get(id.as_slice()).map_err(storage)? else {
            return Ok(None);
        };
        self.row_at(key_index(index.value())).map(Some)
    }

    fn view(&self, row: PostRow) -> Result<PostView, StoreError> {
        let missing_parent = match row.parent {
            Some(parent) => self
                .row_of(parent)?
                .is_none_or(|parent| parent.board != row.board),
            None => false,
        };
        Ok(PostView {
            thread: row.thread,
            missing_parent,
            post: row.indexed(),
        })
    }

    pub fn post(&self, id: B256) -> Result<Option<PostView>, StoreError> {
        self.row_of(id)?.map(|row| self.view(row)).transpose()
    }

    fn thread_view(&self, root: B256, thread: ThreadRow) -> Result<ThreadView, StoreError> {
        let root = self.row_of(root)?.expect("a thread's root is a post");
        Ok(ThreadView {
            root: self.view(root)?,
            post_count: thread.post_count,
            latest_output_index: thread.latest_output_index,
            latest_timestamp: thread.latest_timestamp,
        })
    }

    /// The thread `id` belongs to, whether `id` is its root or a reply.
    pub fn thread_of(&self, id: B256) -> Result<Option<ThreadView>, StoreError> {
        let Some(row) = self.row_of(id)? else {
            return Ok(None);
        };
        let threads = self.read.open_table(T_THREADS).map_err(storage)?;
        let thread = threads
            .get(row.thread.as_slice())
            .map_err(storage)?
            .expect("every post belongs to a thread");
        self.thread_view(row.thread, decode(thread.value()))
            .map(Some)
    }

    /// A board's threads, newest activity first, each with latest activity
    /// before `before`.
    pub fn threads(
        &self,
        board: B256,
        before: Option<u64>,
        limit: usize,
    ) -> Result<Page<ThreadView>, StoreError> {
        let activity = self.read.open_table(T_THREAD_ACTIVITY).map_err(storage)?;
        let threads = self.read.open_table(T_THREADS).map_err(storage)?;
        let end = id_key(board, before.unwrap_or(u64::MAX));
        let range = id_key(board, 0).as_slice().to_vec();
        let mut rows = activity
            .range(range.as_slice()..end.as_slice())
            .map_err(storage)?
            .rev();
        let mut items = Vec::new();
        for entry in rows.by_ref().take(limit) {
            let (_, root) = entry.map_err(storage)?;
            let root = B256::from_slice(root.value());
            let thread = threads
                .get(root.as_slice())
                .map_err(storage)?
                .expect("activity names threads");
            items.push(self.thread_view(root, decode(thread.value()))?);
        }
        let next = match rows.next() {
            Some(_) => items.last().map(|thread| thread.latest_output_index),
            None => None,
        };
        Ok(Page { items, next })
    }

    /// The posts of thread `root` other than the root, in chain order, after
    /// output index `after`.
    pub fn replies(
        &self,
        root: B256,
        after: Option<u64>,
        limit: usize,
    ) -> Result<Page<PostView>, StoreError> {
        self.posts_in(T_THREAD_POSTS, root, after, limit, Some(root), false)
    }

    /// A board's posts, newest first, before output index `before`.
    pub fn board_posts(
        &self,
        board: B256,
        before: Option<u64>,
        limit: usize,
    ) -> Result<Page<PostView>, StoreError> {
        self.posts_in(T_BOARD_POSTS, board, before, limit, None, true)
    }

    fn posts_in(
        &self,
        table: TableDefinition<Bytes, ()>,
        prefix: B256,
        from: Option<u64>,
        limit: usize,
        skip: Option<B256>,
        newest_first: bool,
    ) -> Result<Page<PostView>, StoreError> {
        let table = self.read.open_table(table).map_err(storage)?;
        let (start, end) = match (from, newest_first) {
            (from, true) => (id_key(prefix, 0), id_key(prefix, from.unwrap_or(u64::MAX))),
            (None, false) => (id_key(prefix, 0), id_key(prefix, u64::MAX)),
            (Some(after), false) => (
                id_key(prefix, after.saturating_add(1)),
                id_key(prefix, u64::MAX),
            ),
        };
        let range = table
            .range(start.as_slice()..end.as_slice())
            .map_err(storage)?;
        let mut keys: Box<dyn Iterator<Item = _>> = if newest_first {
            Box::new(range.rev())
        } else {
            Box::new(range)
        };
        let mut items = Vec::new();
        let mut last = None;
        for entry in keys.by_ref() {
            let (key, _) = entry.map_err(storage)?;
            let index = key_index(key.value());
            let row = self.row_at(index)?;
            if Some(row.id) == skip {
                continue;
            }
            if items.len() == limit {
                return Ok(Page { items, next: last });
            }
            last = Some(index);
            items.push(self.view(row)?);
        }
        Ok(Page { items, next: None })
    }
}
