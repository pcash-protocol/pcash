import { describe, expect, it, vi } from "vitest";
import type { OfferPublication, StoredOffer } from "@pcash/marketplace/app";
import type { PscanClient, SourceVerificationInfo, StatusResult } from "@pcash/sdk/clients";

const OPENING = {
  address: "0x00000000000000000000000000000000000000aa",
  selector: 0,
  applicationVkHash: `0x${"11".repeat(32)}`,
  configurationCommitment: `0x${"22".repeat(32)}`,
  domain: `0x${"33".repeat(32)}`,
  values: [`0x${"44".repeat(32)}`],
};

vi.mock("@pcash/marketplace/app", () => ({
  marketplacePublicationSourceConfigurationOpenings: () => [OPENING],
  publicationContractAddress: () => OPENING.address,
}));

import {
  isPublicCreatedOffer,
  marketplacePscanClient,
  publishMarketplaceSourceOpenings,
} from "./sourceOpenings.ts";

const STATUS = {
  pcashChainId: 1_346_589_512,
  genesisHash: `0x${"55".repeat(32)}`,
  l1ChainId: 11_155_111n,
  inboxAddress: "0x5043534800000000000000000000000000000000",
} as StatusResult;
const PUBLICATION = { l2Contract: { bodyHex: "0x" } } as unknown as OfferPublication;

function sourceInfo(
  overrides: { pcashChainId?: number; genesisHash?: string } = {},
): SourceVerificationInfo {
  return {
    status: "ready",
    writable: true,
    verificationAuthority: "node-operator",
    verificationMethod: "reproduced-bundle-v1",
    manifestSchemaVersion: 2n,
    serviceName: null,
    implementationCount: 2n,
    configurationOpeningCount: 0n,
    invalidConfigurationOpeningCount: 0n,
    pcashChainId: overrides.pcashChainId ?? STATUS.pcashChainId,
    genesisHash: overrides.genesisHash ?? STATUS.genesisHash,
    sourceSubmissionStatus: "disabled",
    configurationOpeningSubmissionStatus: "ready",
    submittedImplementationCount: 0n,
    error: null,
  };
}

function client(overrides: Partial<PscanClient> = {}): PscanClient {
  return {
    sourceVerificationInfo: vi.fn(async () => sourceInfo()),
    getContractSource: vi.fn(async () => ({ verificationStatus: "verified" })),
    submitContractConfigurationOpenings: vi.fn(async () => ({
      contractAddress: OPENING.address,
      contentId: `0x${"66".repeat(32)}`,
      configurationOpeningCount: 1n,
      deduplicated: false,
    })),
    ...overrides,
  } as PscanClient;
}

