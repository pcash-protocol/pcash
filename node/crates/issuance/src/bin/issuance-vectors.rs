//! Emit or check exact bounded-memory ASERT conformance vectors.
#![allow(clippy::print_stdout, reason = "conformance command writes JSON")]

use alloy_primitives::{I256, U256};
use pcash_issuance::IssuanceState;
use serde_json::{json, Value};
use std::{error::Error, path::PathBuf};

fn row(name: &str, parent: IssuanceState, elapsed_seconds: u64, actions: u64) -> Value {
    let terms = pcash_issuance::block_terms(parent, elapsed_seconds);
    let quote = terms.quote;
    let result = pcash_issuance::settle(terms, actions);
    json!({
        "name": name,
        "parent": {
            "issuedSoFar": parent.issued_so_far.to_string(),
            "lagQ": parent.lag_q.to_string(),
        },
        "elapsedSeconds": elapsed_seconds,
        "qualifyingActions": actions,
        "quote": {
            "baseline": quote.baseline.to_string(),
            "internalOffer": quote.internal_offer.to_string(),
            "blockAllowance": quote.block_allowance.to_string(),
            "maxSingleActionReward": quote.max_single_action_reward.to_string(),
            "multiplierQ": quote.multiplier_q.to_string(),
            "rewardPossible": quote.reward_possible(),
            "exhausted": quote.exhausted,
        },
        "result": {
            "issuedSoFar": result.state.issued_so_far.to_string(),
            "lagQ": result.state.lag_q.to_string(),
            "rewardEach": result.reward_each.to_string(),
            "newIssuance": result.new_issuance.to_string(),
        },
    })
}

fn vectors() -> Value {
    let initial = pcash_issuance::initial_state();
    let q = pcash_issuance::scale();
    let cap = pcash_issuance::supply_cap();
    let mut rows = vec![
        row("genesis-empty", initial, 0, 0),
        row("genesis-one", initial, 0, 1),
        row("genesis-65", initial, 0, 65),
        row("idle-30-days", initial, 30 * 86_400, 1),
        row("idle-90-days", initial, 90 * 86_400, 1),
        row(
            "seventy-five-percent",
            IssuanceState {
                issued_so_far: cap * U256::from(3) / U256::from(4),
                lag_q: I256::ZERO,
            },
            0,
            1,
        ),
        row(
            "remaining-smaller-than-count",
            IssuanceState {
                issued_so_far: cap - U256::from(3),
                lag_q: I256::ZERO,
            },
            0,
            4,
        ),
        row(
            "final-three-atoms",
            IssuanceState {
                issued_so_far: cap - U256::from(3),
                lag_q: I256::ZERO,
            },
            0,
            1,
        ),
        row(
            "exhausted",
            IssuanceState {
                issued_so_far: cap,
                lag_q: I256::from_raw(q),
            },
            u64::MAX,
            1,
        ),
    ];
    let lag = |magnitude: U256, negative: bool| {
        if negative {
            I256::ZERO - I256::from_raw(magnitude)
        } else {
            I256::from_raw(magnitude)
        }
    };
    let at_lag = |lag_q: I256| IssuanceState {
        issued_so_far: U256::ZERO,
        lag_q,
    };
    for (name, days) in [
        ("lag-minus-six-days", -6_i64),
        ("lag-minus-four-days", -4_i64),
        ("lag-minus-two-days", -2_i64),
        ("lag-zero", 0_i64),
        ("lag-plus-two-days", 2_i64),
        ("lag-plus-four-days", 4_i64),
    ] {
        let magnitude = q * U256::from(days.unsigned_abs() * 86_400);
        rows.push(row(name, at_lag(lag(magnitude, days < 0)), 0, 0));
    }
    rows.push(row(
        "lag-plus-four-days-minus-one",
        at_lag(lag(q * U256::from(4 * 86_400u64) - U256::from(1), false)),
        0,
        1,
    ));
    // One Q16 exponent step is H * Q / 65536 Q128 seconds.
    let step = q * U256::from(2 * 86_400u64) / U256::from(65_536u64);
    for (name, magnitude) in [
        ("exponent-step-minus-one", step - U256::from(1)),
        ("exponent-step", step),
        ("exponent-step-plus-one", step + U256::from(1)),
    ] {
        rows.push(row(name, at_lag(lag(magnitude, false)), 0, 1));
        rows.push(row(
            &format!("negative-{name}"),
            at_lag(lag(magnitude, true)),
            0,
            1,
        ));
    }
    let underflow = q * U256::from(128 * 2 * 86_400u64);
    for (name, magnitude) in [
        ("underflow-above", underflow - U256::from(1)),
        ("underflow-boundary", underflow),
        ("underflow-below", underflow + U256::from(1)),
    ] {
        rows.push(row(name, at_lag(lag(magnitude, true)), 0, 1));
    }
    rows.push(row(
        "underflow-recovery",
        at_lag(lag(underflow + U256::from(1), true)),
        200 * 86_400,
        1,
    ));
    let mut state = initial;
    for (index, (elapsed, actions)) in [(12, 65), (12, 1), (3 * 86_400, 0), (12, 65)]
        .into_iter()
        .enumerate()
    {
        rows.push(row(&format!("trajectory-{index}"), state, elapsed, actions));
        state = pcash_issuance::transition(state, elapsed, actions).state;
    }
    json!({
        "supplyCap": cap.to_string(),
        "exponentRadix": pcash_issuance::EXPONENT_RADIX,
        "fractionBits": 128,
        "vectors": rows,
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let actual = vectors();
    match args.as_slice() {
        [] => println!("{}", serde_json::to_string_pretty(&actual)?),
        [flag, path] if flag == "--check" => {
            let expected: Value = serde_json::from_slice(&std::fs::read(PathBuf::from(path))?)?;
            if actual != expected {
                return Err("issuance conformance vectors differ".into());
            }
            println!("Issuance conformance vectors match.");
        }
        [flag, path] if flag == "--write" => {
            std::fs::write(
                path,
                format!("{}\n", serde_json::to_string_pretty(&actual)?),
            )?;
        }
        _ => return Err("usage: issuance-vectors [--check path | --write path]".into()),
    }
    Ok(())
}
