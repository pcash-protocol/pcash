//! Direct Beacon API retrieval for EIP-4844 inbox carriers.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use alloy_eips::eip4844::{Blob, BYTES_PER_BLOB};
use alloy_primitives::{Bytes, B256};
use alloy_rpc_types_beacon::sidecar::GetBlobsResponse;
use pcash_da::{
    classify_inbox_carrier, decode_canonical_refs, versioned_hash, InboxEncoding, MAX_BATCH_BYTES,
};
use pcash_l1::{BlobResolution, L1BlockData, L1Header};
use serde::Deserialize;

#[derive(Debug, thiserror::Error)]
pub enum BlobError {
    #[error("beacon API: {0}")]
    Beacon(String),
    #[error("blob KZG computation failed: {0}")]
    Kzg(String),
    #[error("blob data unavailable for L1 transaction {transaction}: {missing:?}; {reason}")]
    Unavailable {
        transaction: B256,
        missing: Vec<B256>,
        reason: String,
    },
}

struct HashRequest {
    blob: Arc<Blob>,
    reply: tokio::sync::oneshot::Sender<Result<B256, String>>,
}

/// KZG's reference implementation needs more stack than Tokio's ordinary
/// worker threads provide in debug builds. Keep commitment work on one bounded
/// dedicated worker rather than enlarging every async task's stack.
#[derive(Clone)]
struct KzgHasher {
    requests: std::sync::mpsc::Sender<HashRequest>,
    #[cfg(test)]
    commitments: Arc<std::sync::atomic::AtomicUsize>,
}

impl KzgHasher {
    fn new() -> Result<Self, BlobError> {
        let (requests, receiver) = std::sync::mpsc::channel::<HashRequest>();
        std::thread::Builder::new()
            .name("pcash-blob-kzg".to_owned())
            .stack_size(8 * 1024 * 1024)
            .spawn(move || {
                while let Ok(request) = receiver.recv() {
                    let result = versioned_hash(&request.blob).map_err(|error| error.to_string());
                    let _ = request.reply.send(result);
                }
            })
            .map_err(|error| BlobError::Kzg(error.to_string()))?;
        Ok(Self {
            requests,
            #[cfg(test)]
            commitments: Arc::default(),
        })
    }

    async fn hash(&self, blob: Arc<Blob>) -> Result<B256, String> {
        #[cfg(test)]
        self.commitments
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (reply, response) = tokio::sync::oneshot::channel();
        self.requests
            .send(HashRequest { blob, reply })
            .map_err(|_| "KZG worker stopped".to_owned())?;
        response
            .await
            .map_err(|_| "KZG worker dropped its response".to_owned())?
    }
}

/// Required direct source for blobs referenced by structurally valid PCASH
/// inbox carriers. Retrieved bytes live only in the current L1 block value.
#[derive(Clone)]
pub struct BeaconClient {
    client: reqwest::Client,
    base: reqwest::Url,
    block_ids: BeaconBlockIds,
    kzg: KzgHasher,
}

#[derive(Clone)]
enum BeaconBlockIds {
    Slots {
        genesis_time: u64,
        seconds_per_slot: u64,
    },
    // Anvil's Beacon shim addresses execution blocks, including after clock jumps.
    Anvil,
}

#[derive(Deserialize)]
struct ApiResponse<T> {
    data: T,
}

#[derive(Deserialize)]
struct BeaconGenesis {
    genesis_time: String,
}

#[derive(Clone, Copy)]
enum BlobResponseEncoding {
    Ssz,
    Json,
}

const JSON_RESPONSE_HEADROOM: usize = 4 * 1024;
const JSON_BYTES_PER_BLOB: usize = BYTES_PER_BLOB * 2 + 5;

impl BeaconClient {
    /// Connect to a Beacon API and load the chain parameters needed to map an
    /// execution timestamp to a consensus slot.
    pub async fn connect(endpoint: &str) -> Result<Self, BlobError> {
        let base = reqwest::Url::parse(endpoint)
            .map_err(|_| BlobError::Beacon("invalid endpoint URL".to_owned()))?;
        if base.cannot_be_a_base() {
            return Err(BlobError::Beacon(
                "endpoint cannot be used as a URL base".to_owned(),
            ));
        }
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(beacon_transport)?;

        let genesis = client
            .get(beacon_url(&base, "eth/v1/beacon/genesis"))
            .send()
            .await
            .map_err(beacon_transport)?
            .error_for_status()
            .map_err(beacon_transport)?
            .json::<ApiResponse<BeaconGenesis>>()
            .await
            .map_err(beacon_transport)?;
        let genesis_time = genesis
            .data
            .genesis_time
            .parse::<u64>()
            .map_err(|_| BlobError::Beacon("genesis_time is not a uint64".to_owned()))?;

        let spec_response = client
            .get(beacon_url(&base, "eth/v1/config/spec"))
            .send()
            .await
            .map_err(beacon_transport)?;
        let block_ids = if spec_response.status() == reqwest::StatusCode::NOT_FOUND {
            identify_anvil(&client, &base, genesis_time).await?;
            BeaconBlockIds::Anvil
        } else {
            let spec = spec_response
                .error_for_status()
                .map_err(beacon_transport)?
                .json::<ApiResponse<BTreeMap<String, serde_json::Value>>>()
                .await
                .map_err(beacon_transport)?;
            let seconds_per_slot = spec
                .data
                .get("SECONDS_PER_SLOT")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| BlobError::Beacon("spec omits SECONDS_PER_SLOT".to_owned()))?
                .parse::<u64>()
                .map_err(|_| BlobError::Beacon("SECONDS_PER_SLOT is not a uint64".to_owned()))?;
            if seconds_per_slot == 0 {
                return Err(BlobError::Beacon(
                    "SECONDS_PER_SLOT must be positive".to_owned(),
                ));
            }
            BeaconBlockIds::Slots {
                genesis_time,
                seconds_per_slot,
            }
        };

