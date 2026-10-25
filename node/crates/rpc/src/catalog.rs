//! Transport-independent types for the optional generic publication catalog.
//!
//! The catalog is a node-local publication cache. It is not consensus state,
//! derived state, a protocol registry, or a trust source: nothing here reaches a
//! block, a state root, chain identity, derivation, fork selection, mempool
//! admission, or P2P gossip.
//!
//! The node stores opaque payload bytes. It validates record framing, chain id,
//! content ID, configured namespace, and resource limits, and nothing else —
//! application semantics belong to the client that published them.
//!
//! Records are append-only. There is no update, no delete, and no expiry: a
//! record's presence carries no information about whether the thing it describes
//! is still live, and applications must not infer one from the other.

use alloy_primitives::{keccak256, Bytes, B256};

use crate::wire;

/// Domain separator for the [`catalog_content_id`] preimage.
pub const CATALOG_ARTIFACT_DOMAIN: &[u8] = b"PCASH_CATALOG_ARTIFACT";

/// Marketplace offer publications.
pub const MARKETPLACE_NAMESPACE: &str = "pcash.marketplace.offer.v1";
/// Token eligibility-drop publications.
pub const TOKENS_DROP_NAMESPACE: &str = "pcash.tokens.drop.v1";
/// The namespaces enabled by `--enable-catalog` when no explicit policy is given.
pub const DEFAULT_CATALOG_NAMESPACES: [&str; 2] = [MARKETPLACE_NAMESPACE, TOKENS_DROP_NAMESPACE];

/// Longest legal namespace, in UTF-8 bytes.
pub const MAX_NAMESPACE_BYTES: usize = 64;

/// Per-record payload ceiling.
pub const MAX_CATALOG_PAYLOAD_BYTES: usize = 256 * 1024;
/// Maximum number of records the store holds.
///
/// Nothing expires, so this is a hard ceiling rather than a steady-state bound:
/// a full store rejects new records until an operator raises the limit or
/// removes the database, which is safe because the catalog is expendable.
pub const MAX_CATALOG_RECORDS: usize = 5_000;
/// Maximum aggregate stored payload bytes.
pub const MAX_CATALOG_AGGREGATE_PAYLOAD_BYTES: usize = 10 * 1024 * 1024;
/// Page size used when a list request does not ask for one.
pub const DEFAULT_CATALOG_PAGE_ITEMS: usize = 200;
/// Largest page size a list request may ask for.
pub const MAX_CATALOG_PAGE_ITEMS: usize = 500;
/// Aggregate raw payload bytes one page may carry. Above the per-record ceiling,
/// so any single record always fits in a page by itself.
pub const MAX_CATALOG_PAGE_PAYLOAD_BYTES: usize = 1024 * 1024;

/// The advertised resource policy, reported verbatim by `pcash_catalogInfo`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogLimits {
    #[serde(with = "wire::quantity_usize")]
    pub max_payload_bytes: usize,
    #[serde(with = "wire::quantity_usize")]
    pub max_records: usize,
    #[serde(with = "wire::quantity_usize")]
    pub max_aggregate_payload_bytes: usize,
    #[serde(with = "wire::quantity_usize")]
    pub default_page_items: usize,
    #[serde(with = "wire::quantity_usize")]
    pub max_page_items: usize,
    #[serde(with = "wire::quantity_usize")]
    pub max_page_payload_bytes: usize,
}

impl Default for CatalogLimits {
    fn default() -> Self {
        Self {
            max_payload_bytes: MAX_CATALOG_PAYLOAD_BYTES,
            max_records: MAX_CATALOG_RECORDS,
            max_aggregate_payload_bytes: MAX_CATALOG_AGGREGATE_PAYLOAD_BYTES,
            default_page_items: DEFAULT_CATALOG_PAGE_ITEMS,
            max_page_items: MAX_CATALOG_PAGE_ITEMS,
            max_page_payload_bytes: MAX_CATALOG_PAGE_PAYLOAD_BYTES,
        }
    }
}

