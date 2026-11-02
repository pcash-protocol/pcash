#![allow(
    clippy::expect_used,
    reason = "tests use direct assertions for fixture setup"
)]
//! Preset selection fails at the configuration boundary, before startup I/O.

use std::process::{Command, Output};

fn launch(network: &str, extra_env: Option<(&str, &str)>, data_dir: &std::path::Path) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pcash-node"));
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("PCASH_") {
            command.env_remove(key);
        }
    }
    command
        .args([
            "--l1-rpc",
            "http://127.0.0.1:1",
            "--beacon-api",
            "http://127.0.0.1:1",
            "--data-dir",
        ])
        .arg(data_dir)
        .env("PCASH_NETWORK", network);
    if let Some((key, value)) = extra_env {
        command.env(key, value);
    }
    command.output().expect("run node CLI")
}

#[test]
fn mainnet_env_selection_rejects_the_unset_anchor_before_opening_state() {
    let parent = tempfile::tempdir().expect("temporary directory");
    let data_dir = parent.path().join("state");
    let output = launch("mainnet", None, &data_dir);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("mainnet genesis anchor is not configured"),
        "{stderr}"
    );
    assert!(!data_dir.exists());
}

#[test]
fn presets_reject_identity_overrides_from_the_environment() {
    let parent = tempfile::tempdir().expect("temporary directory");
    let data_dir = parent.path().join("state");
    for network in ["mainnet", "testnet"] {
        for pair in [
            (
                "PCASH_INBOX_ADDRESS",
                "0x1111111111111111111111111111111111111111",
            ),
            ("PCASH_GENESIS_L1_BLOCK", "1"),
            (
                "PCASH_GENESIS_L1_BLOCK_HASH",
                "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ),
        ] {
            let output = launch(network, Some(pair), &data_dir);
            assert!(!output.status.success());
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(
                stderr.contains("cannot be used with"),
                "{}: {stderr}",
                pair.0
            );
            assert!(!data_dir.exists());
        }
    }
}
