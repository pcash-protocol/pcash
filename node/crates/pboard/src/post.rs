//! The board post record. It mirrors the browser codec in `web/board`: a
//! packed application record carried in a private-value arena's public
//! segment.
//!
//! ```text
//! data = bitmap (1) ‖ board (32) ‖ [parent (32)] ‖ nonce (32) ‖ text (UTF-8, to the end)
//! id   = keccak256("pcash.board.post\0" ‖ chainId (4) ‖ genesisHash (32) ‖ data)
//! ```
//!
//! The bitmap's top bit marks the parent and every other bit is zero. Records
//! arrive from L1, so a malformed or oversized post is not a post.

use alloy_primitives::{keccak256, B256};
use pcash_derive::public_records::PublicRecord;
use sha2::{Digest, Sha256};

pub const POST_SCHEMA_NAME: &str = "org.pcash.board.post";
/// Text bytes a post carries, at least one.
pub const MAX_TEXT_BYTES: usize = 1024;

const PARENT_BIT: u8 = 0x80;

/// The record's four-byte application id: the first four SHA-256 bytes of its
/// name with the top bit set.
pub fn post_schema() -> [u8; 4] {
    let digest = Sha256::digest(POST_SCHEMA_NAME.as_bytes());
    [digest[0] | 0x80, digest[1], digest[2], digest[3]]
}

/// The chain a post's identifier binds: the same record on another chain is
/// another post.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BoardNetwork {
    pub chain_id: u32,
    pub genesis_hash: B256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Post {
    pub id: B256,
    pub board: B256,
    pub parent: Option<B256>,
    pub nonce: B256,
    pub text: String,
}

/// The board post among untrusted public records, if one decodes.
pub fn decode_post(network: BoardNetwork, records: &[PublicRecord]) -> Option<Post> {
    let schema = post_schema();
    let data = &records.iter().find(|record| record.schema == schema)?.data;
    let (&bitmap, rest) = data.split_first()?;
    if bitmap & !PARENT_BIT != 0 {
        return None;
    }
    let word = |bytes: &[u8]| B256::from_slice(bytes);
    let board = word(rest.get(..32)?);
    let (parent, rest) = if bitmap & PARENT_BIT == 0 {
        (None, &rest[32..])
    } else {
        (Some(word(rest.get(32..64)?)), &rest[64..])
    };
    let nonce = word(rest.get(..32)?);
    let text = std::str::from_utf8(&rest[32..]).ok()?;
    if text.is_empty() || text.len() > MAX_TEXT_BYTES {
        return None;
    }
    let mut preimage = Vec::with_capacity(17 + 4 + 32 + data.len());
    preimage.extend_from_slice(b"pcash.board.post\0");
    preimage.extend_from_slice(&network.chain_id.to_be_bytes());
    preimage.extend_from_slice(network.genesis_hash.as_slice());
    preimage.extend_from_slice(data);
    Some(Post {
        id: keccak256(&preimage),
        board,
        parent,
        nonce,
        text: text.to_owned(),
    })
}

/// A post record's data, the inverse of [`decode_post`]. Tests build posts
/// with it.
pub fn encode_post_data(board: B256, parent: Option<B256>, nonce: B256, text: &str) -> Vec<u8> {
    let mut data = vec![if parent.is_some() { PARENT_BIT } else { 0 }];
    data.extend_from_slice(board.as_slice());
    if let Some(parent) = parent {
        data.extend_from_slice(parent.as_slice());
    }
    data.extend_from_slice(nonce.as_slice());
    data.extend_from_slice(text.as_bytes());
    data
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests use direct assertions")]
mod tests {
    use super::*;

    const NETWORK: BoardNetwork = BoardNetwork {
        chain_id: 7,
        genesis_hash: B256::repeat_byte(0x11),
    };

    fn record(data: Vec<u8>) -> Vec<PublicRecord> {
        vec![PublicRecord {
            schema: post_schema(),
            data,
        }]
    }

    #[test]
    fn schema_matches_the_browser_codec() {
        // applicationSchemaId("org.pcash.board.post") in the SDK.
        assert_eq!(post_schema(), [0xdc, 0xe9, 0xa2, 0x28]);
    }

    #[test]
    fn frozen_post_identifier() {
        // The browser codec's frozen vector in web/board/test/board.test.ts.
        let network = BoardNetwork {
            chain_id: 1,
            genesis_hash: B256::repeat_byte(0x11),
        };
        let board: B256 = "0x56706d86e8fd3368489abd4b5bb347102ba126afae50c82520b527205d8cc921"
            .parse()
            .unwrap();
        let data = encode_post_data(board, None, B256::repeat_byte(0x22), "Hello, PCASH! 🌏");
        let post = decode_post(network, &record(data)).unwrap();
        assert_eq!(
            post.id,
            "0x33db8ba0a749c8de6746eb67c67e9486501ba4637fc2d7d81ea5d372d03355b2"
                .parse::<B256>()
                .unwrap()
        );
    }

    #[test]
    fn decodes_posts_and_refuses_malformed_ones() {
        let board = B256::repeat_byte(1);
        let parent = B256::repeat_byte(2);
        let nonce = B256::repeat_byte(3);
        let reply = decode_post(
            NETWORK,
            &record(encode_post_data(board, Some(parent), nonce, "hi")),
        )
        .unwrap();
        assert_eq!(
            (reply.board, reply.parent, reply.nonce, reply.text.as_str()),
            (board, Some(parent), nonce, "hi")
        );
        let root = encode_post_data(board, None, nonce, "hi");
        assert_eq!(
            decode_post(NETWORK, &record(root.clone())).unwrap().parent,
            None
        );
        let other_chain = BoardNetwork {
            chain_id: 8,
            ..NETWORK
        };
        assert_ne!(
            decode_post(NETWORK, &record(root.clone())).unwrap().id,
            decode_post(other_chain, &record(root.clone())).unwrap().id
        );

        assert!(decode_post(NETWORK, &record(encode_post_data(board, None, nonce, ""))).is_none());
        let long = "x".repeat(MAX_TEXT_BYTES + 1);
        assert!(decode_post(
            NETWORK,
            &record(encode_post_data(board, None, nonce, &long))
        )
        .is_none());
        let mut unused_bit = root.clone();
        unused_bit[0] = 0x40;
        assert!(decode_post(NETWORK, &record(unused_bit)).is_none());
        let mut invalid_utf8 = root.clone();
        invalid_utf8.push(0xff);
        assert!(decode_post(NETWORK, &record(invalid_utf8)).is_none());
        assert!(decode_post(NETWORK, &record(root[..40].to_vec())).is_none());
        let other_schema = vec![PublicRecord {
            schema: [0x80, 0, 0, 0],
            data: root,
        }];
        assert!(decode_post(NETWORK, &other_schema).is_none());
    }
}
