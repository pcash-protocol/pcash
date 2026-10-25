#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for frozen vectors"
)]

use pcash_derive::private_value_profiles::S;
use pcash_derive::{
    AdmittedTransaction, ProofStatement, ProtocolRules, SectionLayout, Transaction,
};
use pcash_state::CircuitWord;
use serde_json::Value;

fn words(value: &Value) -> Vec<CircuitWord> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|word| word.as_str().unwrap().parse().unwrap())
        .collect()
}

#[test]
fn frozen_cross_language_account_section_vectors() {
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../vectors/account_sections");
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../vectors/account_sections/vectors.json"
    ))
    .unwrap();
    let chain_id = u32::try_from(vectors["chainId"].as_u64().unwrap()).unwrap();
    for vector in vectors["vectors"].as_array().unwrap() {
        // Neither the encoder nor the decoder produces the expected side.
        // The SDK consumes the same checked-in bytes and statement words.
        let bytes =
            std::fs::read(directory.join(vector["transactionFile"].as_str().unwrap())).unwrap();
        assert_eq!(
            bytes.len() as u64,
            vector["transactionBytes"].as_u64().unwrap()
        );
        let transaction = Transaction::decode(&bytes, chain_id).unwrap();
        assert_eq!(
            u64::from(transaction.kind()),
            vector["kind"].as_u64().unwrap()
        );
        let section = match &transaction {
            Transaction::ContractAccountCreation(creation) => {
                creation.section().expect("sponsored section")
            }
            Transaction::UserAccountUpdate(update) => &update.section,
            _ => panic!("account section required"),
        };
        let expected = words(&vector["statementWords"]);
        assert_eq!(expected.len(), S.public_inputs + 1);
        let rules = ProtocolRules::new([vec![], vec![]], vec![], vec![]);
        let admitted = AdmittedTransaction::decode(&bytes, chain_id).unwrap();
        let statement = ProofStatement::of(&rules, &admitted).expect("a canonical statement");
        assert_eq!(
            statement.public_inputs,
            expected
                .iter()
                .flat_map(|word| word.to_vec())
                .collect::<Vec<_>>()
        );
        let public_inputs = section.public_inputs();
        assert_eq!(public_inputs, expected[..S.public_inputs]);
        assert_eq!(
            public_inputs.iter().filter(|word| word.is_zero()).count(),
            1
        );
        assert_eq!(public_inputs[S.issuance_owner_offset], CircuitWord::ZERO);

        // The wire omits the chain ID, the delivery commitment, and the
        // issuance word.
        let wire_words = words(&vector["wireWords"]);
        let wire_count = SectionLayout::UserAccountUpdate.wire_inputs();
        assert_eq!(
            wire_count,
            SectionLayout::ContractAccountCreation.wire_inputs()
        );
        assert_eq!(wire_words.len(), wire_count);
        let dc = S.delivery_commitment_offset;
        let issuance = S.issuance_owner_offset;
        assert_eq!(public_inputs[1..dc], wire_words[..dc - 1]);
        assert_eq!(
            public_inputs[dc + 1..issuance],
            wire_words[dc - 1..issuance - 2]
        );
        assert_eq!(public_inputs[issuance + 1..], wire_words[issuance - 2..]);
        let offset = usize::try_from(vector["sectionOffset"].as_u64().unwrap()).unwrap();
        let frozen_wire = wire_words
            .iter()
            .flat_map(|word| word.to_vec())
            .collect::<Vec<_>>();
        assert_eq!(&bytes[offset..offset + wire_count * 32], frozen_wire);
        assert_eq!(transaction.encode(chain_id).unwrap(), bytes);
    }
}
