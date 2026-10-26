import type { AccountCreationAttachment } from "@pcash/sdk/protocol";
import { bytesEqual, fromHex, toHex } from "@pcash/sdk/utils";

export type StoredAccountCreationAttachment =
  | { kind: "contract"; body: string }
  | { kind: "user"; transactionHex: string };

export function storeAccountCreation(attachment: AccountCreationAttachment | undefined): StoredAccountCreationAttachment | undefined {
  if (attachment === undefined) return undefined;
  return attachment.kind === "contract"
    ? { kind: "contract", body: toHex(attachment.body) }
    : { kind: "user", transactionHex: toHex(attachment.transactionBytes) };
}

export function restoreAccountCreation(attachment: StoredAccountCreationAttachment | undefined): AccountCreationAttachment | undefined {
  if (attachment === undefined) return undefined;
  return attachment.kind === "contract"
    ? { kind: "contract", body: fromHex(attachment.body) }
    : { kind: "user", transactionBytes: fromHex(attachment.transactionHex) };
}

export function sameAccountCreation(left: AccountCreationAttachment | undefined, right: AccountCreationAttachment | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.kind === "contract"
    ? right.kind === "contract" && bytesEqual(left.body, right.body)
    : right.kind === "user" && bytesEqual(left.transactionBytes, right.transactionBytes);
}
