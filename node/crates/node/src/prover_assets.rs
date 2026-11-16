use std::collections::BTreeSet;
use std::path::Path;

use eyre::Context;
use pcash_rpc::ProverAssetsDto;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserProverManifest {
    version: u32,
    asset_set_id: String,
    artifacts: Vec<BrowserProverArtifact>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserProverArtifact {
    bytes: u64,
    path: String,
    sha256: String,
}

#[derive(Serialize)]
struct BrowserProverIdentity<'a> {
    artifacts: &'a [BrowserProverArtifact],
    version: u32,
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(*byte, b'a'..=b'f'))
}

fn validate_manifest(manifest: &BrowserProverManifest) -> eyre::Result<()> {
    if manifest.version != 1 {
        eyre::bail!("browser prover manifest version must be 1");
    }
    if !lowercase_sha256(&manifest.asset_set_id) {
        eyre::bail!("browser prover manifest assetSetId must be lowercase SHA-256 hex");
    }
    if manifest.artifacts.is_empty() {
        eyre::bail!("browser prover manifest must contain at least one artifact");
    }
    let mut paths = BTreeSet::new();
    let mut previous: Option<&str> = None;
    for artifact in &manifest.artifacts {
        if !matches!(
            artifact.path.as_str(),
            path if path.starts_with("/prover/")
                || path.starts_with("/chonk-vks/")
                || path.starts_with("/crs/")
        ) || artifact.path.starts_with("//")
            || artifact.path.ends_with('/')
            || artifact.path.contains('\\')
            || artifact
                .path
                .split('/')
                .any(|part| part == "." || part == "..")
        {
            eyre::bail!("browser prover artifact path is not a canonical logical key");
        }
        if !paths.insert(artifact.path.as_str()) {
            eyre::bail!("browser prover artifact paths must be unique");
        }
        if previous.is_some_and(|path| path >= artifact.path.as_str()) {
            eyre::bail!("browser prover artifacts must be sorted by logical path");
        }
        if artifact.bytes == 0 {
            eyre::bail!("browser prover artifact byte length must be positive");
        }
        if !lowercase_sha256(&artifact.sha256) {
            eyre::bail!("browser prover artifact sha256 must be lowercase hex");
        }
        previous = Some(&artifact.path);
    }
    let identity = serde_json::to_vec(&BrowserProverIdentity {
        artifacts: &manifest.artifacts,
        version: manifest.version,
    })?;
    let actual = hex::encode(Sha256::digest(identity));
    if actual != manifest.asset_set_id {
        eyre::bail!("browser prover manifest assetSetId does not match its canonical contents");
    }
    Ok(())
}

fn normalized_root(value: &str) -> eyre::Result<String> {
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        eyre::bail!(
            "prover assets base URL must be non-empty and contain no surrounding whitespace"
        );
    }
    if value.starts_with('/') {
        if value.starts_with("//")
            || value
                .chars()
                .any(|character| matches!(character, '?' | '#' | '\\'))
            || value.split('/').any(|part| part == "." || part == "..")
        {
            eyre::bail!("relative prover assets base URL must be an absolute path without query or fragment");
        }
        return Ok(if value.ends_with('/') {
            value.to_owned()
        } else {
            format!("{value}/")
        });
    }

    let mut url = reqwest::Url::parse(value).wrap_err("parse prover assets base URL")?;
    if url.host_str().is_none() {
        eyre::bail!("absolute prover assets base URL must have a host");
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        eyre::bail!("prover assets base URL must not contain credentials, query, or fragment");
    }
    let localhost = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && localhost) {
        eyre::bail!("prover assets base URL must use HTTPS, except for localhost development");
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url.to_string())
}

/// Read and validate the packaged public manifest once, then derive the advertised set URL.
pub fn load_prover_assets(path: &Path, base_url: &str) -> eyre::Result<ProverAssetsDto> {
    let bytes = std::fs::read(path)
        .wrap_err_with(|| format!("read browser prover manifest {}", path.display()))?;
    let manifest: BrowserProverManifest = serde_json::from_slice(&bytes)
        .wrap_err_with(|| format!("parse browser prover manifest {}", path.display()))?;
    validate_manifest(&manifest)?;
    let root = normalized_root(base_url)?;
    Ok(ProverAssetsDto {
        base_url: format!("{root}{}/", manifest.asset_set_id),
        asset_set_id: manifest.asset_set_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> serde_json::Value {
        let artifacts = serde_json::json!([{
            "path": "/prover/example.json",
            "bytes": 12,
            "sha256": "11".repeat(32),
        }]);
        let identity = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "artifacts": artifacts,
        }))
        .unwrap();
        serde_json::json!({
            "version": 1,
            "assetSetId": hex::encode(Sha256::digest(identity)),
            "artifacts": artifacts,
        })
    }

    fn write_manifest(value: &serde_json::Value) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("manifest.json");
        std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        (dir, path)
    }

    #[test]
    fn loads_identity_and_appends_it_to_relative_root() {
        let value = manifest();
        let expected = value["assetSetId"].as_str().unwrap().to_owned();
        let (_dir, path) = write_manifest(&value);
        let result = load_prover_assets(&path, "/proving").unwrap();
        assert_eq!(result.asset_set_id, expected);
        assert_eq!(result.base_url, format!("/proving/{expected}/"));
    }

    #[test]
    fn accepts_https_and_localhost_http_but_rejects_credentials() {
        let value = manifest();
        let expected = value["assetSetId"].as_str().unwrap().to_owned();
        let (_dir, path) = write_manifest(&value);
        assert_eq!(
            load_prover_assets(&path, "https://assets.example/proving")
                .unwrap()
                .base_url,
            format!("https://assets.example/proving/{expected}/")
        );
        assert!(load_prover_assets(&path, "http://localhost:8080/proving").is_ok());
        assert!(load_prover_assets(&path, "https://user:secret@assets.example/proving").is_err());
        assert!(load_prover_assets(&path, "http://assets.example/proving").is_err());
    }

    #[test]
    fn rejects_tampered_identity_and_invalid_artifact_order() {
        let mut value = manifest();
        value["assetSetId"] = serde_json::Value::String("22".repeat(32));
        let (_dir, path) = write_manifest(&value);
        assert!(load_prover_assets(&path, "/proving/").is_err());

        let mut value = manifest();
        value["artifacts"] = serde_json::json!([
            { "path": "/prover/z.json", "bytes": 1, "sha256": "11".repeat(32) },
            { "path": "/prover/a.json", "bytes": 1, "sha256": "22".repeat(32) },
        ]);
        let (_dir, path) = write_manifest(&value);
        assert!(load_prover_assets(&path, "/proving/").is_err());
    }

    #[test]
    fn checked_in_release_descriptor_uses_the_same_canonical_identity() {
        let manifest: BrowserProverManifest = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../assets/browser-prover-release.json"
        )))
        .unwrap();
        validate_manifest(&manifest).unwrap();
    }
}
