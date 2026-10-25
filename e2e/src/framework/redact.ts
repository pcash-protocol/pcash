const SECRET_KEY = /(?:private.?key|secret|mnemonic|token|authorization|api.?key|credential)/i;
const URL_CREDENTIAL = /([?&](?:key|token|api[_-]?key|auth)=)[^&#\s]+/gi;
const BEARER = /\bBearer\s+[^\s"']+/gi;
const LABELLED_PRIVATE_KEY = /((?:private[_ -]?key|secret[_ -]?key)\s*[:=]\s*)0x[0-9a-fA-F]{64}\b/gi;

export function redactText(value: string): string {
  return value
    .replace(URL_CREDENTIAL, "$1[REDACTED]")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(LABELLED_PRIVATE_KEY, "$1[REDACTED_PRIVATE_KEY]");
}

export function redactEvidence(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => redactEvidence(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redactEvidence(item, name)]),
    );
  }
  return value;
}
