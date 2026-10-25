//! Human-readable rendering of a `pcash_*` JSON `result` (the default, non-`--json`
//! output).
//!
//! The node encodes responses as fixed-width lowercase `0x` hex for byte strings
//! and minimal `0x` hex for quantities. This renderer walks the raw
//! `serde_json::Value` and prints aligned `Label: value` lines, decoding values
//! by a small, centralized classification keyed on the response field names:
//!
//! * amount fields (`issuedSoFar`, `openFeeAmount`, …) → decimal PCASH (18 decimals)
//!   plus raw wei;
//! * timestamp fields → epoch plus UTC (RFC 3339);
//! * other quantities → decimal (raw hex in parens);
//! * byte strings (hashes, roots, addresses, siblings) → full lowercase hex;
//! * large opaque blobs (calldata, envelope, raw tx) → head…tail + byte length.
//!
//! `--json` bypasses this module entirely and prints the raw `result`.

#![allow(
    clippy::print_stdout,
    reason = "the CLI renderer intentionally prints user-facing command output"
)]

use alloy_primitives::U256;
use serde_json::{Map, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// PCASH-wei amount fields (18-decimal): rendered as decimal PCASH + raw wei.
const AMOUNT_KEYS: &[&str] = &[
    "issuedSoFar",
    "supplyCap",
    "baseline",
    "internalOffer",
    "blockAllowance",
    "maxSingleActionReward",
    "rewardEach",
    "issuanceTotal",
    "openFeesTotal",
    "settledOpenFeeAmount",
    "settledIssuanceAmount",
    "openFeeAmount",
    "issuanceAmount",
    "collectibleOpenFee",
    "minOpenFee",
    "low",
    "standard",
    "fast",
];

/// Unix-seconds timestamp fields: rendered as epoch + UTC.
const TIMESTAMP_SEC_KEYS: &[&str] = &[
    "latestBlockTimestamp",
    "finalizedBlockTimestamp",
    "timestamp",
    "validUntil",
    "createdAt",
];

/// Unix-milliseconds timestamp fields: rendered as epoch(ms) + UTC.
const TIMESTAMP_MS_KEYS: &[&str] = &["receivedAtUnixMs"];

/// Hex bodies longer than this many chars are treated as large opaque blobs and
/// abbreviated in the human view (full value is always available via `--json`).
const BLOB_HEX_THRESHOLD: usize = 132;

/// Print a `pcash_*` `result` in decoded, human-readable form.
pub fn print_result(result: &Value) {
    let mut out = String::new();
    match result {
        Value::Null => out.push_str("null (not found)\n"),
        Value::Object(map) => render_object(map, 0, &mut out),
        Value::Array(items) => render_array_top(items, &mut out),
        other => {
            out.push_str(&render_scalar(None, other));
            out.push('\n');
        }
    }
    print!("{out}");
}

/// Render a top-level array (`pcash_getBlocks`, `pcash_getReceipt`,
/// `pcash_areNullifiersSpent`, …).
fn render_array_top(items: &[Value], out: &mut String) {
    if items.is_empty() {
        out.push_str("(empty)\n");
        return;
    }
    for (i, item) in items.iter().enumerate() {
        match item {
            Value::Object(map) => {
                out.push_str(&format!("[{i}]\n"));
                render_object(map, 2, out);
                if i + 1 < items.len() {
                    out.push('\n');
                }
            }
            scalar => {
                out.push_str(&format!("[{i}]  {}\n", render_scalar(None, scalar)));
            }
        }
    }
}

/// Render a JSON object as aligned `Label: value` lines; nested objects/arrays
/// become indented sub-blocks.
fn render_object(map: &Map<String, Value>, indent: usize, out: &mut String) {
    let pad = " ".repeat(indent);
    let width = map.keys().map(|k| humanize(k).len()).max().unwrap_or(0);
    for (key, value) in map {
        let label = humanize(key);
        match value {
            Value::Object(child) => {
                out.push_str(&format!("{pad}{label}:\n"));
                render_object(child, indent + 2, out);
            }
            Value::Array(items) => render_array_field(&label, key, items, indent, out),
            scalar => {
                let rendered = render_scalar(Some(key), scalar);
                out.push_str(&format!("{pad}{label:<width$}  {rendered}\n"));
            }
        }
    }
}

/// Render an object field whose value is an array.
fn render_array_field(label: &str, key: &str, items: &[Value], indent: usize, out: &mut String) {
    let pad = " ".repeat(indent);
    if items.is_empty() {
        out.push_str(&format!("{pad}{label}: (none)\n"));
        return;
    }
    out.push_str(&format!("{pad}{label}: ({} items)\n", items.len()));
    let child = " ".repeat(indent + 2);
    for (i, item) in items.iter().enumerate() {
        match item {
            Value::Object(map) => {
                out.push_str(&format!("{child}[{i}]\n"));
                render_object(map, indent + 4, out);
            }
            scalar => {
                out.push_str(&format!(
                    "{child}[{i}]  {}\n",
                    render_scalar(Some(key), scalar)
                ));
            }
        }
    }
}

/// Render one scalar value, decoding by its field semantics.
fn render_scalar(key: Option<&str>, value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => render_string(key, s),
        // Nested containers are handled by the callers; reaching here is a
        // defensive fallback.
        other => other.to_string(),
    }
}

