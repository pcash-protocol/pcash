import { deviceLabel, mebibytes, seconds, type LabReport } from "./report.ts";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

function settingsLabel(report: LabReport): string {
  const { settings } = report;
  return [
    `${settings.threads} thread${settings.threads === 1 ? "" : "s"}`,
    settings.memoryMaximumMiB === undefined ? "default memory" : `${settings.memoryMaximumMiB} MiB cap`,
    settings.proverLifetime === "warm" ? "warm" : undefined,
    settings.runs > 1 ? `median of ${settings.runs}` : undefined,
  ].filter((part): part is string => part !== undefined).join(" · ");
}

/**
 * One row per scenario, one column per report. A cell quotes the median
 * required time and the run's peak prover memory.
 */
export function renderComparison(reports: readonly LabReport[], target: HTMLElement): void {
  if (reports.length === 0) {
    target.replaceChildren(element("p", "No results loaded.", "counting"));
    return;
  }
  const scenarios = new Map<string, string>();
  for (const report of reports) {
    for (const scenario of report.scenarios) if (!scenarios.has(scenario.id)) scenarios.set(scenario.id, scenario.label);
  }
  const table = element("table", undefined, "summary compare");
  const head = element("thead");
  const headRow = element("tr");
  headRow.append(element("th", "Scenario"));
  for (const report of reports) {
    const th = element("th");
    th.style.textAlign = "right";
    th.append(
      element("span", deviceLabel(report), "device"),
      element("span", settingsLabel(report), "device-detail"),
      element("span", `${report.source.kind} · ${report.startedAt.slice(0, 16).replace("T", " ")}`, "device-detail"),
    );
    headRow.append(th);
  }
  head.append(headRow);
  const body = element("tbody");
  for (const [id, label] of scenarios) {
    const row = element("tr", undefined, "scenario-row");
    row.append(element("td", label, "name"));
    for (const report of reports) {
      const scenario = report.scenarios.find((entry) => entry.id === id);
      const cell = element("td", undefined, "num");
      if (scenario === undefined) {
        cell.textContent = "—";
      } else if (scenario.summary !== undefined) {
        const { requiredMs, peakWasmMemoryBytes, failed } = scenario.summary;
        cell.append(element("span", seconds(requiredMs.median), "total"));
        const detail = [
          requiredMs.max > requiredMs.min ? `${seconds(requiredMs.min)}–${seconds(requiredMs.max)}` : undefined,
          peakWasmMemoryBytes === undefined ? undefined : mebibytes(peakWasmMemoryBytes),
          failed > 0 ? `${failed} failed` : undefined,
        ].filter((part): part is string => part !== undefined).join(" · ");
        if (detail !== "") cell.append(element("span", detail, "device-detail"));
      } else {
        const oom = scenario.runs.some((run) => run.likelyOutOfMemory);
        cell.append(element("span", oom ? "out of memory?" : "failed", "failed-cell"));
        const memory = scenario.runs.at(-1)?.timing.peakWasmMemoryBytes;
        if (memory !== undefined) cell.append(element("span", `last reading ${mebibytes(memory)}`, "device-detail"));
      }
      row.append(cell);
    }
    body.append(row);
  }
  table.append(head, body);
  const scroller = element("div", undefined, "table-scroll");
  scroller.append(table);
  target.replaceChildren(scroller);
}

/** Accept a report or an array of reports; anything else is not a lab result. */
export function parseReports(text: string): LabReport[] {
  const value = JSON.parse(text) as unknown;
  const list = Array.isArray(value) ? value : [value];
  return list.filter((entry): entry is LabReport =>
    typeof entry === "object" && entry !== null && (entry as { kind?: unknown }).kind === "pcash-proof-lab");
}