/// Whether a namespace is syntactically legal: 1..=64 bytes of
/// `[a-z0-9][a-z0-9._-]{0,63}`.
///
/// A namespace that is merely not lowercase is rejected rather than normalized,
/// so one stored namespace always has exactly one spelling.
pub fn namespace_is_valid(namespace: &str) -> bool {
    let bytes = namespace.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_NAMESPACE_BYTES {
        return false;
    }
    if !matches!(bytes[0], b'a'..=b'z' | b'0'..=b'9') {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
}

/// The exact [`CatalogArtifact`] content-ID preimage.
///
/// ```text
/// ASCII("PCASH_CATALOG_ARTIFACT")
/// || u32_be(pcashChainId)
/// || u16_be(namespace_utf8_length)
/// || namespace_utf8
/// || u32_be(payload_length)
/// || payload
/// ```
///
/// Every variable-length part carries its length first, so the concatenation
/// parses exactly one way: without the namespace length prefix, namespace `a`
/// with payload `.bx` and namespace `a.b` with payload `x` would frame
/// identically.
///
/// Server-assigned fields are deliberately excluded, so republishing identical
/// content is the same record rather than a duplicate. Cross-language known
/// answers live in `vectors/catalog_artifact.json`.
pub fn catalog_content_id_preimage(
    namespace: &str,
    pcash_chain_id: u32,
    payload: &[u8],
) -> Vec<u8> {
    let namespace = namespace.as_bytes();
    let mut out = Vec::with_capacity(
        CATALOG_ARTIFACT_DOMAIN.len() + 4 + 2 + namespace.len() + 4 + payload.len(),
    );
    out.extend_from_slice(CATALOG_ARTIFACT_DOMAIN);
    out.extend_from_slice(&pcash_chain_id.to_be_bytes());
    out.extend_from_slice(&(namespace.len() as u16).to_be_bytes());
    out.extend_from_slice(namespace);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Keccak-256 of [`catalog_content_id_preimage`].
///
/// Callers must have already bounded `namespace` to 64 bytes and `payload` to
/// [`MAX_CATALOG_PAYLOAD_BYTES`], so neither length prefix can truncate.
pub fn catalog_content_id(namespace: &str, pcash_chain_id: u32, payload: &[u8]) -> B256 {
    keccak256(catalog_content_id_preimage(
        namespace,
        pcash_chain_id,
        payload,
    ))
}

/// One published artifact: everything the publisher supplies.
///
/// `content_id` is redundant with the other fields by construction and is always
/// re-derived before storage.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogArtifact {
    pub namespace: String,
    #[serde(with = "alloy_serde::quantity")]
    pub pcash_chain_id: u32,
    pub content_id: B256,
    pub payload: Bytes,
}

impl CatalogArtifact {
    /// Build an artifact and commit its content ID.
    pub fn new(namespace: String, pcash_chain_id: u32, payload: Vec<u8>) -> Self {
        let content_id = catalog_content_id(&namespace, pcash_chain_id, &payload);
        Self {
            namespace,
            pcash_chain_id,
            content_id,
            payload: Bytes::from(payload),
        }
    }
}

/// A stored artifact plus the fields the node assigns.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRecord {
    /// Flattened: clients never unwrap a nested `artifact` object.
    #[serde(flatten)]
    pub artifact: CatalogArtifact,
    /// Unix seconds when this content was first stored. Never changes:
    /// republishing identical content is a no-op, so this always means "when
    /// this first appeared" and cannot be refreshed.
    #[serde(with = "alloy_serde::quantity")]
    pub created_at: u64,
}

/// Whether the optional service is off, healthy, or broken.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CatalogStatus {
    /// The operator did not pass `--enable-catalog`.
    Disabled,
    /// Enabled and serving.
    Available,
    /// Enabled but the database could not be opened, or a storage failure has
    /// since been observed.
    Unavailable,
}

/// `pcash_catalogInfo` response.
///
/// Chain identity here is the PCASH chain id only. `pcash_status` is the one
/// place that reports full chain identity; the catalog does not duplicate it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(into = "CatalogInfoWire", from = "CatalogInfoWire")]
pub struct CatalogInfo {
    pub status: CatalogStatus,
    pub pcash_chain_id: u32,
    /// When disabled, the policy that would apply once enabled.
    pub namespaces: Vec<String>,
    pub limits: CatalogLimits,
}

impl CatalogInfo {
    pub fn disabled(pcash_chain_id: u32) -> Self {
        Self {
            status: CatalogStatus::Disabled,
            pcash_chain_id,
            namespaces: vec![MARKETPLACE_NAMESPACE.to_owned()],
            limits: CatalogLimits::default(),
        }
    }
}

/// `pcash_catalogInfo` on the wire. `writable` is a restatement of `status`, so
/// it is derived here rather than stored: one field cannot contradict the other.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogInfoWire {
    pub status: CatalogStatus,
    pub writable: bool,
    #[serde(with = "alloy_serde::quantity")]
    pub pcash_chain_id: u32,
    pub namespaces: Vec<String>,
    pub limits: CatalogLimits,
}