        Ok(Self {
            client,
            base,
            block_ids,
            kzg: KzgHasher::new()?,
        })
    }

    /// A disconnected source for tests whose L1 fixtures contain no blob
    /// carriers. Blob-aware tests use a mock Beacon HTTP server instead.
    #[cfg(any(test, feature = "test-support"))]
    pub fn for_test() -> Self {
        Self {
            client: reqwest::Client::new(),
            base: reqwest::Url::parse("http://127.0.0.1:1/")
                .expect("fixed test Beacon URL is valid"),
            block_ids: BeaconBlockIds::Slots {
                genesis_time: 0,
                seconds_per_slot: 12,
            },
            kzg: KzgHasher::new().expect("test KZG worker starts"),
        }
    }

    fn block_id(&self, block: &L1Header) -> Result<u64, String> {
        let BeaconBlockIds::Slots {
            genesis_time,
            seconds_per_slot,
        } = self.block_ids
        else {
            return Ok(block.number);
        };
        let elapsed = block
            .timestamp
            .checked_sub(genesis_time)
            .ok_or_else(|| "execution timestamp precedes beacon genesis".to_owned())?;
        if elapsed % seconds_per_slot != 0 {
            return Err("execution timestamp is not aligned to a beacon slot".to_owned());
        }
        Ok(elapsed / seconds_per_slot)
    }

    /// Resolve every structurally valid Inbox blob carrier in place. A
    /// KZG-verified but noncanonical PCASH codec payload is deterministic invalid
    /// input; missing or mismatched sidecars are temporary availability errors.
    /// Carrier events hold their batch in log data and need no resolution.
    pub async fn resolve_block(
        &self,
        block: &mut L1BlockData,
        inbox: alloy_primitives::Address,
    ) -> Result<(), BlobError> {
        let header = block.header.clone();
        // Beacon hash filters select block occurrences, not a set. Bound each
        // response by the multiplicity already present in this authenticated L1 block.
        let mut block_occurrences = BTreeMap::<B256, usize>::new();
        for hash in block
            .txs
            .iter()
            .flat_map(|(tx, _receipt)| &tx.blob_versioned_hashes)
        {
            *block_occurrences.entry(*hash).or_default() += 1;
        }
        // Equal commitments bind equal blob data. One verified value per hash is
        // sufficient to reconstruct every occurrence in this block, so a hash
        // that several carriers name is requested and verified once.
        let mut verified = BTreeMap::<B256, Arc<Blob>>::new();
        for (tx, _receipt) in &mut block.txs {
            if tx.to != Some(inbox)
                || classify_inbox_carrier(&tx.input, &tx.blob_versioned_hashes)
                    != InboxEncoding::Blob
            {
                continue;
            }

            let mut seen = BTreeSet::new();
            let requested = tx
                .blob_versioned_hashes
                .iter()
                .copied()
                .filter(|hash| !verified.contains_key(hash) && seen.insert(*hash))
                .collect::<Vec<_>>();
            if !requested.is_empty() {
                self.fetch_verified(
                    &header,
                    tx.hash,
                    &requested,
                    &block_occurrences,
                    &mut verified,
                )
                .await?;
            }

            // Beacon responses use block commitment order, which need not be a
            // caller's query order. Reconstruct the codec input in the exact
            // versioned-hash order committed by this transaction.
            let ordered = tx
                .blob_versioned_hashes
                .iter()
                .map(|hash| {
                    verified
                        .get(hash)
                        .expect("all requested hashes were checked")
                })
                .map(AsRef::as_ref)
                .collect::<Vec<_>>();
            tx.blob_resolution = match decode_canonical_refs(&ordered, MAX_BATCH_BYTES) {
                Ok(batch) => BlobResolution::Batch(Bytes::from(batch)),
                Err(_) => BlobResolution::Invalid,
            };
        }
        Ok(())
    }

    /// Fetch `requested` for `transaction` and add each verified blob to
    /// `verified`, or fail with every requested hash still missing.
    async fn fetch_verified(
        &self,
        header: &L1Header,
        transaction: B256,
        requested: &[B256],
        block_occurrences: &BTreeMap<B256, usize>,
        verified: &mut BTreeMap<B256, Arc<Blob>>,
    ) -> Result<(), BlobError> {
        // Every failure below reports the same transaction and the same
        // requested set; only the reason differs.
        let unavailable = |reason: String| BlobError::Unavailable {
            transaction,
            missing: requested.to_vec(),
            reason,
        };
        let response = self
            .fetch(header, requested, block_occurrences)
            .await
            .map_err(&unavailable)?;

        let requested_set = requested.iter().copied().collect::<BTreeSet<_>>();
        // A response may repeat one blob once per block occurrence. Equal bytes
        // have equal commitments, so each distinct blob is committed to once.
        let mut committed = BTreeMap::<Arc<Blob>, B256>::new();
        let mut returned_occurrences = BTreeMap::<B256, usize>::new();
        for blob in response {
            let actual = if let Some(actual) = committed.get(&blob) {
                *actual
            } else {
                let actual =
                    self.kzg.hash(blob.clone()).await.map_err(|reason| {
                        unavailable(format!("KZG verification failed: {reason}"))
                    })?;
                committed.insert(blob.clone(), actual);
                actual
            };
            if !requested_set.contains(&actual) {
                return Err(unavailable(format!(
                    "Beacon API returned unrequested blob {actual}"
                )));
            }
            let returned = returned_occurrences.entry(actual).or_default();
            *returned += 1;
            let maximum = block_occurrences.get(&actual).copied().unwrap_or_default();
            if *returned > maximum {
                return Err(unavailable(format!(
                    "Beacon API returned more occurrences of blob {actual} than the L1 block"
                )));
            }
            verified.entry(actual).or_insert(blob);
        }

        let missing = requested
            .iter()
            .copied()
            .filter(|hash| !verified.contains_key(hash))
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(BlobError::Unavailable {
                transaction,
                missing,
                reason: "Beacon API omitted requested blobs".to_owned(),
            });
        }
        Ok(())
    }

    async fn fetch(
        &self,
        block: &L1Header,
        hashes: &[B256],
        block_occurrences: &BTreeMap<B256, usize>,
    ) -> Result<Vec<Arc<Blob>>, String> {
        let block_id = self.block_id(block)?;
        if matches!(&self.block_ids, BeaconBlockIds::Anvil) && hashes.len() > 1 {
            let maximum = hashes
                .iter()
                .try_fold(0usize, |total, hash| {
                    total.checked_add(block_occurrences.get(hash).copied().unwrap_or_default())
                })
                .ok_or_else(|| "blob response occurrence bound overflow".to_owned())?;
            let mut blobs = Vec::with_capacity(maximum);
            for hash in hashes {
                blobs.extend(
                    self.fetch_hashes(
                        block_id,
                        std::slice::from_ref(hash),
                        block_occurrences.get(hash).copied().unwrap_or_default(),
                    )
                    .await?,
                );
            }
            return Ok(blobs);
        }
        let maximum = hashes
            .iter()
            .try_fold(0usize, |total, hash| {
                total.checked_add(block_occurrences.get(hash).copied().unwrap_or_default())
            })
            .ok_or_else(|| "blob response occurrence bound overflow".to_owned())?;
        self.fetch_hashes(block_id, hashes, maximum).await
    }

    async fn fetch_hashes(
        &self,
        block_id: u64,
        hashes: &[B256],
        maximum_response_blobs: usize,
    ) -> Result<Vec<Arc<Blob>>, String> {
        let mut url = beacon_url(&self.base, &format!("eth/v1/beacon/blobs/{block_id}"));
        {
            let mut query = url.query_pairs_mut();
            for hash in hashes {
                query.append_pair("versioned_hashes", &hash.to_string());
            }
        }
        let mut response = self
            .client
            .get(url)
            .header(
                reqwest::header::ACCEPT,
                "application/octet-stream, application/json;q=0.9",
            )
            .send()
            .await
            .map_err(beacon_availability)?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status()));
        }
        let encoding = blob_response_encoding(&response)?;
        let maximum_bytes = blob_response_bound(maximum_response_blobs, encoding)?;
        if response
            .content_length()
            .is_some_and(|length| length > maximum_bytes as u64)
        {
            return Err("blob response Content-Length exceeds request bound".to_owned());
        }
        // The bound derives from blob counts the L1 RPC reported, so it caps
        // growth but is not preallocated: memory tracks bytes actually received.
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(beacon_availability)? {
            if body.len().saturating_add(chunk.len()) > maximum_bytes {
                return Err("blob response exceeds request bound".to_owned());
            }
            body.extend_from_slice(&chunk);
        }
        match encoding {
            BlobResponseEncoding::Ssz => decode_ssz_blobs(&body, maximum_response_blobs),
            BlobResponseEncoding::Json => decode_json_blobs(&body, maximum_response_blobs),
        }
    }
}

