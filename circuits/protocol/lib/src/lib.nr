// The PCASH protocol library: code shared by the node-pinned protocol circuits
// and by applications. Primitives and authenticated state support account
// authentication and the ledger; the kernels prove each action under the
// ledger rules; recursion links the applications, protocol kernels and hiding
// kernels. Installed account rules live outside this crate.
pub mod primitives;
pub mod state;
pub mod authorization;
pub mod ledger;
pub mod kernels;
pub mod recursion;
pub mod generated;
pub mod events;
