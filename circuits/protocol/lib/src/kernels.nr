// The private-value kernels and the fixed-supply relation of the asset-creation
// kernel. Each kernel keeps its own conservation and authorization rules over
// the shared private-value section, and all converge on the same private-value
// hiding kernel.
pub mod transfer;
pub mod sponsored_transfer;
pub mod asset_creation;
pub mod fixed_supply;