async fn anvil_rpc_u64(
    client: &reqwest::Client,
    endpoint: &reqwest::Url,
    method: &str,
) -> Result<u64, BlobError> {
    let response = client
        .post(endpoint.clone())
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": [],
        }))
        .send()
        .await
        .map_err(beacon_transport)?
        .error_for_status()
        .map_err(beacon_transport)?
        .json::<serde_json::Value>()
        .await
        .map_err(beacon_transport)?;
    response
        .get("result")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            BlobError::Beacon(format!(
                "spec endpoint is unavailable and {method} did not return a uint64"
            ))
        })
}

/// Anvil exposes the Beacon genesis/blob routes on its execution RPC port but
/// intentionally omits the configuration route. Accept that partial Beacon API
/// only after an Anvil-specific startup identity check.
async fn identify_anvil(
    client: &reqwest::Client,
    endpoint: &reqwest::Url,
    beacon_genesis_time: u64,
) -> Result<(), BlobError> {
    let anvil_genesis_time = anvil_rpc_u64(client, endpoint, "anvil_getGenesisTime").await?;
    if anvil_genesis_time != beacon_genesis_time {
        return Err(BlobError::Beacon(
            "Anvil execution and Beacon genesis times disagree".to_owned(),
        ));
    }
    Ok(())
}

