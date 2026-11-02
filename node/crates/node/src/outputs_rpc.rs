//! Output index to RPC mapping.

use pcash_rpc::dto::{
    BlockId, OutputContinuationDto, OutputItemDto, OutputOriginDto, OutputPageDto, OutputTargetDto,
};
use pcash_rpc::{IndexReadError, OutputRequest};

use crate::index::{
    DerivedIndexRead, IndexBlockId, IndexedOutputItem, OutputContinuation, OutputError,
    OutputLimits, OutputPage,
};

impl From<IndexBlockId> for BlockId {
    fn from(value: IndexBlockId) -> Self {
        Self {
            block_number: value.number,
            block_hash: value.hash,
        }
    }
}

impl From<BlockId> for IndexBlockId {
    fn from(value: BlockId) -> Self {
        Self {
            number: value.block_number,
            hash: value.block_hash,
        }
    }
}

fn output_item_dto(output: IndexedOutputItem, block_timestamp: u64) -> OutputItemDto {
    OutputItemDto {
        output_index: output.output_index,
        output_commitment: output.output_commitment,
        material: match output.material {
            crate::index::IndexedOutputMaterial::Ordinary {
                output_data,
                transaction_id,
                transaction_kind,
                private_value_shape,
                output_slot,
                content_hash,
                nullifiers,
                arena,
            } => pcash_rpc::OutputMaterialDto::Ordinary {
                output_data: output_data.into(),
                transaction_id,
                transaction_type: transaction_kind,
                private_value_shape,
                output_slot,
                content_hash,
                nullifiers,
                arena: (output_slot == 0).then(|| arena.into()),
            },
            crate::index::IndexedOutputMaterial::System {
                transaction_id,
                payout,
            } => pcash_rpc::OutputMaterialDto::System {
                payout: pcash_rpc::PayoutOutputDto {
                    transaction_id,
                    payout: payout.into(),
                },
            },
        },
        origin: OutputOriginDto {
            block_number: output.pcash_block_number,
            block_hash: output.pcash_block_hash,
            block_timestamp,
        },
    }
}

impl From<OutputContinuation> for OutputContinuationDto {
    fn from(value: OutputContinuation) -> Self {
        Self {
            from_output_index: value.from_output_index,
            target: value.target.into(),
            target_output_count: value.target_output_count,
            next_output_index: value.next_output_index,
        }
    }
}

impl From<OutputContinuationDto> for OutputContinuation {
    fn from(value: OutputContinuationDto) -> Self {
        Self {
            from_output_index: value.from_output_index,
            target: value.target.into(),
            target_output_count: value.target_output_count,
            next_output_index: value.next_output_index,
        }
    }
}

/// Rows arrive in output-index order, so each origin block's header is read
/// once per run of outputs it created.
fn output_page_dto(
    page: OutputPage,
    mut block_timestamp: impl FnMut(u64) -> Result<u64, IndexReadError>,
) -> Result<OutputPageDto, IndexReadError> {
    let mut origin: Option<(u64, u64)> = None;
    let mut outputs = Vec::with_capacity(page.outputs.len());
    for output in page.outputs {
        let timestamp = match origin {
            Some((number, timestamp)) if number == output.pcash_block_number => timestamp,
            _ => {
                let timestamp = block_timestamp(output.pcash_block_number)?;
                origin = Some((output.pcash_block_number, timestamp));
                timestamp
            }
        };
        outputs.push(output_item_dto(output, timestamp));
    }
    Ok(OutputPageDto {
        from_output_index: page.from_output_index,
        target: OutputTargetDto {
            block: page.target.block.into(),
            output_count: page.target.output_count,
        },
        outputs,
        continuation: page.continuation.map(Into::into),
        complete: page.complete,
    })
}