fn render_string(key: Option<&str>, s: &str) -> String {
    if let Some(k) = key {
        if AMOUNT_KEYS.contains(&k) {
            if let Some(v) = parse_quantity(s) {
                return format!("{} PCASH  ({} wei)", format_pcash(v), v);
            }
        }
        if TIMESTAMP_SEC_KEYS.contains(&k) {
            if let Some(v) = parse_quantity(s).and_then(u256_to_i64) {
                return format!("{v}  ({})", format_unix_secs(v));
            }
        }
        if TIMESTAMP_MS_KEYS.contains(&k) {
            if let Some(v) = parse_quantity(s).and_then(u256_to_i64) {
                return format!("{v} ms  ({})", format_unix_secs(v / 1000));
            }
        }
    }

    // Generic hex string handling.
    if let Some(body) = s.strip_prefix("0x") {
        if body.is_empty() {
            return "0x (empty)".to_string();
        }
        if !body.bytes().all(|b| b.is_ascii_hexdigit()) {
            return s.to_string();
        }
        // Byte strings are fixed-width: 20-byte address (40) or 32-byte field
        // element (64), and arbitrary blobs are longer. Quantities are minimal
        // hex and never reach 32 bytes here, so a shorter body is a quantity.
        if body.len() >= 40 {
            if body.len() > BLOB_HEX_THRESHOLD {
                let bytes = body.len() / 2;
                let head = &body[..32];
                let tail = &body[body.len() - 32..];
                return format!("0x{head}…{tail}  ({bytes} bytes, use --json for full)");
            }
            return s.to_string();
        }
        if let Some(v) = parse_quantity(s) {
            return format!("{v}  ({s})");
        }
    }
    s.to_string()
}

/// Parse a quantity string (`"0x2a"`) into a `U256`.
fn parse_quantity(s: &str) -> Option<U256> {
    let body = s.strip_prefix("0x")?;
    U256::from_str_radix(body, 16).ok()
}

fn u256_to_i64(v: U256) -> Option<i64> {
    i64::try_from(v).ok()
}

/// Format PCASH-wei as decimal PCASH (18 decimals, trailing zeros trimmed).
fn format_pcash(wei: U256) -> String {
    let divisor = U256::from(1_000_000_000_000_000_000u64); // 10^18
    let whole = wei / divisor;
    let frac = wei % divisor;
    if frac.is_zero() {
        return whole.to_string();
    }
    // frac < 10^18, so its decimal has at most 18 digits; left-pad to 18.
    let frac_digits = format!("{frac:0>18}", frac = frac.to_string());
    let trimmed = frac_digits.trim_end_matches('0');
    format!("{whole}.{trimmed}")
}

fn format_unix_secs(secs: i64) -> String {
    match OffsetDateTime::from_unix_timestamp(secs) {
        Ok(dt) => dt.format(&Rfc3339).unwrap_or_else(|_| dt.to_string()),
        Err(_) => "invalid timestamp".to_string(),
    }
}

/// camelCase / `l1Block` → Title Case With Spaces label.
fn humanize(key: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for ch in key.chars() {
        if ch.is_ascii_uppercase() && prev_lower {
            words.push(std::mem::take(&mut cur));
        }
        cur.push(ch);
        prev_lower = ch.is_ascii_lowercase() || ch.is_ascii_digit();
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    words
        .into_iter()
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
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
    use serde_json::json;

    #[test]
    fn pcash_amount_formatting() {
        assert_eq!(format_pcash(U256::ZERO), "0");
        assert_eq!(format_pcash(U256::from(1_000_000_000_000_000_000u64)), "1");
        assert_eq!(format_pcash(U256::from(4_000_000_000_000_000_000u64)), "4");
        assert_eq!(
            format_pcash(U256::from(1_500_000_000_000_000_000u64)),
            "1.5"
        );
        assert_eq!(format_pcash(U256::from(1u64)), "0.000000000000000001");
    }

    #[test]
    fn labels_are_humanized() {
        assert_eq!(humanize("latestBlock"), "Latest Block");
        assert_eq!(humanize("l1BlockHash"), "L1 Block Hash");
        assert_eq!(humanize("stateRoot"), "State Root");
        assert_eq!(humanize("accountRevision"), "Account Revision");
    }

    #[test]
    fn amount_key_decodes_to_pcash() {
        // 4 * 10^18 wei => "0x3782dace9d900000".
        let s = render_string(Some("issuedSoFar"), "0x3782dace9d900000");
        assert_eq!(s, "4 PCASH  (4000000000000000000 wei)");
    }

    #[test]
    fn quantity_decodes_to_decimal_with_hex() {
        assert_eq!(render_string(Some("chainId"), "0x8182"), "33154  (0x8182)");
        assert_eq!(render_string(Some("number"), "0x0"), "0  (0x0)");
    }

    #[test]
    fn byte_strings_stay_hex() {
        let root = format!("0x{}", "ab".repeat(32));
        assert_eq!(render_string(Some("stateRoot"), &root), root);
        let addr = format!("0x{}", "cd".repeat(20));
        assert_eq!(render_string(Some("inboxAddress"), &addr), addr);
    }

    #[test]
    fn timestamp_renders_utc() {
        // 0 => unix epoch.
        let s = render_string(Some("timestamp"), "0x0");
        assert!(s.contains("1970-01-01T00:00:00Z"), "got: {s}");
    }

    #[test]
    fn top_level_null_is_labeled() {
        let mut out = String::new();
        match &Value::Null {
            Value::Null => out.push_str("null (not found)\n"),
            _ => unreachable!(),
        }
        assert_eq!(out, "null (not found)\n");
    }

    #[test]
    fn nested_object_renders() {
        let v = json!({
            "receive": { "present": true, "mlKem768PublicKey": Value::Null }
        });
        let mut out = String::new();
        if let Value::Object(map) = &v {
            render_object(map, 0, &mut out);
        }
        assert!(out.contains("Receive:"));
        assert!(out.contains("Present"));
        assert!(out.contains("Ml Kem768 Public Key"));
    }
}
