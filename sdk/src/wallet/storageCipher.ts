/** Encrypt documents before the storage adapter passes them to SQL. */
export interface WalletStorageCipher {
  readonly id: string;
  encode(value: unknown, context: string): unknown;
  decode(value: unknown, context: string): unknown;
  /** Stable, opaque lookup key that does not disclose an account or watched note. */
  index(context: string): string;
}
