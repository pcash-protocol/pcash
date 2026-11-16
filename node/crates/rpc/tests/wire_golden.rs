#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unreadable_literal,
    reason = "tests use direct assertions for fixture setup"
)]
//! Frozen wire shapes for every `pcash_*` response DTO.
//!
//! Each fixture is fully populated with distinct byte patterns, so a field that
//! swaps places with another shows up as a diff rather than passing silently.
//! The expected JSON lives in `wire_golden.json`; regenerate it deliberately
//! with `PCASH_BLESS_GOLDEN=1 cargo test -p pcash-rpc --test wire_golden`.
//!
//! This is the guard that the serde conversion of the DTOs did not move a byte
//! on the wire. It deliberately shares no code with the client.

use pcash_rpc::test_support::{fixtures, ToWire};
use pcash_rpc::*;
use serde_json::{Map, Value};

const GOLDEN: &str = include_str!("wire_golden.json");

/// Decode a frozen fixture into `T` and re-encode it, asserting the wire is
/// unchanged. This is the client's half of the contract: whatever the server
/// emits, the typed client reads back without losing or inventing a field.
fn round_trip<T: serde::Serialize + serde::de::DeserializeOwned>(name: &str) {
    let golden: Value = serde_json::from_str(GOLDEN).expect("wire_golden.json parses");
    let expected = golden
        .get(name)
        .unwrap_or_else(|| panic!("fixture `{name}` is missing"));
    let decoded: T = serde_json::from_value(expected.clone())
        .unwrap_or_else(|error| panic!("fixture `{name}` does not decode: {error}"));
    assert_eq!(&decoded.to_value(), expected, "`{name}` did not round-trip");
}

#[test]
fn every_response_type_round_trips_from_the_wire() {
    round_trip::<StatusDto>("status");
    round_trip::<DerivationDto>("derivationStalled");
    round_trip::<DerivationDto>("derivationHalted");
    round_trip::<PayoutPageDto>("payoutPage");
    round_trip::<IssuanceQuoteDto>("issuanceQuote");
    round_trip::<BlockEconomicsPageDto>("blockEconomicsPage");
    round_trip::<OutputItemDto>("outputSystem");
    round_trip::<pcash_rpc::WitnessSnapshotDto>("witnessSnapshot");
    round_trip::<BlockDto>("block");
    round_trip::<BlockId>("blockId");
    round_trip::<CurrentBoundaryEnvelope>("boundary");
    round_trip::<OutputPathDto>("outputPath");
    round_trip::<OutputPathsDto>("outputPaths");
    round_trip::<AccountDto>("account");
    round_trip::<ReceiveMaterialDto>("accountMaterialNotPresent");
    round_trip::<ReceiveMaterialDto>("accountMaterialUnavailable");
    round_trip::<AccountProofResultDto>("accountProofPresent");
    round_trip::<AccountProofResultDto>("accountProofNotFound");
    round_trip::<ContractResultDto>("contractContract");
    round_trip::<ContractResultDto>("contractNotContract");
    round_trip::<ContractResultDto>("contractNotFound");
    round_trip::<ContractResultDto>("contractUnavailable");
    round_trip::<BlockHeaderDto>("blockHeader");
    round_trip::<L1OriginProofDto>("l1OriginProof");
    round_trip::<L1LogProofDto>("l1LogProof");
    round_trip::<HistoryProofDto>("historyProof");
    round_trip::<NullifierProofsDto>("nullifierProofs");
    round_trip::<ReceiptDto>("receipt");
    round_trip::<InclusionId>("inclusionId");
    round_trip::<pcash_rpc::FeeEstimateDto>("feeEstimate");
    round_trip::<MempoolTransactionDto>("mempoolTransaction");
    round_trip::<MempoolPageDto>("mempoolPage");
    round_trip::<PreparedRelayDto>("preparedRelay");
    round_trip::<TransactionCheckDto>("transactionCheck");
    round_trip::<TransactionCheckDto>("transactionCheckNotAdmitted");
    round_trip::<BlockPayoutsDto>("blockPayouts");
    round_trip::<L1DeliveryBatchPageDto>("l1DeliveryBatchPage");
    round_trip::<OutputPageDto>("outputPage");
    round_trip::<OutputFrontierDto>("outputFrontier");
    round_trip::<AccountChangePageDto>("accountChangePage");
    round_trip::<CatalogRecord>("catalogRecord");
    round_trip::<CatalogPage>("catalogPage");
    round_trip::<CatalogInfo>("catalogInfoAvailable");
    round_trip::<CatalogInfo>("catalogInfoDisabled");
    round_trip::<PeerInfoDto>("peer");
    round_trip::<PeerInfoDto>("peerUnidentified");
    round_trip::<NodeInfoDto>("nodeInfo");
    round_trip::<AddPeerResultDto>("addPeerResult");
    round_trip::<RemovePeerResultDto>("removePeerResult");
}

#[test]
fn wire_shapes_match_the_frozen_golden() {
    let actual: Value = Value::Object(fixtures().into_iter().collect::<Map<_, _>>());

    if std::env::var("PCASH_BLESS_GOLDEN").as_deref() == Ok("1") {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/wire_golden.json");
        std::fs::write(
            path,
            format!("{}\n", serde_json::to_string_pretty(&actual).unwrap()),
        )
        .unwrap();
        return;
    }

    let expected: Value = serde_json::from_str(GOLDEN).expect("wire_golden.json parses");
    // Compare key by key so a failure names the DTO that moved.
    let (actual_map, expected_map) = (actual.as_object().unwrap(), expected.as_object().unwrap());
    for (name, expected_value) in expected_map {
        let actual_value = actual_map
            .get(name)
            .unwrap_or_else(|| panic!("fixture `{name}` disappeared"));
        assert_eq!(
            actual_value, expected_value,
            "wire shape for `{name}` changed"
        );
    }
    assert_eq!(
        actual_map.keys().collect::<Vec<_>>(),
        expected_map.keys().collect::<Vec<_>>(),
        "fixture set changed"
    );
}