/// `state` is the canonical snapshot the ready index cursor was checked
/// against, so every origin at or below the target is canonical in it.
pub(crate) fn get_outputs(
    state: &pcash_state::RedbReadSnapshot,
    index: &DerivedIndexRead,
    request: OutputRequest,
) -> Result<OutputPageDto, IndexReadError> {
    let page = index
        .output_page(
            request.from_output_index,
            request.target.into(),
            request.continuation.map(Into::into),
            OutputLimits {
                max_outputs: request.limits.max_outputs,
                max_bytes: request.limits.max_bytes,
            },
        )
        .map_err(|error| match error {
            OutputError::Unavailable(message) => IndexReadError::Unavailable(message),
            OutputError::CursorMismatch => IndexReadError::CursorMismatch,
            OutputError::InvalidRequest(message) => IndexReadError::Invalid(message),
        })?;
    output_page_dto(page, |number| {
        state
            .canonical_stored_block(number)?
            .map(|block| block.header.timestamp)
            .ok_or_else(|| {
                IndexReadError::Unavailable(format!("canonical block {number} is missing"))
            })
    })
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions"
)]
mod tests {
    use super::*;
    use crate::index::OutputTarget;
    use alloy_primitives::{Bytes, B256};
    use pcash_state::Codec;

    #[test]
    fn block_id_round_trip() {
        let index_block = IndexBlockId {
            number: 42,
            hash: B256::repeat_byte(0xab),
        };
        let rpc_block: BlockId = index_block.into();
        assert_eq!(rpc_block.block_number, 42);
        assert_eq!(rpc_block.block_hash, B256::repeat_byte(0xab));

        let back: IndexBlockId = rpc_block.into();
        assert_eq!(back, index_block);
    }

