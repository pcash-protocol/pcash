// Forced include for bbapi sources in the guest build. The Chonk batch
// verifier service needs POSIX FIFOs, signals and threads, so bbapi is built
// the way bb builds it for wasm: bbapi_shared.hpp is read once here and its
// BB_HAS_BATCH_VERIFIER_SERVICE is withdrawn before bbapi_chonk.hpp sees it.
#pragma once
#include "barretenberg/bbapi/bbapi_shared.hpp"
#undef BB_HAS_BATCH_VERIFIER_SERVICE
