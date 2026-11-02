//! The range program's proof verifier on its own: for each (verification key,
//! proof, public inputs) read, whether it accepts, rejects or faults. The host
//! compares the answers with the node's verifier (`derivation-proof-host
//! verdicts`).
#![no_main]
sp1_zkvm::entrypoint!(main);

#[path = "../crt.rs"]
mod crt;
#[path = "../eh.rs"]
mod eh;
#[path = "../verifier.rs"]
mod verifier;

use pcash_verify::Verifier;

pub fn main() {
    let cases: Vec<(Vec<u8>, Vec<u8>, Vec<u8>)> = sp1_zkvm::io::read();
    let verifier = verifier::Chonk::new();
    let verdicts: Vec<Option<bool>> = cases
        .iter()
        .map(|(vk, proof, public_inputs)| verifier.verify(vk, proof, public_inputs).ok())
        .collect();
    sp1_zkvm::io::commit(&verdicts);
}
