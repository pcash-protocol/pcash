import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Test-only key. It must never hold funds or be used outside deterministic fixtures.
export const FIXED_PRIVATE_KEY = `0x${"01".repeat(32)}`;
export const FIXED_CHAIN_ID = 11_155_111n;
export const FIXED_ACCOUNT = privateKeyToAccount(FIXED_PRIVATE_KEY).address;

const SUPPORTED_EVENTS = new Set(["accountsChanged", "chainChanged", "connect", "disconnect", "message"]);

export class ProviderRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "ProviderRpcError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.data === undefined ? {} : { data: this.data }),
    };
  }
}

function normalizeChainId(value) {
  let chainId;
  try {
    if (typeof value === "bigint") chainId = value;
    else if (typeof value === "number" && Number.isSafeInteger(value)) chainId = BigInt(value);
    else if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) chainId = BigInt(value);
  } catch {}
  if (chainId === undefined || chainId <= 0n) {
    throw new TypeError("chainId must be a positive bigint, safe integer, or hexadecimal string");
  }
  return chainId;
}

function chainIdHex(chainId) {
  return `0x${chainId.toString(16)}`;
}

function normalizeAccounts(accounts) {
  if (!Array.isArray(accounts)) throw new TypeError("accounts must be an array");
  const normalized = accounts.map((account) => {
    if (typeof account !== "string") throw new TypeError("account must be an Ethereum address");
    try {
      return getAddress(account);
    } catch {
      throw new TypeError(`invalid Ethereum account: ${account}`);
    }
  });
  const unique = new Set(normalized.map((account) => account.toLowerCase()));
  if (unique.size !== normalized.length) throw new TypeError("accounts must not contain duplicates");
  return normalized;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function sameAccounts(left, right) {
  return left.length === right.length
    && left.every((account, index) => account.toLowerCase() === right[index].toLowerCase());
}

function normalizeRejection(rejection) {
  if (rejection instanceof Error) return rejection;
  if (rejection === undefined) return new ProviderRpcError(4001, "User rejected the request.");
  if (typeof rejection !== "object" || rejection === null) {
    throw new TypeError("rejection must be an Error or an object");
  }
  const { code = 4001, message = "User rejected the request.", data } = rejection;
  if (!Number.isInteger(code) || typeof message !== "string" || message.length === 0) {
    throw new TypeError("rejection requires an integer code and non-empty message");
  }
  return new ProviderRpcError(code, message, clone(data));
}

function typedDataParams(params) {
  if (!Array.isArray(params) || params.length !== 2) {
    throw new ProviderRpcError(-32602, "eth_signTypedData_v4 requires [account, typedDataJson]");
  }
  const [requestedAccount, typedDataJson] = params;
  if (typeof requestedAccount !== "string" || typeof typedDataJson !== "string") {
    throw new ProviderRpcError(-32602, "eth_signTypedData_v4 requires string parameters");
  }
  let account;
  let typedData;
  try {
    account = getAddress(requestedAccount);
    typedData = JSON.parse(typedDataJson);
  } catch {
    throw new ProviderRpcError(-32602, "eth_signTypedData_v4 received invalid parameters");
  }
  if (typeof typedData !== "object" || typedData === null || Array.isArray(typedData)) {
    throw new ProviderRpcError(-32602, "eth_signTypedData_v4 typed data must be an object");
  }
  return { account, typedData };
}

function switchChainParams(params) {
  if (
    !Array.isArray(params)
    || params.length !== 1
    || typeof params[0] !== "object"
    || params[0] === null
    || Array.isArray(params[0])
    || typeof params[0].chainId !== "string"
    || !/^0x[0-9a-fA-F]+$/.test(params[0].chainId)
  ) {
    throw new ProviderRpcError(-32602, "wallet_switchEthereumChain requires [{ chainId: 0x... }]");
  }
  return normalizeChainId(params[0].chainId);
}

/**
 * Deterministic MetaMask-shaped provider for browser journeys.
 *
 * It starts disconnected, exposes one fixed signing account after
 * `eth_requestAccounts`, and can be moved to arbitrary accounts or chains to
 * exercise application invalidation behavior.
 */
export class DeterministicInjectedProvider {
  #account;
  #accounts = [];
  #chainId;
  #listeners = new Map();
  #rejections = new Map();
  #requestLog = [];
  #l1TransactionHash;
  #l1GenesisBlockNumber;
  #l1GenesisBlockHash;
  #sentTransactions = [];
  #broadcastTransaction;

  constructor({
    chainId = FIXED_CHAIN_ID,
    connected = false,
    privateKey = FIXED_PRIVATE_KEY,
    l1TransactionHash = `0x${"ab".repeat(32)}`,
    l1GenesisBlockNumber = "0x1",
    l1GenesisBlockHash = `0x${"11".repeat(32)}`,
    broadcastTransaction,
  } = {}) {
    this.#account = privateKeyToAccount(privateKey);
    this.#broadcastTransaction = broadcastTransaction;
    this.#chainId = normalizeChainId(chainId);
    if (!/^0x[0-9a-fA-F]{64}$/.test(l1TransactionHash)) throw new TypeError("l1TransactionHash must be 32-byte hex");
    if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(l1GenesisBlockNumber)) throw new TypeError("l1GenesisBlockNumber must be a quantity");
    if (!/^0x[0-9a-fA-F]{64}$/.test(l1GenesisBlockHash)) throw new TypeError("l1GenesisBlockHash must be 32-byte hex");
    this.#l1TransactionHash = l1TransactionHash.toLowerCase();
    this.#l1GenesisBlockNumber = l1GenesisBlockNumber.toLowerCase();
    this.#l1GenesisBlockHash = l1GenesisBlockHash.toLowerCase();
    if (connected) this.#accounts = [this.#account.address];
  }

  get selectedAddress() {
    return this.#accounts[0] ?? null;
  }

  get chainId() {
    return this.#chainId;
  }

  get requestLog() {
    return clone(this.#requestLog);
  }

  get sentTransactions() {
    return clone(this.#sentTransactions);
  }

  clearRequestLog() {
    this.#requestLog.length = 0;
  }

  rejectNext(method, rejection) {
    if (typeof method !== "string" || method.length === 0) {
      throw new TypeError("method must be a non-empty string");
    }
    const queue = this.#rejections.get(method) ?? [];
    queue.push(normalizeRejection(rejection));
    this.#rejections.set(method, queue);
  }

  setL1TransactionHash(hash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new TypeError("L1 transaction hash must be 32-byte hex");
    this.#l1TransactionHash = hash.toLowerCase();
  }

  setAccounts(accounts) {
    const next = normalizeAccounts(accounts);
    if (sameAccounts(this.#accounts, next)) return;
    this.#accounts = next;
    this.#emit("accountsChanged", [...next]);
  }

  useFixedAccount() {
    this.setAccounts([this.#account.address]);
  }

  disconnect() {
    this.setAccounts([]);
  }

  setChainId(chainId) {
    const next = normalizeChainId(chainId);
    if (next === this.#chainId) return;
    this.#chainId = next;
    this.#emit("chainChanged", chainIdHex(next));
  }

  on(event, listener) {
    if (!SUPPORTED_EVENTS.has(event)) throw new TypeError(`unsupported provider event ${event}`);
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  removeListener(event, listener) {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  async request(args) {
    if (typeof args !== "object" || args === null || typeof args.method !== "string") {
      throw new ProviderRpcError(-32600, "invalid provider request");
    }
    const { method } = args;
    const params = args.params === undefined ? undefined : clone(args.params);
    this.#requestLog.push({ method, ...(params === undefined ? {} : { params }) });

    const rejections = this.#rejections.get(method);
    if (rejections !== undefined && rejections.length > 0) {
      const rejection = rejections.shift();
      if (rejections.length === 0) this.#rejections.delete(method);
      throw rejection;
    }

    switch (method) {
      case "wallet_requestPermissions":
        if (!Array.isArray(params) || params.length !== 1 || typeof params[0]?.eth_accounts !== "object") {
          throw new ProviderRpcError(-32602, "wallet_requestPermissions requires eth_accounts");
        }
        if (this.#accounts.length === 0) {
          this.useFixedAccount();
          this.#emit("connect", { chainId: chainIdHex(this.#chainId) });
        }
        return [{ parentCapability: "eth_accounts" }];
      case "eth_requestAccounts":
        if (this.#accounts.length === 0) {
          this.useFixedAccount();
          this.#emit("connect", { chainId: chainIdHex(this.#chainId) });
        }
        return [...this.#accounts];
      case "eth_accounts":
        return [...this.#accounts];
      case "eth_chainId":
        return chainIdHex(this.#chainId);
      case "eth_getBlockByNumber":
        if (!Array.isArray(params) || params.length !== 2 || params[0]?.toLowerCase() !== this.#l1GenesisBlockNumber || params[1] !== false) {
          throw new ProviderRpcError(-32602, "eth_getBlockByNumber requested an unknown block");
        }
        return { number: this.#l1GenesisBlockNumber, hash: this.#l1GenesisBlockHash };
      case "wallet_switchEthereumChain":
        this.setChainId(switchChainParams(params));
        return null;
      case "eth_sendTransaction": {
        if (!Array.isArray(params) || params.length !== 1 || typeof params[0] !== "object" || params[0] === null) {
          throw new ProviderRpcError(-32602, "eth_sendTransaction requires one transaction object");
        }
        const transaction = clone(params[0]);
        if (typeof transaction.from !== "string" || transaction.from.toLowerCase() !== this.selectedAddress?.toLowerCase()) {
          throw new ProviderRpcError(4100, "eth_sendTransaction from is not the selected account");
        }
        if (typeof transaction.to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(transaction.to)) {
          throw new ProviderRpcError(-32602, "eth_sendTransaction to is invalid");
        }
        if (typeof transaction.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(transaction.data)) {
          throw new ProviderRpcError(-32602, "eth_sendTransaction data is invalid");
        }
        if (transaction.value !== undefined && (typeof transaction.value !== "string" || !/^0x[0-9a-fA-F]+$/.test(transaction.value))) {
          throw new ProviderRpcError(-32602, "eth_sendTransaction value must be a hex quantity");
        }
        this.#sentTransactions.push(transaction);
        if (this.#broadcastTransaction !== undefined) this.#l1TransactionHash = await this.#broadcastTransaction(transaction);
        return this.#l1TransactionHash;
      }
      case "eth_getTransactionByHash": {
        // The SDK relay engine reads back and verifies the exact broadcast
        // transaction before it will clear its durable latch.
        const requested = typeof params?.[0] === "string" ? params[0].toLowerCase() : "";
        const sent = this.#sentTransactions.at(-1);
        if (sent === undefined || requested !== this.#l1TransactionHash) return null;
        return {
          hash: requested,
          chainId: sent.chainId,
          from: this.selectedAddress,
          to: sent.to,
          input: sent.data,
          nonce: sent.nonce,
          gas: sent.gas,
          maxFeePerGas: sent.maxFeePerGas,
          maxPriorityFeePerGas: sent.maxPriorityFeePerGas,
          value: sent.value,
          type: sent.type,
        };
      }
      case "eth_signTypedData_v4":
        return this.#signTypedData(params);
      default:
        throw new ProviderRpcError(4200, `Unsupported provider method: ${method}`);
    }
  }

  async #signTypedData(params) {
    const { account, typedData } = typedDataParams(params);
    const selected = this.#accounts[0];
    if (selected === undefined) {
      throw new ProviderRpcError(4100, "The fixture account is not connected.");
    }
    if (selected.toLowerCase() !== account.toLowerCase()) {
      throw new ProviderRpcError(4100, "The requested account is not selected.");
    }
    if (account.toLowerCase() !== this.#account.address.toLowerCase()) {
      throw new ProviderRpcError(4100, "The selected account has no fixture signing key.");
    }
    return this.#account.signTypedData(typedData);
  }

  #emit(event, value) {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(clone(value));
  }
}