fn beacon_transport(error: reqwest::Error) -> BlobError {
    BlobError::Beacon(error.without_url().to_string())
}

fn beacon_availability(error: reqwest::Error) -> String {
    error.without_url().to_string()
}

fn beacon_url(base: &reqwest::Url, suffix: &str) -> reqwest::Url {
    let mut url = base.clone();
    let path = format!("{}/{}", url.path().trim_end_matches('/'), suffix);
    url.set_path(&path);
    // Preserve endpoint query parameters because providers commonly use them
    // for authentication. Error construction strips the entire URL instead of
    // disabling those credentials.
    url.set_fragment(None);
    url
}

fn blob_response_encoding(response: &reqwest::Response) -> Result<BlobResponseEncoding, String> {
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim);
    match content_type {
        Some(value) if value.eq_ignore_ascii_case("application/octet-stream") => {
            Ok(BlobResponseEncoding::Ssz)
        }
        Some(value) if value.eq_ignore_ascii_case("application/json") => {
            Ok(BlobResponseEncoding::Json)
        }
        _ => Err("Beacon API returned an unsupported blob Content-Type".to_owned()),
    }
}

fn blob_response_bound(count: usize, encoding: BlobResponseEncoding) -> Result<usize, String> {
    let bytes_per_blob = match encoding {
        BlobResponseEncoding::Ssz => BYTES_PER_BLOB,
        BlobResponseEncoding::Json => JSON_BYTES_PER_BLOB,
    };
    let body = count
        .checked_mul(bytes_per_blob)
        .ok_or_else(|| "blob response bound overflow".to_owned())?;
    match encoding {
        BlobResponseEncoding::Ssz => Ok(body),
        BlobResponseEncoding::Json => body
            .checked_add(JSON_RESPONSE_HEADROOM)
            .ok_or_else(|| "blob response bound overflow".to_owned()),
    }
}

fn decode_ssz_blobs(bytes: &[u8], maximum: usize) -> Result<Vec<Arc<Blob>>, String> {
    if !bytes.len().is_multiple_of(BYTES_PER_BLOB) {
        return Err("SSZ blob response length is not a multiple of one blob".to_owned());
    }
    let count = bytes.len() / BYTES_PER_BLOB;
    if count > maximum {
        return Err("SSZ blob response contains more blobs than requested".to_owned());
    }
    bytes
        .chunks_exact(BYTES_PER_BLOB)
        .map(|chunk| {
            let value: [u8; BYTES_PER_BLOB] = chunk
                .try_into()
                .map_err(|_| "SSZ blob has the wrong length".to_owned())?;
            Ok(Arc::new(Blob::new(value)))
        })
        .collect()
}

