import { describe, expect, it, vi } from "vitest";
import type { PcashActionSigner, PcashAuthorizationRequest } from "@pcash/sdk/eip712";
import { withSignatureProgress } from "./signatureProgress.ts";

describe("signature progress", () => {
  it("shows the wallet prompt for exactly the lifetime of the actual signing request", async () => {
    let resolve!: (value: Awaited<ReturnType<PcashActionSigner["signTypedData"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<PcashActionSigner["signTypedData"]>>>((done) => { resolve = done; });
    const signTypedData = vi.fn(() => pending);
    const finish = vi.fn();
    const start = vi.fn(() => finish);
    const signer = withSignatureProgress({ address: 1n, signTypedData }, start);
    const request = {} as PcashAuthorizationRequest;
    const result = signer.signTypedData(request);
    expect(signer.address).toBe(1n);
    expect(start).toHaveBeenCalledOnce();
    expect(signTypedData).toHaveBeenCalledWith(request);
    expect(finish).not.toHaveBeenCalled();
    const signature = "0xsignature";
    resolve(signature);
    expect(await result).toEqual(signature);
    expect(finish).toHaveBeenCalledOnce();
  });

  it("propagates cancellation and ends the signature indication", async () => {
    const rejected = new Error("User rejected request");
    const finish = vi.fn();
    const signer = withSignatureProgress({ address: 1n, signTypedData: async () => { throw rejected; } }, () => finish);
    await expect(signer.signTypedData({} as PcashAuthorizationRequest)).rejects.toBe(rejected);
    expect(finish).toHaveBeenCalledOnce();
  });
});
