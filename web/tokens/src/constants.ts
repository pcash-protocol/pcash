// Token template domain tags, derived from their context strings as protocol
// domain tags are (`domainTag` in @pcash/sdk/crypto).
// They are application tags, not protocol tags, so they live here rather than
// in the SDK's generated table.

import { functionSelector } from "@pcash/sdk/protocol";

/** "tokens_link_set": a creator's link-set secret from its nullifier key root and a per-set nonce. */
export const TOKENS_LINK_SET_DOMAIN =
  0x2136ab164ff6331426cc99670368a5a3d6f656de7b16e498df7afa47e7e1a9b2n;
/** "tokens_link_contract_seed": a creator secret's claim-link contract seed. */
export const TOKENS_LINK_CONTRACT_SEED_DOMAIN =
  0x119b61cc55c0122d68d341d625428a7063c6cf64b3cba8b04b28f888f6e5edc5n;
/** "tokens_link_contract": a contract seed's configuration salt and published nkRoot. */
export const TOKENS_LINK_CONTRACT_DOMAIN =
  0x200e9e25eb31397aa8a3d96610eb758fdbad40e715002488bfd007e1796c0bd9n;
/** "tokens_link_key": a creator secret's link key at one index. */
export const TOKENS_LINK_KEY_DOMAIN =
  0x0481db7f0d28b006917076e3a3ad9870af9883902efc476e3a2b7bb440cc0120n;
/** "tokens_link_note_secret": the inventory note secret a link key opens. */
export const TOKENS_LINK_NOTE_SECRET_DOMAIN =
  0x2d936b0a819526fb5c560b443a35af181d22173b235563d5f44203411758d2ean;
/** "tokens_drop_contract": a drop seed's configuration salt and published nkRoot. */
export const TOKENS_DROP_CONTRACT_DOMAIN =
  0x06666ee2875cdf481a955f5166a79c1b130b2185b44a51ba67beb3a422122e0en;
/** "tokens_drop_inventory": a drop seed's public inventory note secret at one index. */
export const TOKENS_DROP_INVENTORY_DOMAIN =
  0x1316a8690b8d6f68a17b966d37a3a26081d4860ca579428c3929e753360dfd8bn;
/** "tokens_drop_claim_replay": the claim marker's replay identity (drop claim circuit). */
export const TOKENS_DROP_CLAIM_REPLAY_DOMAIN =
  0x00ca2e65b236277231667c9bf62a4e31949880a58c502f1af362294f35f22243n;

export const CLAIM_LINK_FUNCTION_SELECTOR = functionSelector(0);
export const DROP_CLAIM_FUNCTION_SELECTOR = functionSelector(0);
export const DROP_RECLAIM_FUNCTION_SELECTOR = functionSelector(1);
