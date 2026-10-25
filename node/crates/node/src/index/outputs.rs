use pcash_state::Codec;

use super::keys::{output_key, T_OUTPUTS};
use super::store::{IndexReadSource, IndexStore};
use super::types::{
    IndexBlockId, IndexedOutputItem, IndexedOutputMaterial, OutputContinuation, OutputError,
    OutputLimits, OutputPage, OutputTarget,
};

fn unavailable(error: impl std::fmt::Display) -> OutputError {
    OutputError::Unavailable(error.to_string())
}

impl<D: IndexReadSource> IndexStore<D> {
    /// One page of the outputs `[from, target.outputCount)`, in whole units:
    /// every row of one transaction, its arena on the slot-0 row, or one
    /// system payout row. A `from_output_index` inside a transaction rewinds
    /// to that transaction's first output, and the page reports the rewound
    /// index. A continuation resumes at a unit boundary of the same interval.
    pub fn output_page(
        &self,
        from_output_index: u64,
        target: IndexBlockId,
        continuation: Option<OutputContinuation>,
        limits: OutputLimits,
    ) -> Result<OutputPage, OutputError> {
        let limits = limits.bounded()?;
        let cursor = self
            .cursor()
            .map_err(unavailable)?
            .ok_or_else(|| OutputError::Unavailable("index has no canonical cursor".into()))?;
        if target.number > cursor.pcash_number {
            return Err(OutputError::Unavailable(
                "target is beyond the ready index cursor".into(),
            ));
        }
        let target_block = self
            .indexed_block(target.number)
            .map_err(unavailable)?
            .ok_or(OutputError::CursorMismatch)?;
        if target_block.hash != target.hash || from_output_index > target_block.output_count {
            return Err(OutputError::CursorMismatch);
        }
        let target_output_count = target_block.output_count;

        let read = self.db.read_transaction().map_err(unavailable)?;
        let table = read.open_table(T_OUTPUTS).map_err(unavailable)?;
        // The first output of the unit holding `index`, or `index` itself at
        // the end of the interval.
        let unit_start = |index: u64| -> Result<u64, OutputError> {
            if index == target_output_count {
                return Ok(index);
            }
            let row = table
                .get(output_key(index).as_slice())
                .map_err(unavailable)?
                .ok_or_else(|| OutputError::Unavailable(format!("output {index} is missing")))?;
            Ok(IndexedOutputItem::decode(row.value())
                .map_err(unavailable)?
                .unit_start())
        };
        let from_output_index = unit_start(from_output_index)?;
        let start = if let Some(value) = continuation {
            if value.from_output_index != from_output_index
                || value.target != target
                || value.target_output_count != target_output_count
                || value.next_output_index < from_output_index
                || value.next_output_index > target_output_count
                || unit_start(value.next_output_index)? != value.next_output_index
            {
                return Err(OutputError::CursorMismatch);
            }
            value.next_output_index
        } else {
            from_output_index
        };

        let max_rows = limits.max_outputs as usize;
        let max_bytes = limits.max_bytes as usize;
        let mut outputs = Vec::new();
        let mut page_bytes = 0usize;
        // The unit being read: its rows and stored bytes. It joins the page
        // once the next unit begins or the interval ends.
        let mut unit = Vec::new();
        let mut unit_bytes = 0usize;
        let mut next = target_output_count;
        if start < target_output_count {
            let first = output_key(start);
            let last = output_key(target_output_count - 1);
            let rows = table
                .range(first.as_slice()..=last.as_slice())
                .map_err(unavailable)?;
            for row in rows {
                let (_, value) = row.map_err(unavailable)?;
                let output = IndexedOutputItem::decode(value.value()).map_err(unavailable)?;
                let row_bytes = value.value().len();
                if output.unit_start() == output.output_index {
                    outputs.append(&mut unit);
                    page_bytes += unit_bytes;
                    unit_bytes = 0;
                }
                if outputs.len() + unit.len() >= max_rows
                    || page_bytes + unit_bytes + row_bytes > max_bytes
                {
                    if outputs.is_empty() {
                        return Err(OutputError::InvalidRequest(
                            match output.material {
                                IndexedOutputMaterial::Ordinary { .. } => {
                                    "limits are too small for one transaction"
                                }
                                IndexedOutputMaterial::System { .. } => {
                                    "limits are too small for one output"
                                }
                            }
                            .into(),
                        ));
                    }
                    next = output.unit_start();
                    unit.clear();
                    break;
                }
                unit_bytes += row_bytes;
                unit.push(output);
            }
            outputs.append(&mut unit);
        }
        let complete = next == target_output_count;
        Ok(OutputPage {
            from_output_index,
            target: OutputTarget {
                block: target,
                output_count: target_output_count,
            },
            outputs,
            continuation: (!complete).then_some(OutputContinuation {
                from_output_index,
                target,
                target_output_count,
                next_output_index: next,
            }),
            complete,
        })
    }
}