    #[test]
    fn output_envelope_matches_the_sdk_vector_and_frozen_rpc_json() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../../../../sdk/test/envelope.vector.json"))
                .unwrap();
        let data = hex::decode(vector["envelope"].as_str().unwrap()).unwrap();
        let dto = output_item_dto(
            IndexedOutputItem {
                output_index: 0,
                output_commitment: B256::repeat_byte(1),
                material: crate::index::IndexedOutputMaterial::Ordinary {
                    output_data: data,
                    transaction_id: B256::repeat_byte(2),
                    transaction_kind: 0,
                    private_value_shape: Some(0),
                    output_slot: 0,
                    content_hash: B256::repeat_byte(3),
                    nullifiers: vec![],
                    arena: vec![],
                },
                pcash_block_number: 1,
                pcash_block_hash: B256::repeat_byte(4),
            },
            1_700_000_000,
        );
        let actual = serde_json::to_value(dto).unwrap();
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../../rpc/tests/wire_golden.json")).unwrap();
        let expected = &golden["outputPage"]["outputs"][0];
        assert_eq!(actual["outputData"], expected["outputData"]);
        assert!(actual.get("outputDataEnvelope").is_none());
    }

    #[test]
    fn output_item_dto_conversion() {
        let item = |output_slot: u16| IndexedOutputItem {
            output_index: 7,
            output_commitment: B256::repeat_byte(0x01),
            material: crate::index::IndexedOutputMaterial::Ordinary {
                output_data: vec![1, 2, 3, 4],
                transaction_id: B256::repeat_byte(0x02),
                transaction_kind: 1,
                private_value_shape: None,
                output_slot,
                content_hash: B256::repeat_byte(0x04),
                nullifiers: if output_slot == 0 {
                    vec![B256::repeat_byte(0x05)]
                } else {
                    Vec::new()
                },
                arena: if output_slot == 0 {
                    vec![6, 7]
                } else {
                    Vec::new()
                },
            },
            pcash_block_number: 10,
            pcash_block_hash: B256::repeat_byte(0x03),
        };
        let dto = output_item_dto(item(0), 1_700_000_000);
        assert_eq!(dto.output_index, 7);
        assert_eq!(dto.output_commitment, B256::repeat_byte(0x01));
        assert_eq!(
            dto.material,
            pcash_rpc::OutputMaterialDto::Ordinary {
                output_data: Bytes::from(vec![1, 2, 3, 4]),
                transaction_id: B256::repeat_byte(0x02),
                transaction_type: 1,
                private_value_shape: None,
                output_slot: 0,
                content_hash: B256::repeat_byte(0x04),
                nullifiers: vec![B256::repeat_byte(0x05)],
                arena: Some(Bytes::from(vec![6, 7])),
            }
        );
        assert_eq!(
            dto.origin,
            OutputOriginDto {
                block_number: 10,
                block_hash: B256::repeat_byte(0x03),
                block_timestamp: 1_700_000_000,
            }
        );
        // Only the slot-0 row carries the arena; the field is absent elsewhere.
        let later = serde_json::to_value(output_item_dto(item(1), 1_700_000_000)).unwrap();
        assert!(later.get("arena").is_none());
        let first = serde_json::to_value(dto).unwrap();
        assert_eq!(first["arena"], "0x0607");
    }

    /// `maxBytes` charges stored rows, which are smaller than the JSON they
    /// become, so the largest budget must still fit one response.
    #[test]
    fn a_maximum_byte_budget_page_fits_the_response_limit() {
        let large = pcash_derive::private_value_profiles::L;
        for (output_slot, nullifiers, arena) in [
            (
                0,
                vec![B256::repeat_byte(0x05); large.inputs],
                vec![0xa5; large.arena_bytes],
            ),
            (1, Vec::new(), Vec::new()),
        ] {
            let item = IndexedOutputItem {
                output_index: u64::MAX,
                output_commitment: B256::repeat_byte(0x01),
                material: crate::index::IndexedOutputMaterial::Ordinary {
                    output_data: vec![0xa5; pcash_derive::OUTPUT_DATA_BYTES],
                    transaction_id: B256::repeat_byte(0x02),
                    transaction_kind: 0,
                    private_value_shape: Some(1),
                    output_slot,
                    content_hash: B256::repeat_byte(0x04),
                    nullifiers,
                    arena,
                },
                pcash_block_number: u64::MAX,
                pcash_block_hash: B256::repeat_byte(0x03),
            };
            let stored = item.encode().len() as u64;
            let returned = serde_json::to_vec(&output_item_dto(item, u64::MAX))
                .unwrap()
                .len() as u64;
            assert!(
                returned * u64::from(OutputLimits::HARD_MAX_BYTES)
                    <= stored * u64::from(pcash_rpc::server::MAX_RPC_RESPONSE_BODY_BYTES),
                "{stored} stored bytes return {returned}"
            );
        }
    }

    #[test]
    fn output_continuation_round_trip() {
        let continuation = OutputContinuation {
            from_output_index: 100,
            target: IndexBlockId {
                number: 200,
                hash: B256::repeat_byte(0x22),
            },
            target_output_count: 50,
            next_output_index: 105,
        };
        let dto: OutputContinuationDto = continuation.clone().into();
        assert_eq!(dto.from_output_index, 100);
        assert_eq!(dto.target.block_number, 200);
        assert_eq!(dto.target.block_hash, B256::repeat_byte(0x22));
        assert_eq!(dto.target_output_count, 50);
        assert_eq!(dto.next_output_index, 105);

        let back: OutputContinuation = dto.into();
        assert_eq!(back, continuation);
    }

    fn ordinary_output(output_index: u64, block_number: u64) -> IndexedOutputItem {
        IndexedOutputItem {
            output_index,
            output_commitment: B256::repeat_byte(0x01),
            material: crate::index::IndexedOutputMaterial::Ordinary {
                output_data: vec![1, 2, 3, 4],
                transaction_id: B256::repeat_byte(0x02),
                transaction_kind: 1,
                private_value_shape: None,
                output_slot: 0,
                content_hash: B256::repeat_byte(0x04),
                nullifiers: Vec::new(),
                arena: Vec::new(),
            },
            pcash_block_number: block_number,
            pcash_block_hash: B256::repeat_byte(block_number as u8),
        }
    }

    #[test]
    fn output_page_dto_reads_each_origin_block_once() {
        let page = OutputPage {
            from_output_index: 0,
            target: OutputTarget {
                block: IndexBlockId {
                    number: 5,
                    hash: B256::repeat_byte(0x55),
                },
                output_count: 4,
            },
            outputs: vec![
                ordinary_output(0, 2),
                ordinary_output(1, 2),
                ordinary_output(2, 4),
                ordinary_output(3, 5),
            ],
            continuation: None,
            complete: true,
        };
        let mut reads = Vec::new();
        let dto = output_page_dto(page, |number| {
            reads.push(number);
            Ok(1_000 + number)
        })
        .unwrap();
        assert_eq!(reads, vec![2, 4, 5]);
        assert_eq!(
            dto.outputs
                .iter()
                .map(|output| (output.origin.block_number, output.origin.block_timestamp))
                .collect::<Vec<_>>(),
            vec![(2, 1_002), (2, 1_002), (4, 1_004), (5, 1_005)]
        );
        assert_eq!(dto.target.block.block_number, 5);
        assert_eq!(dto.target.block.block_hash, B256::repeat_byte(0x55));
        assert_eq!(dto.target.output_count, 4);
        assert!(dto.continuation.is_none());
        assert!(dto.complete);
    }
}
