// The PCASH node RPC surface. This layer deliberately depends on protocol shapes
// only — never on the witness builders — so an application that just reads chain
// state does not pull the proving stack.

export { nodeRpc, PcashNodeRpcError, type NodeRpcOptions } from "./jsonRpc.ts";
export * from "./nodeClient.ts";
export * from "./receipts.ts";
export * from "./pscanClient.ts";
export * from "./statusIdentity.ts";
export * from "./admission.ts";

// ./adminClient.ts is deliberately absent: this index is re-exported by the
// browser barrel, and the operator-only `admin_*` listener is not browser-facing.
// It is exported from ../node/index.ts instead, so it reaches an application
// through @pcash/sdk or @pcash/sdk/node and never through @pcash/sdk/browser.

export * from "./resultProof.ts";