fn decode_json_blobs(bytes: &[u8], maximum: usize) -> Result<Vec<Arc<Blob>>, String> {
    let response = serde_json::from_slice::<GetBlobsResponse>(bytes)
        .map_err(|error| format!("invalid JSON blob response: {error}"))?;
    if response.data.len() > maximum {
        return Err("JSON blob response contains more blobs than requested".to_owned());
    }
    Ok(response.data.into_iter().map(Arc::new).collect())
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
    use alloy_primitives::Address;
    use pcash_da::encode;
    use pcash_l1::{CarrierBatch, L1Receipt, L1Tx};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    fn block_with_hashes(hashes: Vec<B256>) -> L1BlockData {
        L1BlockData::new(
            L1Header {
                number: 101,
                hash: B256::repeat_byte(3),
                parent_hash: B256::repeat_byte(2),
                timestamp: 124,
            },
            vec![(
                L1Tx {
                    hash: B256::repeat_byte(4),
                    from: Address::repeat_byte(5),
                    to: Some(Address::repeat_byte(1)),
                    input: Bytes::new(),
                    blob_versioned_hashes: hashes,
                    blob_resolution: BlobResolution::Unresolved,
                    tx_index: 0,
                },
                L1Receipt { logs: Vec::new() },
            )],
        )
    }

    fn mock_beacon(
        blob_status: &'static str,
        blob_body: Vec<u8>,
    ) -> (String, mpsc::Receiver<String>) {
        mock_beacon_with_content_type(blob_status, "application/octet-stream", blob_body)
    }

    fn mock_beacon_with_content_type(
        blob_status: &'static str,
        blob_content_type: &'static str,
        blob_body: Vec<u8>,
    ) -> (String, mpsc::Receiver<String>) {
        mock_beacon_responses(vec![
            (
                "200 OK",
                "application/json",
                br#"{"data":{"genesis_time":"100"}}"#.to_vec(),
            ),
            (
                "200 OK",
                "application/json",
                br#"{"data":{"SECONDS_PER_SLOT":"12"}}"#.to_vec(),
            ),
            (blob_status, blob_content_type, blob_body),
        ])
    }

    fn mock_beacon_responses(
        responses: Vec<(&'static str, &'static str, Vec<u8>)>,
    ) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/prefix?token=credential",
            listener.local_addr().unwrap()
        );
        let (requests, captured) = mpsc::channel();
        std::thread::spawn(move || {
            for (status, content_type, body) in responses {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut chunk = [0u8; 4_096];
                loop {
                    let read = socket.read(&mut chunk).unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                requests.send(String::from_utf8(request).unwrap()).unwrap();
                let headers = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                socket.write_all(headers.as_bytes()).unwrap();
                socket.write_all(&body).unwrap();
            }
        });
        (endpoint, captured)
    }

    fn json_blob_response<'a>(blobs: impl IntoIterator<Item = &'a Blob>) -> Vec<u8> {
        let data = blobs
            .into_iter()
            .map(|blob| format!("0x{}", hex::encode(blob.as_slice())))
            .collect::<Vec<_>>();
        serde_json::to_vec(&serde_json::json!({
            "execution_optimistic": false,
            "finalized": false,
            "data": data,
        }))
        .unwrap()
    }

    #[test]
    fn slot_mapping_urls_and_response_bounds_are_exact() {
        let beacon = BeaconClient {
            client: reqwest::Client::new(),
            base: reqwest::Url::parse("http://127.0.0.1:5052/prefix?secret=hidden").unwrap(),
            block_ids: BeaconBlockIds::Slots {
                genesis_time: 100,
                seconds_per_slot: 12,
            },
            kzg: KzgHasher::new().unwrap(),
        };
        let mut block = block_with_hashes(Vec::new());
        assert_eq!(beacon.block_id(&block.header), Ok(2));
        block.header.timestamp = 99;
        assert!(beacon.block_id(&block.header).is_err());
        block.header.timestamp = 125;
        assert!(beacon.block_id(&block.header).is_err());

        let url = beacon_url(&beacon.base, "eth/v1/config/spec");
        assert_eq!(url.path(), "/prefix/eth/v1/config/spec");
        assert_eq!(url.query(), Some("secret=hidden"));

        let blob = encode(b"batch").unwrap().remove(0);
        assert_eq!(decode_ssz_blobs(blob.as_slice(), 1).unwrap().len(), 1);
        assert!(decode_ssz_blobs(&blob[..BYTES_PER_BLOB - 1], 1).is_err());
        let mut two = Vec::from(blob.as_slice());
        two.extend_from_slice(blob.as_slice());
        assert!(decode_ssz_blobs(&two, 1).is_err());

        let json = json_blob_response([&blob]);
        assert!(json.len() <= blob_response_bound(1, BlobResponseEncoding::Json).unwrap());
        assert_eq!(decode_json_blobs(&json, 1).unwrap().len(), 1);
        let two_json = json_blob_response([&blob, &blob]);
        assert!(decode_json_blobs(&two_json, 1).is_err());
        assert!(decode_json_blobs(
            br#"{"execution_optimistic":false,"finalized":false,"data":["0x00"]}"#,
            1,
        )
        .is_err());
    }

    #[tokio::test]
    async fn anvil_requests_all_blobs_by_block_even_after_clock_jumps() {
        let payload = vec![7; 126_946];
        let blobs = encode(&payload).unwrap();
        let hasher = KzgHasher::new().unwrap();
        let hashes = vec![
            hasher.hash(Arc::new(blobs[0])).await.unwrap(),
            hasher.hash(Arc::new(blobs[1])).await.unwrap(),
        ];
        let (endpoint, requests) = mock_beacon_responses(vec![
            (
                "200 OK",
                "application/json",
                br#"{"data":{"genesis_time":"100"}}"#.to_vec(),
            ),
            ("404 Not Found", "text/plain", Vec::new()),
            (
                "200 OK",
                "application/json",
                br#"{"jsonrpc":"2.0","id":1,"result":100}"#.to_vec(),
            ),
            (
                "200 OK",
                "application/json",
                json_blob_response([&blobs[0]]),
            ),
            (
                "200 OK",
                "application/json",
                json_blob_response([&blobs[1]]),
            ),
        ]);

        let beacon = BeaconClient::connect(&endpoint).await.unwrap();

        let mut block = block_with_hashes(hashes.clone());
        block.header.number = 133;
        block.header.timestamp = 100 + 86_517;
        beacon
            .resolve_block(&mut block, Address::repeat_byte(1))
            .await
            .unwrap();
        assert_eq!(block.txs[0].0.inbox_batch(), CarrierBatch::Bytes(&payload));
        assert!(requests
            .recv()
            .unwrap()
            .starts_with("GET /prefix/eth/v1/beacon/genesis"));
        assert!(requests
            .recv()
            .unwrap()
            .starts_with("GET /prefix/eth/v1/config/spec"));
        assert!(requests
            .recv()
            .unwrap()
            .starts_with("POST /prefix?token=credential"));
        for hash in hashes {
            let request = requests.recv().unwrap();
            let target = request.split_whitespace().nth(1).unwrap();
            let url = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
            assert_eq!(url.path(), "/prefix/eth/v1/beacon/blobs/133");
            let filters = url
                .query_pairs()
                .filter(|(key, _)| key == "versioned_hashes")
                .map(|(_, value)| value.into_owned())
                .collect::<Vec<_>>();
            assert_eq!(filters, vec![hash.to_string()]);
        }
    }

    #[tokio::test]
    async fn anvil_fetches_each_requested_blob_with_one_hash_filter() {
        let payload = vec![7; 126_946];
        let blobs = encode(&payload).unwrap();
        assert_eq!(blobs.len(), 2);
        let hasher = KzgHasher::new().unwrap();
        let hashes = vec![
            hasher.hash(Arc::new(blobs[0])).await.unwrap(),
            hasher.hash(Arc::new(blobs[1])).await.unwrap(),
        ];
        let (endpoint, requests) = mock_beacon_responses(vec![
            (
                "200 OK",
                "application/json",
                br#"{"data":{"genesis_time":"100"}}"#.to_vec(),
            ),
            ("404 Not Found", "text/plain", Vec::new()),
            (
                "200 OK",
                "application/json",
                br#"{"jsonrpc":"2.0","id":1,"result":100}"#.to_vec(),
            ),
            (
                "200 OK",
                "application/json",
                json_blob_response([&blobs[0]]),
            ),
            (
                "200 OK",
                "application/json",
                json_blob_response([&blobs[1]]),
            ),
        ]);
        let beacon = BeaconClient::connect(&endpoint).await.unwrap();
        let mut block = block_with_hashes(hashes.clone());
        block.header.number = 35;
        beacon
            .resolve_block(&mut block, Address::repeat_byte(1))
            .await
            .unwrap();
        assert_eq!(block.txs[0].0.inbox_batch(), CarrierBatch::Bytes(&payload));

        let _ = requests.recv().unwrap();
        let _ = requests.recv().unwrap();
        let _ = requests.recv().unwrap();
        for (hash, other) in [(hashes[0], hashes[1]), (hashes[1], hashes[0])] {
            let request = requests.recv().unwrap();
            assert!(request.starts_with("GET /prefix/eth/v1/beacon/blobs/35?"));
            assert!(request.contains(&format!("versioned_hashes={hash}")));
            assert!(!request.contains(&format!("versioned_hashes={other}")));
        }
    }

    #[tokio::test]
    async fn missing_spec_is_rejected_when_the_endpoint_is_not_anvil() {
        let (endpoint, _requests) = mock_beacon_responses(vec![
            (
                "200 OK",
                "application/json",
                br#"{"data":{"genesis_time":"100"}}"#.to_vec(),
            ),
            ("404 Not Found", "text/plain", Vec::new()),
            (
                "200 OK",
                "application/json",
                br#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}}"#
                    .to_vec(),
            ),
        ]);

        let error = match BeaconClient::connect(&endpoint).await {
            Ok(_) => panic!("non-Anvil endpoint without a spec was accepted"),
            Err(error) => error,
        };

        assert!(error
            .to_string()
            .contains("anvil_getGenesisTime did not return a uint64"));
    }

    #[tokio::test]
    async fn requests_exact_hashes_reorders_verified_blobs_and_decodes() {
        let payload = vec![7; 126_946];
        let blobs = encode(&payload).unwrap();
        let hasher = KzgHasher::new().unwrap();
        let hashes = vec![
            hasher.hash(Arc::new(blobs[0])).await.unwrap(),
            hasher.hash(Arc::new(blobs[1])).await.unwrap(),
        ];
        // The resolver must honor transaction hash order rather than trusting
        // response order.
        let body = blobs
            .iter()
            .rev()
            .flat_map(|blob| blob.iter().copied())
            .collect();
        let (endpoint, requests) = mock_beacon("200 OK", body);
        let beacon = BeaconClient::connect(&endpoint).await.unwrap();
        let mut block = block_with_hashes(hashes.clone());
        beacon
            .resolve_block(&mut block, Address::repeat_byte(1))
            .await
            .unwrap();
        assert_eq!(block.txs[0].0.inbox_batch(), CarrierBatch::Bytes(&payload));

        let genesis = requests.recv().unwrap();
        let spec = requests.recv().unwrap();
        let blobs_request = requests.recv().unwrap();
        assert!(genesis.starts_with("GET /prefix/eth/v1/beacon/genesis?token=credential HTTP/1.1"));
        assert!(spec.starts_with("GET /prefix/eth/v1/config/spec?token=credential HTTP/1.1"));
        assert!(blobs_request.starts_with("GET /prefix/eth/v1/beacon/blobs/2?"));
        for hash in hashes {
            assert!(blobs_request.contains(&format!("versioned_hashes={hash}")));
        }
        assert!(blobs_request
            .to_ascii_lowercase()
            .contains("accept: application/octet-stream"));
        assert!(blobs_request
            .to_ascii_lowercase()
            .contains("application/json;q=0.9"));
        assert!(genesis.contains("token=credential"));
    }

    #[tokio::test]
    async fn json_response_reorders_verified_blobs_and_decodes() {
        let payload = vec![8; 126_946];
        let blobs = encode(&payload).unwrap();
        let hasher = KzgHasher::new().unwrap();
        let hashes = vec![
            hasher.hash(Arc::new(blobs[0])).await.unwrap(),
            hasher.hash(Arc::new(blobs[1])).await.unwrap(),
        ];
        let body = json_blob_response(blobs.iter().rev());
        let (endpoint, requests) =
            mock_beacon_with_content_type("200 OK", "application/json; charset=utf-8", body);
        let beacon = BeaconClient::connect(&endpoint).await.unwrap();
        let mut block = block_with_hashes(hashes);
        beacon
            .resolve_block(&mut block, Address::repeat_byte(1))
            .await
            .unwrap();
        assert_eq!(block.txs[0].0.inbox_batch(), CarrierBatch::Bytes(&payload));

        let _ = requests.recv().unwrap();
        let _ = requests.recv().unwrap();
        let blobs_request = requests.recv().unwrap().to_ascii_lowercase();
        assert!(blobs_request.contains("accept: application/octet-stream"));
        assert!(blobs_request.contains("application/json;q=0.9"));
    }

    #[tokio::test]
    async fn repeated_hashes_in_one_transaction_accept_ssz_occurrences() {
        let blob = encode(b"repeated commitment").unwrap().remove(0);
        let hash = KzgHasher::new()
            .unwrap()
            .hash(Arc::new(blob))
            .await
            .unwrap();
        let mut body = blob.to_vec();
        body.extend_from_slice(blob.as_slice());
        let (endpoint, requests) = mock_beacon("200 OK", body);
        let beacon = BeaconClient::connect(&endpoint).await.unwrap();
        let mut block = block_with_hashes(vec![hash, hash]);

        beacon
            .resolve_block(&mut block, Address::repeat_byte(1))
            .await
            .unwrap();

        assert_eq!(block.txs[0].0.inbox_batch(), CarrierBatch::Ignore);
        let _ = requests.recv().unwrap();
        let _ = requests.recv().unwrap();
        let request = requests.recv().unwrap();
        assert_eq!(request.matches("versioned_hashes=").count(), 1);
    }

    #[tokio::test]
    async fn repeated_hashes_in_one_transaction_accept_json_occurrences() {
        let blob = encode(b"repeated commitment").unwrap().remove(0);
        let hash = KzgHasher::new()
            .unwrap()
            .hash(Arc::new(blob))
            .await
            .unwrap();
        let body = json_blob_response([&blob, &blob]);
        let (endpoint, requests) =
            mock_beacon_with_content_type("200 OK", "application/json", body);
        let beacon = BeaconClient::connect(&endpoint).await.unwrap();
        let mut block = block_with_hashes(vec![hash, hash]);

        beacon
            .resolve_block(&mut block, Address::repeat_byte(1))
            .await
            .unwrap();

        assert_eq!(block.txs[0].0.inbox_batch(), CarrierBatch::Ignore);
        let _ = requests.recv().unwrap();
        let _ = requests.recv().unwrap();
        let request = requests.recv().unwrap();
        assert_eq!(request.matches("versioned_hashes=").count(), 1);
    }

    #[tokio::test]
    async fn same_hash_in_several_transactions_is_fetched_and_committed_once() {
        let payload = b"shared blob payload";
        let blob = encode(payload).unwrap().remove(0);
        let hash = KzgHasher::new()
            .unwrap()
            .hash(Arc::new(blob))
            .await
            .unwrap();
        // Prysm and Nimbus return every block occurrence of a requested hash.
        // The mock answers one blob request only.
        let (endpoint, requests) = mock_beacon_with_content_type(
            "200 OK",
            "application/json",
            json_blob_response([&blob, &blob, &blob]),
        );
        let beacon = BeaconClient::connect(&endpoint).await.unwrap();
        let mut block = block_with_hashes(vec![hash]);
        for index in 1..3 {
            let mut carrier = block.txs[0].clone();
            carrier.0.hash = B256::repeat_byte(5 + index);
            carrier.0.tx_index = u64::from(index);
            block.txs.push(carrier);
        }

        beacon
            .resolve_block(&mut block, Address::repeat_byte(1))
            .await
            .unwrap();

        for (tx, _) in &block.txs {
            assert_eq!(tx.inbox_batch(), CarrierBatch::Bytes(payload));
        }
        assert_eq!(
            beacon
                .kzg
                .commitments
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
        let _ = requests.recv().unwrap();
        let _ = requests.recv().unwrap();
        let request = requests.recv().unwrap();
        assert_eq!(request.matches("versioned_hashes=").count(), 1);
        assert!(request.contains(&hash.to_string()));
    }

    #[tokio::test]
    async fn unsupported_blob_content_type_is_unavailable() {
        let blob = encode(b"batch").unwrap().remove(0);
        let hasher = KzgHasher::new().unwrap();
        let hash = hasher.hash(Arc::new(blob)).await.unwrap();
        let (endpoint, _requests) =
            mock_beacon_with_content_type("200 OK", "text/plain", blob.to_vec());
        let beacon = BeaconClient::connect(&endpoint).await.unwrap();
        let mut block = block_with_hashes(vec![hash]);
        assert!(matches!(
            beacon
                .resolve_block(&mut block, Address::repeat_byte(1))
                .await,
            Err(BlobError::Unavailable { reason, .. })
                if reason.contains("unsupported blob Content-Type")
        ));
    }

    #[tokio::test]
    async fn oversized_json_response_is_unavailable_before_parsing() {
        let blob = encode(b"batch").unwrap().remove(0);
        let hasher = KzgHasher::new().unwrap();
        let hash = hasher.hash(Arc::new(blob)).await.unwrap();
        let body = vec![b' '; blob_response_bound(1, BlobResponseEncoding::Json).unwrap() + 1];
        let (endpoint, _requests) =
            mock_beacon_with_content_type("200 OK", "application/json", body);
        let beacon = BeaconClient::connect(&endpoint).await.unwrap();
        let mut block = block_with_hashes(vec![hash]);
        assert!(matches!(
            beacon
                .resolve_block(&mut block, Address::repeat_byte(1))
                .await,
            Err(BlobError::Unavailable { reason, .. })
                if reason.contains("Content-Length exceeds request bound")
        ));
    }

    #[tokio::test]
    async fn missing_mismatched_and_oversized_responses_are_unavailable() {
        let blobs = encode(&vec![9; 126_946]).unwrap();
        let hasher = KzgHasher::new().unwrap();
        let hashes = vec![
            hasher.hash(Arc::new(blobs[0])).await.unwrap(),
            hasher.hash(Arc::new(blobs[1])).await.unwrap(),
        ];

        let (endpoint, _requests) = mock_beacon("200 OK", blobs[0].to_vec());
        let beacon = BeaconClient::connect(&endpoint).await.unwrap();
        let mut missing = block_with_hashes(hashes.clone());
        assert!(matches!(
            beacon
                .resolve_block(&mut missing, Address::repeat_byte(1))
                .await,
            Err(BlobError::Unavailable { missing, .. }) if missing == vec![hashes[1]]
        ));

        let wrong = encode(b"different").unwrap().remove(0);
        let (endpoint, _requests) = mock_beacon("200 OK", wrong.to_vec());
        let beacon = BeaconClient::connect(&endpoint).await.unwrap();
        let mut mismatched = block_with_hashes(vec![hashes[0]]);
        assert!(matches!(
            beacon
                .resolve_block(&mut mismatched, Address::repeat_byte(1))
                .await,
            Err(BlobError::Unavailable { .. })
        ));

        let mut oversized = blobs[0].to_vec();
        oversized.extend_from_slice(blobs[1].as_slice());
        let (endpoint, _requests) = mock_beacon("200 OK", oversized);
        let beacon = BeaconClient::connect(&endpoint).await.unwrap();
        let mut one_hash = block_with_hashes(vec![hashes[0]]);
        assert!(matches!(
            beacon
                .resolve_block(&mut one_hash, Address::repeat_byte(1))
                .await,
            Err(BlobError::Unavailable { .. })
        ));
    }

    #[tokio::test]
    async fn beacon_errors_do_not_expose_endpoint_credentials() {
        let (endpoint, requests) = mock_beacon("503 Service Unavailable", Vec::new());
        let beacon = BeaconClient::connect(&endpoint).await.unwrap();
        let blob = encode(b"batch").unwrap().remove(0);
        let hash = beacon.kzg.hash(Arc::new(blob)).await.unwrap();
        let mut block = block_with_hashes(vec![hash]);
        let error = beacon
            .resolve_block(&mut block, Address::repeat_byte(1))
            .await
            .unwrap_err()
            .to_string();
        assert!(!error.contains("credential"));
        let _ = requests.recv().unwrap();
        let _ = requests.recv().unwrap();
        assert!(requests.recv().unwrap().contains("credential"));
    }

    #[tokio::test]
    async fn verified_noncanonical_payload_is_ignored() {
        let mut blob = encode(b"batch").unwrap().remove(0);
        blob[9] = 1;
        let hasher = KzgHasher::new().unwrap();
        let hash = hasher.hash(Arc::new(blob)).await.unwrap();
        let (endpoint, _requests) = mock_beacon("200 OK", blob.to_vec());
        let beacon = BeaconClient::connect(&endpoint).await.unwrap();
        let mut block = block_with_hashes(vec![hash]);
        beacon
            .resolve_block(&mut block, Address::repeat_byte(1))
            .await
            .unwrap();
        assert_eq!(block.txs[0].0.inbox_batch(), CarrierBatch::Ignore);
    }
}
