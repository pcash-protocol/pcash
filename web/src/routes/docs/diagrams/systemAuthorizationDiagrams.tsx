export function AccountAuthorityDiagram() {
  return (
    <div className="learnDiagram learnDiagram-flow" role="img" aria-label="An account commits a rule set, one rule is chosen privately, its circuit decides whether to approve, and the protocol enforces the ledger rules.">
      <article className="learnDiagram-card learnDiagram-card--source">
        <span className="learnDiagram-kicker">Account</span>
        <strong>Committed rule set</strong>
        <small>One rule is chosen privately</small>
      </article>
      <div className="learnDiagram-arrow" aria-hidden="true">→</div>
      <article className="learnDiagram-card learnDiagram-card--check">
        <span className="learnDiagram-kicker">Selected rule</span>
        <strong>Exact circuit fingerprint</strong>
        <small>Plus its committed configuration</small>
      </article>
      <div className="learnDiagram-arrow" aria-hidden="true">→</div>
      <article className="learnDiagram-card learnDiagram-card--private">
        <span className="learnDiagram-kicker">Rule circuit</span>
        <strong>Decides whether to approve</strong>
        <small>A signature, a threshold, a secret, or anything else</small>
      </article>
      <div className="learnDiagram-arrow" aria-hidden="true">→</div>
      <article className="learnDiagram-card learnDiagram-card--result">
        <span className="learnDiagram-kicker">Protocol</span>
        <strong>Enforces the ledger rules</strong>
        <small>A rule cannot create value or spend another account's notes</small>
      </article>
    </div>
  );
}
