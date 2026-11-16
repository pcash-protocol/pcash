// secp256k1 and EIP-712 for applications: the reference rules, the test
// fixtures and the marketplace reclaim circuit. No consensus circuit uses it.
pub mod secp256k1;
pub mod eip712;

// Regression gate for the vendored Keccak primitive this library depends on.
mod keccak_boundary;
