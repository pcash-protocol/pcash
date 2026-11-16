//! The range program's proof verifier against the node's, on the circuit
//! bundle's known answers for each hiding kernel (what a node checks its
//! verifier against at startup) and on altered copies of one. A disagreement
//! would let the contract accept a chain nodes reject, or stop it at the
//! transaction.

use std::path::Path;

use eyre::{ensure, eyre, Result};
use pcash_verify::{BbProcessVerifier, Verifier};
use sp1_sdk::blocking::{Prover, ProverClient};
use sp1_sdk::{Elf, SP1Stdin};

struct Case {
    name: String,
    vk: Vec<u8>,
    proof: Vec<u8>,
    public_inputs: Vec<u8>,
}

struct KnownAnswer {
    name: String,
    vk: Vec<u8>,
    proof: Vec<u8>,
    rejected: Vec<u8>,
    public_inputs: Vec<u8>,
}

/// The bundle's known answers whose name is a hiding kernel's.
fn known_answers(bundle: &Path) -> Result<Vec<KnownAnswer>> {
    let mut names: Vec<String> = std::fs::read_dir(bundle.join("known-answers"))?
        .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
        .collect::<Result<_>>()?;
    names.sort();
    let mut answers = Vec::new();
    for name in names {
        let vk = bundle.join("vks").join(format!("{name}_hiding_kernel.chonk.vk"));
        if !vk.exists() {
            continue;
        }
        let dir = bundle.join("known-answers").join(&name);
        answers.push(KnownAnswer {
            vk: std::fs::read(vk)?,
            proof: std::fs::read(dir.join("proof"))?,
            rejected: std::fs::read(dir.join("proof.rejected"))?,
            public_inputs: std::fs::read(dir.join("public_inputs"))?,
            name,
        });
    }
    ensure!(answers.len() > 1, "{}: fewer than two hiding kernel known answers", bundle.display());
    Ok(answers)
}

fn cases(answers: &[KnownAnswer]) -> Vec<Case> {
    let case = |name: String, vk: &[u8], proof: &[u8], public_inputs: &[u8]| Case {
        name,
        vk: vk.to_vec(),
        proof: proof.to_vec(),
        public_inputs: public_inputs.to_vec(),
    };
    let mut cases = Vec::new();
    for answer in answers {
        cases.push(case(format!("{} accepted", answer.name), &answer.vk, &answer.proof, &answer.public_inputs));
        cases.push(case(format!("{} rejected", answer.name), &answer.vk, &answer.rejected, &answer.public_inputs));
    }
    let (first, other) = (&answers[0], &answers[1]);
    let mut flipped = first.proof.clone();
    flipped[first.proof.len() / 2] ^= 1;
    let mut altered_inputs = first.public_inputs.clone();
    *altered_inputs.last_mut().expect("public inputs") ^= 1;
    let altered = [
        ("truncated", first.vk.clone(), first.proof[..first.proof.len() - 32].to_vec(), first.public_inputs.clone()),
        ("with a flipped byte", first.vk.clone(), flipped, first.public_inputs.clone()),
        ("empty", first.vk.clone(), Vec::new(), first.public_inputs.clone()),
        ("under another kernel's key", other.vk.clone(), first.proof.clone(), first.public_inputs.clone()),
        ("with altered public inputs", first.vk.clone(), first.proof.clone(), altered_inputs),
    ];
    for (how, vk, proof, public_inputs) in altered {
        cases.push(case(format!("{} {how}", first.name), &vk, &proof, &public_inputs));
    }
    cases
}

fn verdict(answer: Option<bool>) -> &'static str {
    match answer {
        Some(true) => "accepted",
        Some(false) => "rejected",
        None => "fault",
    }
}

/// Run the verifier program at `elf` and the node's verifier on the same
/// cases, and require the same answer to each.
pub fn run(elf: &Path, bundle: &Path) -> Result<()> {
    let cases = cases(&known_answers(bundle)?);
    let node = BbProcessVerifier::from_env()?;
    let native: Vec<Option<bool>> = cases
        .iter()
        .map(|case| node.verify(&case.vk, &case.proof, &case.public_inputs).ok())
        .collect();

    let client = ProverClient::builder().mock().build();
    let elf = Elf::from(std::sync::Arc::<[u8]>::from(std::fs::read(elf)?));
    let mut stdin = SP1Stdin::new();
    stdin.write(
        &cases
            .iter()
            .map(|case| (case.vk.clone(), case.proof.clone(), case.public_inputs.clone()))
            .collect::<Vec<_>>(),
    );
    let (mut public_values, report) = client.execute(elf, stdin).run().map_err(|error| eyre!("{error}"))?;
    ensure!(report.exit_code == 0, "the verifier program exited with code {}", report.exit_code);
    let program: Vec<Option<bool>> = public_values.read();
    ensure!(program.len() == cases.len(), "the program answered {} of {} cases", program.len(), cases.len());

    let mut disagreements = 0;
    for ((case, node), program) in cases.iter().zip(&native).zip(&program) {
        let same = node == program;
        disagreements += usize::from(!same);
        println!(
            "{}: node {}, program {}{}",
            case.name,
            verdict(*node),
            verdict(*program),
            if same { "" } else { "  DISAGREE" }
        );
    }
    ensure!(disagreements == 0, "{disagreements} cases where the program and the node disagree");
    println!("{} cases, {} cycles", cases.len(), report.total_instruction_count());
    Ok(())
}
