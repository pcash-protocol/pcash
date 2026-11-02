import { NO_OP_EVENT_APPLICATION_VK_HASH } from "../src/constants/rulePins.ts";
import { describe, expect, it } from "vitest";
import { buildNativeTransfer } from "../src/builders/nativeTransfer.ts";
import { EVENT_DOMAIN, EVENT_ENTRY_DOMAIN } from "../src/constants/domainTags.ts";
import { privateValueProfile } from "../src/constants/privateValueProfiles.ts";
import { poseidon } from "../src/crypto/poseidon2.ts";
import { eventEntry, eventsCommitment } from "../src/protocol/events.ts";
import { fm } from "../src/protocol/witness.ts";
import { prepareEventApplication, transferTransactionStack, type ChonkCircuitMaterial } from "../src/prover/stacks.ts";
import { privateValueProfileFixture } from "./privateValueProfileFixtures.ts";

const material: ChonkCircuitMaterial = {
  kind: "app", artifact: { bytecode: "fixture", abi: {} }, verificationKey: new Uint8Array(),
  vkFields: Array<string>(151).fill(fm(0n)), vkHash: fm(37n),
};

describe("event preparation", () => {
  it("binds the resolved application before authorization and reuses it in the stack", async () => {
    const resolutions: string[] = [];
    const resolve = async (name: string, kind: ChonkCircuitMaterial["kind"]) => {
      resolutions.push(name);
      return name === "fixture_event" ? material : { ...material, kind };
    };
    const preparedEvent = await prepareEventApplication({ packageName: "fixture_event", event: 91n, eventSalt: 0n, resolve });
    const fixture = privateValueProfileFixture({ shape: 0, scenario: "minimal" });
    const build = buildNativeTransfer({ ...fixture.params, preparedEvent });
    const entry = poseidon([EVENT_ENTRY_DOMAIN, 37n, 91n]);
    expect(build.ruleStatement[3]).toBe(entry);
    expect(build.accountRuleWitnessMap!.event_entry).toBe(fm(entry));
    expect(build.publicInputs[privateValueProfile(build.shape).offsets.eventsCommitment]).toBe(poseidon([EVENT_DOMAIN, entry, 0n]));
    const before = [...build.publicInputs];
    const stack = await transferTransactionStack({
      build, resolve, authorizationPackage: build.authorizationCircuit!, authorizationWitnessMap: build.accountRuleWitnessMap!,
      eventApplication: { preparedEvent, witnessMap: {} },
    });
    expect(resolutions.filter(name => name === "fixture_event")).toHaveLength(1);
    expect(stack.steps[1]!.artifact).toBe(material.artifact);
    expect(build.publicInputs).toEqual(before);
    expect(stack.steps[2]!.witnessMap.rule_statement).toEqual(build.ruleStatement.map(fm));
    expect(stack.steps[2]!.witnessMap.event_statement).toEqual([build.ruleStatement[1], build.recentPcashBlockHash, 91n].map(fm));
  });

  it("matches a frozen event commitment and binds every operand", () => {
    const application = { applicationVkHash: 37n, event: 91n };
    const expected = 5301860702334322313679093975925745023916549884580538086241338097655358362770n;
    expect(eventEntry(application)).toBe(13350450868714405179961229660701729522045873652866190129311556467028244316982n);
    expect(eventsCommitment(123n, application)).toBe(expected);
    expect(eventsCommitment(123n, { ...application, applicationVkHash: 38n })).not.toBe(expected);
    expect(eventsCommitment(123n, { ...application, event: 92n })).not.toBe(expected);
    expect(eventsCommitment(124n, application)).not.toBe(expected);
  });

  it("allows zero salt and binds the no-op event application like every other event application", () => {
    expect(eventsCommitment(0n)).toBe(poseidon([EVENT_DOMAIN, eventEntry({ applicationVkHash: NO_OP_EVENT_APPLICATION_VK_HASH, event: 0n }), 0n]));
    expect(eventsCommitment(0n, { applicationVkHash: 37n, event: 0n })).not.toBe(eventsCommitment(0n));
  });
});
