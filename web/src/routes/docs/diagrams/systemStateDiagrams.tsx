export function HeaderStateMapDiagram() {
  return (
    <div className="learnDiagram learnDiagram-map" role="img" aria-label="The PCASH header commits the block's results, the current state, and two histories; the results cover every transaction and payout, and the current state commits notes, the total issued and pace, accounts, and the spent set.">
      <article className="learnDiagram-mapHead">
        <span className="learnDiagram-kicker">PCASH header</span>
        <strong>Block identity and everything a proof can open</strong>
      </article>
      <div className="learnDiagram-mapBranches">
        <article className="learnDiagram-mapBranch learnDiagram-mapBranch--history">
          <strong>Ethereum history</strong>
          <small>Every Ethereum block since launch, with its event logs</small>
        </article>
        <article className="learnDiagram-mapBranch learnDiagram-mapBranch--history">
          <strong>Block results</strong>
          <small>Every transaction's outcome and statement, and every payout</small>
        </article>
        <article className="learnDiagram-mapBranch learnDiagram-mapBranch--state">
          <strong>Current state</strong>
          <div className="learnDiagram-chipSet">
            <span>notes</span><span>total issued and pace</span><span>accounts</span><span>spent set</span>
          </div>
        </article>
        <article className="learnDiagram-mapBranch learnDiagram-mapBranch--history">
          <strong>PCASH history</strong>
          <small>Every earlier PCASH block</small>
        </article>
      </div>
    </div>
  );
}
