// The operator-only `admin_*` JSON-RPC listener (`--admin-addr`), reached by
// URL. It is a third socket, distinct from the `pcash_*` node endpoint and the
// `pscan_*` source listener, and it is deliberately not browser-facing: it
// carries no CORS layer, refuses WebSocket upgrades, and is unauthenticated, so
// its bind address is its access control.
//
// Operator source publication lives here rather than on the `pscan_*` listener
// because it writes to the node's registry under operator provenance, under
// none of the bounds the permissionless submission channel puts on anonymous
// callers.

import { nodeRpc, SOURCE_PUBLICATION_MAX_BODY_BYTES, type NodeRpcOptions } from "./jsonRpc.ts";
import {
  parseSourceVerificationInfo,
  type SourceVerificationInfo,
  type SourceVerificationPublication,
} from "./pscanClient.ts";

/** The named surface of the operator-only `admin_*` JSON-RPC listener. */
export interface AdminClient {
  publishSourceVerification(publication: SourceVerificationPublication): Promise<SourceVerificationInfo>;
}

/**
 * A client for the operator-only `admin_*` listener — pass its URL, not the
 * node RPC URL and not the `pscan_*` URL.
 */
export function createAdminClient(url: string, options: NodeRpcOptions = {}): AdminClient {
  const rpc = nodeRpc(url, SOURCE_PUBLICATION_MAX_BODY_BYTES, options);
  return {
    async publishSourceVerification(publication): Promise<SourceVerificationInfo> {
      return parseSourceVerificationInfo(
        await rpc("admin_publishSourceVerification", [publication]),
        "publishSourceVerification",
      );
    },
  };
}
