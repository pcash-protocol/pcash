// The issuer's Ethereum contracts: the shared deny-list registry and the
// reserve vault that takes deposits and credits and pays redemptions.

export const DENY_LIST_ABI = [
  { type: "function", name: "listIdOf", stateMutability: "pure", inputs: [{ name: "creator", type: "address" }, { name: "salt", type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "lists", stateMutability: "view", inputs: [{ name: "listId", type: "bytes32" }],
    outputs: [{ name: "issuer", type: "address" }, { name: "delta", type: "uint64" }, { name: "paused", type: "bool" }, { name: "root", type: "uint256" }] },
  { type: "function", name: "create", stateMutability: "nonpayable", inputs: [{ name: "salt", type: "bytes32" }, { name: "root", type: "uint256" }, { name: "delta", type: "uint64" }], outputs: [{ name: "listId", type: "bytes32" }] },
  { type: "function", name: "update", stateMutability: "nonpayable",
    inputs: [{ name: "listId", type: "bytes32" }, { name: "added", type: "address[]" }, { name: "removed", type: "address[]" },
      { name: "expectedRoot", type: "uint256" }, { name: "newRoot", type: "uint256" }], outputs: [] },
  { type: "function", name: "setDelta", stateMutability: "nonpayable", inputs: [{ name: "listId", type: "bytes32" }, { name: "delta", type: "uint64" }], outputs: [] },
  { type: "function", name: "pause", stateMutability: "nonpayable", inputs: [{ name: "listId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "unpause", stateMutability: "nonpayable", inputs: [{ name: "listId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "heartbeat", stateMutability: "nonpayable", inputs: [{ name: "listId", type: "bytes32" }], outputs: [] },
  { type: "error", name: "StaleRoot", inputs: [{ name: "listId", type: "bytes32" }, { name: "storedRoot", type: "uint256" }] },
  { type: "error", name: "HeartbeatTooSoon", inputs: [{ name: "listId", type: "bytes32" }, { name: "nextHeartbeatAt", type: "uint256" }] },
] as const;

export const RESERVE_VAULT_ABI = [
  { type: "function", name: "deposit", stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }, { name: "recipientCommitment", type: "bytes32" }, { name: "nonce", type: "bytes32" }], outputs: [] },
  { type: "function", name: "credit", stateMutability: "nonpayable",
    inputs: [{ name: "recipientCommitment", type: "bytes32" }, { name: "nonce", type: "bytes32" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "payout", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }, { name: "redemptionId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "paidOut", stateMutability: "view", inputs: [{ name: "redemptionId", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "credited", stateMutability: "view", inputs: [{ name: "creditId", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowed", stateMutability: "view", inputs: [{ name: "depositor", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "depositCap", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "depositsPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "setAllowed", stateMutability: "nonpayable", inputs: [{ name: "depositor", type: "address" }, { name: "isAllowed", type: "bool" }], outputs: [] },
  { type: "function", name: "setDepositCap", stateMutability: "nonpayable", inputs: [{ name: "newDepositCap", type: "uint256" }], outputs: [] },
  { type: "function", name: "setDepositsPaused", stateMutability: "nonpayable", inputs: [{ name: "paused", type: "bool" }], outputs: [] },
  { type: "event", name: "Deposit", inputs: [
    { name: "depositor", type: "address", indexed: true },
    { name: "recipientCommitment", type: "bytes32", indexed: false },
    { name: "nonce", type: "bytes32", indexed: false },
    { name: "amount", type: "uint256", indexed: false },
  ] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "AmountAboveMaximum", inputs: [{ name: "amount", type: "uint256" }] },
  { type: "error", name: "AmountAboveCap", inputs: [{ name: "amount", type: "uint256" }, { name: "depositCap", type: "uint256" }] },
  { type: "error", name: "NotAllowed", inputs: [{ name: "depositor", type: "address" }] },
  { type: "error", name: "DepositsPaused", inputs: [] },
  { type: "error", name: "NotIssuer", inputs: [] },
  { type: "error", name: "AlreadyPaidOut", inputs: [{ name: "redemptionId", type: "bytes32" }] },
  { type: "error", name: "AlreadyCredited", inputs: [{ name: "recipientCommitment", type: "bytes32" }, { name: "nonce", type: "bytes32" }] },
  { type: "error", name: "ZeroRecipientCommitment", inputs: [] },
  { type: "error", name: "RecipientCommitmentOutOfField", inputs: [] },
  { type: "error", name: "NonceOutOfField", inputs: [] },
] as const;

export const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
] as const;
