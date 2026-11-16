//! Link bb's CHONK verifier, cross-compiled with SP1's rv64im GCC with C++
//! exceptions, and its C++ runtime (libgcc carries the unwinder, libstdc++ the
//! exception support); and require the circuit bundle the node compiles its
//! keys from. `build-guest.sh` sets the variables.
//!
//! `CHONK_LIB` is the directory holding `libchonk.a`; `SP1_GCC` is the root of
//! SP1's riscv toolchain; `PCASH_CIRCUIT_BUNDLE` is the resolved bundle path.
use std::path::{Path, PathBuf};
use std::process::Command;

/// The directory of a library SP1's GCC links.
fn gcc_library_dir(gcc: &str, library: &str) -> PathBuf {
    let output = Command::new(format!("{gcc}/bin/riscv64-unknown-elf-gcc"))
        .arg(format!("-print-file-name={library}"))
        .output()
        .expect("riscv64-unknown-elf-gcc");
    let path = String::from_utf8(output.stdout).expect("UTF-8 path");
    Path::new(path.trim()).parent().expect("library directory").to_path_buf()
}

fn main() {
    let lib = std::env::var("CHONK_LIB").expect("CHONK_LIB");
    let gcc = std::env::var("SP1_GCC").expect("SP1_GCC");
    let bundle = std::env::var("PCASH_CIRCUIT_BUNDLE").expect("PCASH_CIRCUIT_BUNDLE");
    for var in ["CHONK_LIB", "SP1_GCC", "PCASH_CIRCUIT_BUNDLE", "CHONK_CRS"] {
        println!("cargo:rerun-if-env-changed={var}");
    }
    println!("cargo:rerun-if-changed={lib}/libchonk.a");
    println!("cargo:rerun-if-changed={bundle}/bundle-manifest.json");
    println!("cargo:rustc-link-search=native={lib}");
    println!("cargo:rustc-link-lib=static=chonk");
    for library in ["libstdc++.a", "libgcc.a"] {
        println!("cargo:rustc-link-search=native={}", gcc_library_dir(&gcc, library).display());
    }
    for lib in ["stdc++", "c", "gcc"] {
        println!("cargo:rustc-link-lib=static={lib}");
    }
    // newlib's libc also defines memcpy and a few math functions sp1-zkvm
    // exports; keep sp1-zkvm's.
    println!("cargo:rustc-link-arg=--allow-multiple-definition");
    // PT_GNU_EH_FRAME is how `eh::register_frames` finds `.eh_frame`.
    println!("cargo:rustc-link-arg=--eh-frame-hdr");
}
