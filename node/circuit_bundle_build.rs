use std::error::Error;
use std::io;
use std::path::PathBuf;
use std::process::Command;

fn run_resolver(resolver: &PathBuf, arg: &str) -> Result<String, Box<dyn Error>> {
    let output = Command::new("node")
        .arg(resolver)
        .arg(arg)
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "resolve circuit bundle: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
        .into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-env-changed=PCASH_CIRCUIT_BUNDLE");
    println!("cargo:rerun-if-env-changed=PCASH_CIRCUIT_CACHE");
    println!("cargo:rerun-if-env-changed=PCASH_CIRCUIT_KAT_SET");

    let manifest_dir = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR")
            .ok_or_else(|| io::Error::other("CARGO_MANIFEST_DIR is not set"))?,
    );
    let resolver = manifest_dir.join("../../../scripts/circuits/bundle.mjs");
    for input in run_resolver(&resolver, "--print-inputs")?.lines() {
        if !input.trim().is_empty() {
            println!("cargo:rerun-if-changed={input}");
        }
    }

    let stdout = run_resolver(&resolver, "--print-path")?;
    let bundle = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| io::Error::other("circuit bundle resolver returned no path"))?
        .trim();
    println!("cargo:rerun-if-changed={bundle}/bundle-manifest.json");
    println!("cargo:rustc-env=PCASH_CIRCUIT_BUNDLE={bundle}");
    Ok(())
}
