import { buildAuthorizedReferenceUserAccountCreation, type BuildReferenceUserAccountCreationParams } from "@pcash/sdk/builders";
import type { PcashActionSigner } from "@pcash/sdk/eip712";
import { encodeUserAccountCreation, type AccountCreationAttachment } from "@pcash/sdk/protocol";
import { bytesEqual, fromHex, toHex } from "@pcash/sdk/utils";

/**
 * A signed user creation to attach to a value action. It signs its own recent
 * block and deadline; give it the action's, so it expires with the action.
 */
export async function userAccountCreationAttachment(
  creation: BuildReferenceUserAccountCreationParams,
  signer: PcashActionSigner,
): Promise<AccountCreationAttachment> {
  const built = await buildAuthorizedReferenceUserAccountCreation(creation, signer);
  return { kind: "user", transactionBytes: encodeUserAccountCreation(creation.chainId, built.body) };
}

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
