import { describe, expect, it } from "vitest";
import { resolveRecipientDelivery } from "@pcash/sdk/delivery";

describe("recipient delivery resolution", () => {
  it("loads the published receive key for an address and rejects a 32-byte value", async () => {
    const address = `0x${"77".repeat(20)}`;
    const receiveKey = new Uint8Array(1_184).fill(0x88);
    const lookups: string[] = [];
    const receiveKeyOf = async (recipient: string) => {
      lookups.push(recipient);
      return receiveKey;
    };

    const delivery = await resolveRecipientDelivery(address, 1n, receiveKeyOf);
    expect(delivery.recipientAddress).toBe(BigInt(address));
    expect(delivery.recipientReceiveKey).toHaveLength(1_184);
    await expect(resolveRecipientDelivery(`0x${"99".repeat(32)}`, 1n, receiveKeyOf)).rejects.toThrow(
      "neither a 20-byte address nor an extended code",
    );
    expect(lookups).toEqual([address]);
  });
});
