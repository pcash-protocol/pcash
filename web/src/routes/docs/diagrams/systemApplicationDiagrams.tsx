export function ContractAccountDiagram() {
  return (
    <div className="learnDiagram learnDiagram-contract" role="img" aria-label="A PCASH contract is an immutable keyless account with fixed functions; each call proves that one of them approved and that the ledger rules hold, and nodes run no contract virtual machine.">
      <article className="learnDiagram-card learnDiagram-card--source">
        <span className="learnDiagram-kicker">Published once</span>
        <strong>PCASH contract</strong>
        <ul className="learnDiagram-miniList">
          <li>Note key commitment</li>
          <li>Optional receive key</li>
          <li>Fixed functions</li>
        </ul>
      </article>
      <div className="learnDiagram-contractCore">
        <div className="learnDiagram-function"><span>selector 2</span><strong>claim</strong></div>
        <div className="learnDiagram-function"><span>selector 7</span><strong>refund</strong></div>
        <div className="learnDiagram-function"><span>selector 19</span><strong>settle</strong></div>
      </div>
      <article className="learnDiagram-card learnDiagram-card--result">
        <span className="learnDiagram-kicker">Each call</span>
        <strong>Spend contract-owned notes</strong>
        <small>Prove that one of its functions approved, and that the ledger rules hold</small>
      </article>
      <div className="learnDiagram-noVm">
        <strong>No VM</strong>
        <span>No mutable contract storage, node-executed bytecode, or hidden upgrade path</span>
      </div>
    </div>
  );
}

export function NormalizedLogDiagram() {
  return (
    <div className="learnDiagram learnDiagram-logFlow" role="img" aria-label="A rule opens one Ethereum block and one of its events beneath a recent PCASH block, and only that event enters the rule.">
      <article className="learnDiagram-card">
        <span className="learnDiagram-kicker">Public anchor</span>
        <strong>Recent PCASH block hash</strong>
      </article>
      <div className="learnDiagram-arrow" aria-hidden="true">→</div>
      <article className="learnDiagram-card learnDiagram-card--check">
        <span className="learnDiagram-kicker">Ethereum history</span>
        <strong>One Ethereum block</strong>
        <small>Its identity, time, and event logs</small>
      </article>
      <div className="learnDiagram-arrow" aria-hidden="true">→</div>
      <article className="learnDiagram-card learnDiagram-card--private">
        <span className="learnDiagram-kicker">Event logs</span>
        <strong>One event</strong>
        <small>Contract, topics, and data</small>
      </article>
      <div className="learnDiagram-arrow" aria-hidden="true">→</div>
      <article className="learnDiagram-card learnDiagram-card--result">
        <span className="learnDiagram-kicker">The rule</span>
        <strong>Decides what it means</strong>
        <small>Only this event enters the rule</small>
      </article>
    </div>
  );
}

export function EthTradeDiagram() {
  return (
    <div className="learnDiagram learnDiagram-flow" role="img" aria-label="A seller locks PCASH in a PCASH escrow contract, the buyer proves a claim, one Ethereum transaction pays the seller in ETH and carries the claim, and the escrow releases the PCASH to the buyer or returns it to the seller after the deadline.">
      <article className="learnDiagram-card learnDiagram-card--private">
        <span className="learnDiagram-kicker">On PCASH</span>
        <strong>The seller locks PCASH in an escrow</strong>
        <small>Its terms can never change</small>
      </article>
      <div className="learnDiagram-arrow" aria-hidden="true">→</div>
      <article className="learnDiagram-card learnDiagram-card--check">
        <span className="learnDiagram-kicker">Buyer's wallet</span>
        <strong>Proves a claim to the escrow</strong>
        <small>Before paying anything</small>
      </article>
      <div className="learnDiagram-arrow" aria-hidden="true">→</div>
      <article className="learnDiagram-card learnDiagram-card--source">
        <span className="learnDiagram-kicker">One Ethereum transaction</span>
        <strong>Pays the seller in ETH and carries the claim</strong>
        <small>Through an Ethereum payment contract</small>
      </article>
      <div className="learnDiagram-arrow" aria-hidden="true">→</div>
      <article className="learnDiagram-card learnDiagram-card--result">
        <span className="learnDiagram-kicker">On PCASH</span>
        <strong>The escrow releases the PCASH to the buyer</strong>
        <small>Or returns it to the seller after the deadline</small>
      </article>
    </div>
  );
}