impl From<CatalogInfo> for CatalogInfoWire {
    fn from(info: CatalogInfo) -> Self {
        Self {
            status: info.status,
            writable: info.status == CatalogStatus::Available,
            pcash_chain_id: info.pcash_chain_id,
            namespaces: info.namespaces,
            limits: info.limits,
        }
    }
}

impl From<CatalogInfoWire> for CatalogInfo {
    fn from(wire: CatalogInfoWire) -> Self {
        Self {
            status: wire.status,
            pcash_chain_id: wire.pcash_chain_id,
            namespaces: wire.namespaces,
            limits: wire.limits,
        }
    }
}

/// A validated `pcash_catalogList` request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogListRequest {
    pub namespace: String,
    /// Exclusive lower bound. It need not exist, so a caller may page from any
    /// content ID.
    pub cursor: Option<B256>,
    pub limit: usize,
}

/// A validated `pcash_catalogGet` request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogGetRequest {
    pub namespace: String,
    pub content_id: B256,
}

/// One page of records.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPage {
    pub items: Vec<CatalogRecord>,
    /// The last returned content ID when another record remains.
    pub next_cursor: Option<B256>,
}

/// Catalog failures. These map onto a dedicated error-code range so a catalog
/// problem is never confused with an ordinary RPC failure.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CatalogApiError {
    #[error("catalog unavailable")]
    Unavailable,
    #[error("invalid catalog request: {0}")]
    Invalid(String),
    #[error("catalog resources exhausted: {0}")]
    Exhausted(String),
    #[error("catalog storage failure: {0}")]
    Storage(String),
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

    /// The wire form of a response type, as the server sends it.
    fn wire<T: serde::Serialize>(value: &T) -> Value {
        serde_json::to_value(value).expect("catalog types serialize")
    }

    fn hex32(value: impl AsRef<[u8]>) -> String {
        format!("0x{}", hex::encode(value))
    }

    fn hex_bytes(value: &[u8]) -> String {
        format!("0x{}", hex::encode(value))
    }
    use serde_json::Value;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct VectorFile {
        preimage_example: PreimageExample,
        cases: Vec<VectorCase>,
    }

    #[derive(serde::Deserialize)]
    struct PreimageExample {
        #[serde(rename = "case")]
        case_name: String,
        preimage: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct VectorCase {
        name: String,
        namespace: String,
        pcash_chain_id: u32,
        payload: String,
        content_id: String,
    }

    fn bytes(value: &str) -> Vec<u8> {
        hex::decode(value.strip_prefix("0x").expect("0x-prefixed")).expect("hex")
    }

    fn vectors() -> VectorFile {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../vectors/catalog_artifact.json"
        )))
        .expect("catalog vectors parse")
    }

    #[test]
    fn matches_the_cross_language_content_id_vectors() {
        let file = vectors();
        assert!(file.cases.len() >= 8, "vector coverage shrank");
        for case in &file.cases {
            let computed =
                catalog_content_id(&case.namespace, case.pcash_chain_id, &bytes(&case.payload));
            assert_eq!(
                hex32(computed),
                case.content_id,
                "content ID mismatch for vector {}",
                case.name
            );
        }
    }

    #[test]
    fn matches_the_expanded_preimage_vector() {
        let file = vectors();
        let case = file
            .cases
            .iter()
            .find(|case| case.name == file.preimage_example.case_name)
            .expect("preimage example names a real case");
        let preimage = catalog_content_id_preimage(
            &case.namespace,
            case.pcash_chain_id,
            &bytes(&case.payload),
        );
        assert_eq!(hex_bytes(&preimage), file.preimage_example.preimage);
    }

    #[test]
    fn one_byte_mutations_change_the_content_id() {
        let file = vectors();
        let ids: Vec<&str> = file
            .cases
            .iter()
            .map(|case| case.content_id.as_str())
            .collect();
        let unique: std::collections::BTreeSet<&str> = ids.iter().copied().collect();
        assert_eq!(
            unique.len(),
            ids.len(),
            "vectors must have distinct content IDs"
        );
    }

    #[test]
    fn a_namespace_length_prefix_separates_prefix_siblings() {
        // Without the u16 length prefix, ("a", ".bpayload") and ("a.b", "payload")
        // would frame identically. They must not.
        assert_ne!(
            catalog_content_id("a", 1, b".bpayload"),
            catalog_content_id("a.b", 1, b"payload"),
        );
    }

    #[test]
    fn accepts_and_rejects_namespaces_by_syntax() {
        assert!(namespace_is_valid(MARKETPLACE_NAMESPACE));
        assert!(namespace_is_valid("a"));
        assert!(namespace_is_valid("0"));
        assert!(namespace_is_valid("a.b_c-d.1"));
        assert!(namespace_is_valid(&"a".repeat(MAX_NAMESPACE_BYTES)));

        assert!(!namespace_is_valid(""));
        assert!(!namespace_is_valid(&"a".repeat(MAX_NAMESPACE_BYTES + 1)));
        assert!(!namespace_is_valid(".leading"));
        assert!(!namespace_is_valid("-leading"));
        assert!(!namespace_is_valid("_leading"));
        assert!(!namespace_is_valid("Upper"));
        assert!(!namespace_is_valid("has space"));
        assert!(!namespace_is_valid("has/slash"));
        assert!(!namespace_is_valid("nul\0byte"));
        assert!(!namespace_is_valid("émoji"));
    }

    #[test]
    fn an_artifact_commits_its_own_content_id() {
        let artifact =
            CatalogArtifact::new(MARKETPLACE_NAMESPACE.to_owned(), 1, b"payload".to_vec());
        assert_eq!(
            artifact.content_id,
            catalog_content_id(MARKETPLACE_NAMESPACE, 1, b"payload")
        );
    }

    #[test]
    fn a_record_encodes_flat_with_repository_conventions() {
        let record = CatalogRecord {
            artifact: CatalogArtifact::new(MARKETPLACE_NAMESPACE.to_owned(), 1, vec![0x01, 0x02]),
            created_at: 0x1234,
        };
        let expected_content_id = hex32(catalog_content_id(MARKETPLACE_NAMESPACE, 1, &[1, 2]));
        assert_eq!(
            wire(&record),
            serde_json::json!({
                "namespace": MARKETPLACE_NAMESPACE,
                "pcashChainId": "0x1",
                "contentId": expected_content_id,
                "payload": "0x0102",
                "createdAt": "0x1234",
            })
        );
    }

    #[test]
    fn info_reports_writability_from_status_and_advertises_limits() {
        let info = CatalogInfo {
            status: CatalogStatus::Disabled,
            pcash_chain_id: 1,
            namespaces: vec![MARKETPLACE_NAMESPACE.to_owned()],
            limits: CatalogLimits::default(),
        };
        let disabled = wire(&info);
        assert_eq!(disabled["status"], "disabled");
        assert_eq!(disabled["writable"], Value::Bool(false));
        // Even while disabled the node reports the policy that would apply.
        assert_eq!(
            disabled["namespaces"],
            serde_json::json!([MARKETPLACE_NAMESPACE])
        );
        assert_eq!(disabled["limits"]["maxPayloadBytes"], "0x40000");
        assert_eq!(disabled["limits"]["maxRecords"], "0x1388");
        assert_eq!(disabled["limits"]["maxAggregatePayloadBytes"], "0xa00000");
        // Full chain identity lives on pcash_status, not here.
        assert!(disabled.get("genesisHash").is_none());

        let available = wire(&CatalogInfo {
            status: CatalogStatus::Available,
            ..info.clone()
        });
        assert_eq!(available["writable"], Value::Bool(true));

        let unavailable = wire(&CatalogInfo {
            status: CatalogStatus::Unavailable,
            ..info
        });
        assert_eq!(unavailable["writable"], Value::Bool(false));
    }

    #[test]
    fn a_page_encodes_a_null_cursor_when_exhausted() {
        let page = CatalogPage {
            items: Vec::new(),
            next_cursor: None,
        };
        assert_eq!(wire(&page)["nextCursor"], Value::Null);
        let more = CatalogPage {
            items: Vec::new(),
            next_cursor: Some(B256::repeat_byte(0x11)),
        };
        assert_eq!(wire(&more)["nextCursor"], format!("0x{}", "11".repeat(32)));
    }

    #[test]
    fn a_full_store_is_readable_within_the_advertised_page_bounds() {
        let limits = CatalogLimits::default();
        // A single record always fits one page.
        assert!(limits.max_payload_bytes <= limits.max_page_payload_bytes);
        assert!(limits.default_page_items <= limits.max_page_items);
        // Nothing expires, so a client must be able to page a completely full
        // store without hitting an unreasonable page count.
        let pages = limits.max_records.div_ceil(limits.default_page_items);
        assert!(
            pages <= 32,
            "a full store needs {pages} pages at the default size"
        );
    }
}
