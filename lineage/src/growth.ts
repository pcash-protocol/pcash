/** Reproducible unrestricted-mixing model; every step spends fanIn notes and creates fanIn outputs. */
export function ancestryGrowth(options: { population: number; rounds: number; fanIn: number; seed: number }) {
  const { population, rounds, fanIn } = options;
  if (!Number.isInteger(population) || population < fanIn || !Number.isInteger(rounds) || rounds < 1 || !Number.isInteger(fanIn) || fanIn < 1 || fanIn > 4) throw new Error("invalid growth model parameters");
  let seed = options.seed >>> 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  let nextNote = population, nextTx = 0;
  const notes = Array.from({ length: population }, (_, id) => ({ id, txs: new Set<number>(), ancestry: new Set([id]), sources: new Set([id]), depth: 0 }));
  const samples = [];
  for (let round = 1; round <= rounds; round++) {
    for (let step = 0; step < Math.ceil(population / fanIn); step++) {
      const selected = new Set<number>();
      while (selected.size < fanIn) selected.add(Math.floor(random() * population));
      const inputs = [...selected].map(index => notes[index]!);
      const txs = new Set(inputs.flatMap(note => [...note.txs])); txs.add(nextTx++);
      const ancestry = new Set(inputs.flatMap(note => [...note.ancestry]));
      const sources = new Set(inputs.flatMap(note => [...note.sources]));
      const depth = Math.max(...inputs.map(note => note.depth)) + 1;
      for (const index of selected) { const id = nextNote++; notes[index] = { id, txs, ancestry: new Set([...ancestry, id]), sources, depth }; }
    }
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    samples.push({ round, transactions: nextTx, meanHopProofs: mean(notes.map(note => note.txs.size)), maxHopProofs: Math.max(...notes.map(note => note.txs.size)), meanAncestryNotes: mean(notes.map(note => note.ancestry.size)), meanSources: mean(notes.map(note => note.sources.size)), meanDepth: mean(notes.map(note => note.depth)) });
  }
  return { options, samples };
}

/** Costs are supplied measurements; the graph model does not manufacture proving or verification timings. */
export function priceAncestry(sample: ReturnType<typeof ancestryGrowth>["samples"][number], costs: {
  hopProofBytes: number; hopWitnessBytes: number; nativeVerifyMs: number;
  recursiveVerifyGates: number; sourceMembershipGates: number; denyNonMembershipGates: number;
}) {
  return {
    bundleBytes: sample.meanHopProofs * (costs.hopProofBytes + costs.hopWitnessBytes),
    finalNativeVerificationMs: sample.meanHopProofs * costs.nativeVerifyMs,
    finalAggregationGates: sample.meanHopProofs * costs.recursiveVerifyGates,
    disclosedAncestryBytes: sample.meanAncestryNotes * 32,
    latestRootZkGates: sample.meanSources * costs.sourceMembershipGates + sample.meanAncestryNotes * costs.denyNonMembershipGates,
    latestRootNativeChecks: sample.meanSources + sample.meanAncestryNotes,
  };
}
