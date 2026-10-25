export function MoneySupply() {
  return <div className="learnDiagram learnDiagramEquation" aria-label="PCASH starts at zero, and the total ever issued cannot exceed one billion PCASH">
    <div className="learnDiagramEquationTerm" data-lane><strong>Zero</strong><span>PCASH at launch</span></div>
    <span className="learnDiagramOperator" aria-hidden="true">+</span><div className="learnDiagramEquationTerm" data-lane><strong>Issuance</strong><span>Over about a year</span></div>
    <span className="learnDiagramOperator" aria-hidden="true">≤</span><div className="learnDiagramEquationTerm learnDiagramEquationResult" data-lane><strong>1 billion PCASH</strong><span>Maximum ever issued</span></div>
  </div>;
}

export function MoneyController() {
  return <ol className="learnDiagram learnDiagramFlow learnDiagramSteps" data-diagram="flow" aria-label="The baseline declines as supply is issued, is scaled by how far issuance is behind, and each block's allowance is split equally">
    <li className="learnDiagramStep" data-step><span className="learnDiagramEyebrow" data-badge>Baseline</span><strong>Declines as supply is issued</strong><span>Near 761 PCASH per transaction at the start, half that once three quarters of the supply is issued. Time alone changes nothing.</span></li>
    <li className="learnDiagramStep" data-step><span className="learnDiagramEyebrow" data-badge>Controller</span><strong>Scaled by how far behind</strong><span>Behind the reference pace, the offer doubles for every two days behind, up to four times the baseline. Ahead, it keeps falling.</span></li>
    <li className="learnDiagramStep learnDiagramStepAccent" data-step data-tone="private"><span className="learnDiagramEyebrow" data-badge>Allowance</span><strong>Split equally in the block</strong><span>Each block can issue at most three times the baseline, shared equally. Unused allowance expires.</span></li>
  </ol>;
}
