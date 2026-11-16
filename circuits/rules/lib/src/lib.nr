// The reference account rules' shared library: the owner binding, the signed
// value message, the value relations and the rules built from them, and the
// payout and output-secret derivation wallets use to recover notes. The rule
// mains, the test fixtures and the marketplace and token contracts build on it;
// nothing here is consensus.
pub mod asset_covenant;
pub mod asset_creation;
pub mod batch_transfer;
pub mod composite;
pub mod configuration;
pub mod contract_fee_sponsorship;
pub mod generated;
pub mod issuance_opening;
pub mod message;
pub mod owner;
pub mod payout;
pub mod test_support;
pub mod value_rule;