describe("Marketplace source-opening publication", () => {
  it("never discloses draft, partial, or failed-catalog seller records", () => {
    const record = (changes: Partial<StoredOffer>): StoredOffer => ({
      key: "offer",
      pub: PUBLICATION,
      source: "created",
      savedAt: 1,
      publish: { phase: "draft", updatedAt: 1 },
      ...changes,
    });
    expect(isPublicCreatedOffer(record({}))).toBe(false);
    expect(isPublicCreatedOffer(record({
      pub: { ...PUBLICATION, escrow: { leafIndex: 1, noteSecret: "0x1", amount: "0x1" } },
      publish: { phase: "funded", catalogError: "unavailable", updatedAt: 2 },
    }))).toBe(false);
    expect(isPublicCreatedOffer(record({
      pub: { ...PUBLICATION, escrow: { leafIndex: 1, noteSecret: "0x1", amount: "0x1" } },
      publish: {
        phase: "funded",
        catalogPublishedAt: 2,
        catalogPublicationId: `0x${"88".repeat(32)}`,
        updatedAt: 2,
      },
    }))).toBe(true);
  });

  it("pins Pscan identity and submits the address-free complete opening set", async () => {
    const pscan = client();
    await publishMarketplaceSourceOpenings(pscan, PUBLICATION, async () => STATUS);
    expect(pscan.submitContractConfigurationOpenings).toHaveBeenCalledWith({
      contractAddress: OPENING.address,
      openings: [{
        selector: OPENING.selector,
        applicationVkHash: OPENING.applicationVkHash,
        configurationCommitment: OPENING.configurationCommitment,
        domain: OPENING.domain,
        values: OPENING.values,
      }],
    });
  });

  it("publishes openings when source-package reproduction is unavailable", async () => {
    const pscan = client({
      sourceVerificationInfo: vi.fn(async () => ({
        ...sourceInfo(),
        writable: false,
        error: "source reproducer is not configured",
        sourceSubmissionStatus: "unavailable" as const,
        configurationOpeningSubmissionStatus: "ready" as const,
      })),
    });
    await expect(publishMarketplaceSourceOpenings(pscan, PUBLICATION, async () => STATUS))
      .resolves.toMatchObject({ status: "published" });
    expect(pscan.submitContractConfigurationOpenings).toHaveBeenCalledOnce();
  });

  it.each([null, { verificationStatus: "not_verified" }])("waits for source verification without submitting parameters (%j)", async (source) => {
    const pscan = client({ getContractSource: vi.fn().mockResolvedValue(source) });
    await expect(publishMarketplaceSourceOpenings(pscan, PUBLICATION, async () => STATUS))
      .resolves.toEqual({ status: "pending-verification" });
    expect(pscan.getContractSource).toHaveBeenCalledWith(OPENING.address);
    expect(pscan.submitContractConfigurationOpenings).not.toHaveBeenCalled();
  });

  it("publishes on a later refresh after source verification becomes available", async () => {
    const pscan = client({ getContractSource: vi.fn()
      .mockResolvedValueOnce({ verificationStatus: "not_verified" })
      .mockResolvedValue({ verificationStatus: "verified" }) });
    await publishMarketplaceSourceOpenings(pscan, PUBLICATION, async () => STATUS);
    expect(pscan.submitContractConfigurationOpenings).not.toHaveBeenCalled();
    expect((await publishMarketplaceSourceOpenings(pscan, PUBLICATION, async () => STATUS)).status).toBe("published");
    expect(pscan.submitContractConfigurationOpenings).toHaveBeenCalledOnce();
  });

  it("reports registry read and publication failures without bypassing verification", async () => {
    const read = vi.fn().mockRejectedValue(new Error("Pscan unavailable"));
    const pscan = client({ getContractSource: read });
    await expect(publishMarketplaceSourceOpenings(pscan, PUBLICATION, async () => STATUS)).rejects.toThrow("Pscan unavailable");
    expect(pscan.submitContractConfigurationOpenings).not.toHaveBeenCalled();
    read.mockResolvedValue({ verificationStatus: "verified" });
    vi.mocked(pscan.submitContractConfigurationOpenings).mockRejectedValue(new Error("Registry changed"));
    await expect(publishMarketplaceSourceOpenings(pscan, PUBLICATION, async () => STATUS)).rejects.toThrow("Registry changed");
  });

  it("does not publish to a Pscan registry for another chain", async () => {
    const submit = vi.fn();
    const pscan = client({
      sourceVerificationInfo: vi.fn(async () => sourceInfo({ pcashChainId: 1 })),
      submitContractConfigurationOpenings: submit,
    });
    await expect(publishMarketplaceSourceOpenings(pscan, PUBLICATION, async () => STATUS)).rejects.toThrow(
      /not a writable source registry/,
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("pairs against the status it reads rather than a stale one", async () => {
    const submit = vi.fn();
    const pscan = client({
      sourceVerificationInfo: vi.fn(async () => sourceInfo()),
      submitContractConfigurationOpenings: submit,
    });
    // Pscan still reports the history the page was rendered from; the node has
    // since moved to another one under the same chain id.
    const moved = { ...STATUS, genesisHash: `0x${"88".repeat(32)}` } as StatusResult;
    await expect(publishMarketplaceSourceOpenings(pscan, PUBLICATION, async () => moved)).rejects.toThrow(
      /not a writable source registry/,
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not publish to a Pscan registry on another genesis at the same chain id", async () => {
    const submit = vi.fn();
    const pscan = client({
      sourceVerificationInfo: vi.fn(async () => sourceInfo({ genesisHash: `0x${"77".repeat(32)}` })),
      submitContractConfigurationOpenings: submit,
    });
    await expect(publishMarketplaceSourceOpenings(pscan, PUBLICATION, async () => STATUS)).rejects.toThrow(
      /not a writable source registry/,
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("bounds a stalled optional Pscan listener", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    try {
      const pscan = marketplacePscanClient("http://127.0.0.1:8648", 5);
      await expect(pscan?.sourceVerificationInfo()).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("bounds a Pscan response whose body stalls after headers", async () => {
    // Like a real fetch, the body stream fails once the request's signal aborts.
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      },
    }))));
    try {
      const pscan = marketplacePscanClient("http://127.0.0.1:8648", 5);
      await expect(pscan?.sourceVerificationInfo()).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
