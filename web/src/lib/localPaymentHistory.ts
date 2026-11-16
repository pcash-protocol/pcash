const memory = new Map<string, LocalPaymentHistory>();

export interface LocalPaymentHistory { known: string[]; pending: string[] }
export function localPaymentHistoryKey(network: { pcashChainId: bigint | number; l1ChainId: bigint | number; genesisHash: string }, address: string): string {
  return `pcash:local-payments:${network.pcashChainId}:${network.l1ChainId}:${network.genesisHash.toLowerCase()}:${address.toLowerCase()}`;
}
export function readLocalPaymentHistory(key: string): LocalPaymentHistory {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return memory.get(key) ?? { known: [], pending: [] };
    const value = JSON.parse(stored);
    const hashes = (items: unknown): string[] => Array.isArray(items) ? items.filter((id): id is string => typeof id === "string" && /^0x[0-9a-f]{64}$/i.test(id)).map((id) => id.toLowerCase()) : [];
    return { known: hashes(value?.known), pending: hashes(value?.pending) };
  } catch { return memory.get(key) ?? { known: [], pending: [] }; }
}
export function rememberLocalPayments(key: string, pending: readonly string[], history: readonly string[]): void {
  try {
    const previous = readLocalPaymentHistory(key);
    const current = pending.map((id) => id.toLowerCase());
    const known = [...new Set([...current, ...history.map((id) => id.toLowerCase()), ...previous.known])].slice(0, 512);
    const value = { known, pending: current };
    memory.set(key, value);
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* Wallet storage remains authoritative when browser preferences disable localStorage. */ }
}
