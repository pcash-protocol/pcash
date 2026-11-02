import { describe, expect, it } from "vitest";
import { SELECTED_RELAY_QUOTE_TYPE, selectedRelayQuoteTypedData, createSelectedRelayQuote, verifySelectedRelayQuote } from "../src/eip712/selectedRelayQuote.ts";
import { privateKeyPcashActionSigner } from "../src/eip712/authorization.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { generateMlKemKeyPair } from "../src/protocol/envelope.ts";
import { issuancePayoutOpening, payoutTransactionContext } from "../src/protocol/payout.ts";
import { toHex } from "../src/utils/hex.ts";

const key = new Uint8Array(32); key[31] = 17;
const signer = privateKeyPcashActionSigner(key);
const network = DEFAULT_NETWORK_CONFIG;
const receive = generateMlKemKeyPair(new Uint8Array(64).fill(3));
const expected = { recipient: signer.address, pcashChainId: network.pcashChainId,
  privateFeeAmount: 77n, transactionContext: 333n, quoteBinding: 444n,
  maxTransactionBytes: 65_536n, nowTimestamp: 999n };
const makeQuote = () => createSelectedRelayQuote({ ...expected, network, nkRoot: 123n,
  receiveKey: receive.publicKey, validUntilTimestamp: 1000n, signer });

describe("authenticated selected relay quotes", () => {
  it("signs the private fee, receive material, issuance destination, context, binding, and expiry", async () => {
    const quote = await makeQuote();
    expect(SELECTED_RELAY_QUOTE_TYPE).toContain("bytes32 receiveKeyHash");
    expect(selectedRelayQuoteTypedData(network, quote).primaryType).toBe("PcashSelectedRelayQuote");
    const verified = verifySelectedRelayQuote(network, quote, expected);
    expect(verified.issuanceOwnerCommitment).toBe(quote.issuanceOwnerCommitment);
    expect(verified.designatedIssuanceOpening?.noteSecret).toBe(quote.issuanceNoteSecret);
    expect(toHex(verified.receiveKey)).toBe(toHex(receive.publicKey));
  });

  it("derives issuance independently of the fee note", async () => {
    const nullifiers = [11n, 12n, 13n, 14n];
    const transactionContext = payoutTransactionContext(network.pcashChainId, nullifiers);
    const quote = await createSelectedRelayQuote({ ...expected, transactionContext, network, nkRoot: 123n,
      receiveKey: receive.publicKey, validUntilTimestamp: 1000n, signer });
    const opening = issuancePayoutOpening(signer.address, 123n, network.pcashChainId, nullifiers);
    expect(quote.issuanceNoteSecret).toBe(opening.noteSecret);
    expect(quote.issuanceOwnerCommitment).toBe(opening.ownerCommitment);
  });

  it("permits a zero issuance route for non-qualifying account operations", async () => {
    const quote = await createSelectedRelayQuote({ ...expected, network, nkRoot: 123n,
      receiveKey: receive.publicKey, issuanceEligible: false, validUntilTimestamp: 1000n, signer });
    expect(verifySelectedRelayQuote(network, quote, expected).issuanceOwnerCommitment).toBe(0n);
  });

  it("rejects changed terms, receive key, binding, signature domain, and expiry", async () => {
    const quote = await makeQuote();
    const changed = [
      { ...quote, privateFeeAmount: 78n }, { ...quote, transactionContext: 334n },
      { ...quote, quoteBinding: 445n }, { ...quote, recipient: signer.address + 1n },
      { ...quote, maxTransactionBytes: 65_535n },
      { ...quote, receiveKey: toHex(generateMlKemKeyPair(new Uint8Array(64).fill(4)).publicKey) },
      { ...quote, issuanceNoteSecret: BigInt(quote.issuanceNoteSecret) + 1n },
      { ...quote, issuanceOwnerCommitment: BigInt(quote.issuanceOwnerCommitment) + 1n },
    ];
    for (const item of changed) expect(() => verifySelectedRelayQuote(network, item, expected)).toThrow();
    expect(() => verifySelectedRelayQuote({ ...network, inboxAddress: network.inboxAddress + 1n }, quote, expected)).toThrow(/signature/);
    expect(() => verifySelectedRelayQuote(network, quote, { ...expected, nowTimestamp: 1001n })).toThrow(/expired/);
  });
});
