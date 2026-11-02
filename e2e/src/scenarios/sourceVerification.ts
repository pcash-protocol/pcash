import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { stringify } from "viem";
import {
  createPscanClient,
  type ContractSourceView,
} from "@pcash/sdk/clients";
import { createAdminClient } from "@pcash/sdk/node";
import { addressHex } from "@pcash/sdk/utils";
import {
  marketplaceSourceConfigurationOpenings,
  type Offer,
} from "@pcash/marketplace";
import {
  attachConfigurationOpenings,
  reproduceContract,
  sourceVerificationPublication,
  type SourceSubmissionEnvelope,
} from "../../../scripts/source-verification/index.mts";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { eventually } from "../framework/eventually.ts";
import { runMarketplaceScenario } from "./marketplace.ts";

export async function runSourceVerificationScenario(fixture: ScenarioFixture): Promise<void> {
  const manifest = fixture.sourceVerificationManifest;
  if (manifest === undefined) throw new Error("source-verification scenario has no operator manifest");
  const nodeA = fixture.local("A");
  const pscanA = createPscanClient(nodeA.pscanUrl);
  const pscanB = createPscanClient(fixture.local("B").pscanUrl);
  const adminA = createAdminClient(nodeA.adminUrl);
  let reproduced = false;

  // Node A learns the material through operator publish; node B runs WITHOUT
  // an operator manifest and must fill purely through the permissionless
  // submission channel, in one envelope covering every deployed contract.
  const targets: string[] = [];
  const offers: Offer[] = [];

  await runMarketplaceScenario(fixture, {
    sourceVerificationOnly: true,
    publishSourceVerification: async (offer: Offer) => {
      const openings = marketplaceSourceConfigurationOpenings({
        address: offer.l2ContractAddress,
        reclaimAuthority: offer.reclaimAuthority,
        claimConfigurationSalt: offer.claimConfigurationSalt,
        reclaimConfigurationSalt: offer.reclaimConfigurationSalt,
        terms: offer.terms,
        network: offer.network,
      });
      attachConfigurationOpenings(manifest, openings);
      await adminA.publishSourceVerification(sourceVerificationPublication(manifest));
      targets.push(addressHex(offer.l2ContractAddress));
      offers.push(offer);
    },
  });
  if (targets.length === 0) throw new Error("marketplace flow published no source verification");

  // One submission covering the closed target set; the node rebuilds any new
  // implementation before persisting.
  const envelope: SourceSubmissionEnvelope = {
    contractAddresses: [...new Set(targets)],
    publication: sourceVerificationPublication(manifest),
  };
  await pscanB.submitContractSource(envelope);

  const views = await eventually(
    `source verification for ${targets.join(", ")}`,
    () => Promise.all(targets.flatMap((address) => [pscanA.getContractSource(address), pscanB.getContractSource(address)])),
    (items): items is ContractSourceView[] => items.every((item) =>
      item !== null
      && item.verificationStatus === "verified"
      && item.implementations.length === 2
      && item.configurationOpenings.length === 2
      && item.configurationOpenings.every((opening) => opening.status === "verified")
    ),
    { timeoutMs: 30_000, cancellation: () => fixture.nodeA.process?.cancellationReason() ?? null },
  );
  const first = views[0];
  if (views.some((view) => view === null) || first === undefined || first === null) {
    throw new Error("source verification disappeared after readiness");
  }
  const verifiedView: ContractSourceView = first;

  const target: string = targets[0] ?? (() => { throw new Error("no targets collected"); })();
  if (!reproduced) {
    const bundle = await pscanA.getContractSourceBundle(target);
    if (bundle === null || bundle.implementations.length !== 2) {
      throw new Error("verified contract source bundle omitted an implementation");
    }
    const download = fixture.artifacts.path("source-verification-contract.json");
    // Serialize exactly as the explorer's download does.
    await writeFile(download, `${stringify(bundle, null, 2)}\n`, { mode: 0o600 });
    const result = reproduceContract(download);
    if (result.implementations.length !== 2) throw new Error("source reproduction omitted an implementation");
    reproduced = true;
  }

  // Identical resubmission must be answered from the acceptance receipt.
  const resubmission = await pscanB.submitContractSource(envelope);
  if (!resubmission.deduplicated) throw Error("identical resubmission was revalidated instead of deduplicated");

  // The disabled node refuses submissions with its own structured error.
  await assert.rejects(
    pscanA.submitContractSource(envelope),
    { name: "PcashNodeRpcError", code: -32043 },
    "node A accepts public submissions despite running without --enable-source-submissions",
  );

  // The summary helper names per-selector registry presence.
  const summary = await pscanB.contractVerificationSummary(target);
  if (!summary.verified || summary.functions.length === 0) {
    throw new Error("contract verification summary disagrees with the verified view");
  }
  if (!summary.functions.every((entry) => entry.inRegistry)) {
    throw new Error("verification summary reports a function missing from the registry");
  }
  const info = await pscanB.sourceVerificationInfo();
  fixture.artifacts.record("public-source-submission", {
    targets,
    contentId: resubmission.contentId,
    deduplicated: resubmission.deduplicated,
    submittedImplementationCount: info.submittedImplementationCount.toString(),
    functionsInRegistry: summary.functions.length,
  });
  fixture.artifacts.record("source-verification-contract", {
    address: target,
    implementationCount: verifiedView.implementations.length,
    configurationOpeningCount: verifiedView.configurationOpenings.length,
  });
}
