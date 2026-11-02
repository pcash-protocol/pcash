export function PaymentJourneyDiagram() {
  return <ol className="learnDiagram learnDiagramFlow" aria-label="Payment journey">
    <li><b>Alice chooses a payment</b><span>Her wallet selects notes and creates payment and change</span></li>
    <li><b>Her wallet proves it</b><span>The spending rule approves it and the values balance</span></li>
    <li><b>Someone publishes it</b><span>Ethereum records the data and its order</span></li>
    <li><b>PCASH nodes check it</b><span>They verify the proof and reject already-used spend markers</span></li>
    <li><b>Bob receives a note</b><span>His wallet decrypts the payment; Alice recovers her change</span></li>
  </ol>;
}

export function NoPublicPcashDiagram() {
  return <div className="learnDiagram learnDiagramBoundary">
    <section><small>A shielded pool</small><b>Public and private forms</b><ul><li>a public asset outside the pool</li><li>deposits bring it into private use</li><li>withdrawals return it to public use</li><li>a boundary between the two forms</li></ul></section>
    <section><small>PCASH</small><b>Private throughout</b><ul><li>native money created in private ownership</li><li>nothing to deposit or withdraw</li><li>balances stay private between payments</li><li>selling transfers it to another private owner</li></ul></section>
  </div>;
}

export function ProofStackDiagram() {
  return (
    <div className="learnDiagram learnDiagram-pipeline" role="img" aria-label="On the user's device, the account's rule and an event application are folded into a protocol kernel that enforces the ledger rules, then into a hiding kernel that exposes only the public statement; nodes verify the one resulting proof.">
      <div className="learnDiagram-carriers">
        <article className="learnDiagram-card learnDiagram-card--private">
          <span className="learnDiagram-kicker">Account rule</span>
          <strong>Approves this exact action</strong>
          <small>Any circuit: a signature, a passkey, a threshold</small>
        </article>
        <article className="learnDiagram-card learnDiagram-card--private">
          <span className="learnDiagram-kicker">Event application</span>
          <strong>Proves a claim, or none</strong>
          <small>Such as where the funds came from</small>
        </article>
      </div>
      <div className="learnDiagram-arrow" aria-hidden="true">→</div>
      <article className="learnDiagram-card learnDiagram-card--check">
        <span className="learnDiagram-kicker">Protocol kernel</span>
        <strong>Enforces the ledger rules</strong>
        <small>The notes exist and are the account's, value balances, the rule approved</small>
      </article>
      <div className="learnDiagram-arrow" aria-hidden="true">→</div>
      <article className="learnDiagram-card learnDiagram-card--check">
        <span className="learnDiagram-kicker">Hiding kernel</span>
        <strong>Exposes only the public statement</strong>
        <small>The same for every transaction of a kind</small>
      </article>
      <div className="learnDiagram-arrow" aria-hidden="true">→</div>
      <article className="learnDiagram-card learnDiagram-card--result">
        <span className="learnDiagram-kicker">Every node</span>
        <strong>Verifies one proof</strong>
        <small>Against one pinned key, without seeing any rule</small>
      </article>
    </div>
  );
}
