export function DerivationPipelineDiagram() {
  return (
    <div className="learnDiagram learnDiagram-pipeline" role="img" aria-label="Each canonical Ethereum block deterministically produces one PCASH block by selecting its carriers, Inbox postings and PcashBatch events from any contract, framing their batches, and running the transactions in Ethereum order.">
      <article className="learnDiagram-card learnDiagram-card--source">
        <span className="learnDiagram-kicker">Canonical input</span>
        <strong>Ethereum block anchor + N</strong>
        <small>Header, ordered transactions, receipts, authenticated blobs</small>
      </article>
      <div className="learnDiagram-arrow" aria-hidden="true">→</div>
      <div className="learnDiagram-carriers">
        <article className="learnDiagram-card learnDiagram-card--check">
          <span className="learnDiagram-kicker">Carrier</span>
          <strong>Inbox postings</strong>
          <small>Calldata or blobs, never both</small>
        </article>
        <article className="learnDiagram-card learnDiagram-card--check">
          <span className="learnDiagram-kicker">Carrier</span>
          <strong>PcashBatch events</strong>
          <small>From any contract, any number per transaction</small>
        </article>
      </div>
      <div className="learnDiagram-arrow" aria-hidden="true">→</div>
      <article className="learnDiagram-card learnDiagram-card--private">
        <span className="learnDiagram-kicker">Frame, run in Ethereum order</span>
        <strong>Transactions</strong>
        <small>Each success changes the state the next one sees</small>
      </article>
      <div className="learnDiagram-arrow" aria-hidden="true">→</div>
      <article className="learnDiagram-card learnDiagram-card--result">
        <span className="learnDiagram-kicker">Deterministic output</span>
        <strong>PCASH block N</strong>
        <small>Outcomes, new state, payouts</small>
      </article>
    </div>
  );
}
