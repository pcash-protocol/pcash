import { LINEAGE_CIRCUIT_PROFILES } from "@pcash/lineage/artifacts";
import {
  performanceScenarios,
  type PerformanceScenario,
  type PerformanceScenarioId,
  type PreparedScenario,
} from "../scenarios/index.ts";
import {
  BROWSER_CRS_DATABASE,
  createBrowserProverSession,
  memoryMaximumPages,
  normalizeProverThreads,
  type BrowserProverSession,
  type ProveScope,
  type ProveStatus,
  type ProveStep,
  type SupportedSrsPoints,
} from "@pcash/sdk/browser-prover";
import { CIRCUIT_PROVING_RUNTIMES } from "@pcash/sdk/constants";
import { parseReports, renderComparison } from "./compare.ts";
import {
  looksOutOfMemory,
  mebibytes,
  medianRun,
  seconds,
  summarizeRun,
  summarizeScenario,
  type CircuitTiming,
  type LabReport,
  type ProverLifetime,
  type RunResult,
  type ScenarioReport,
} from "./report.ts";
import { resolveLabSource, type LabSource } from "./source.ts";

type LabMode = PerformanceScenarioId | "all" | "setup";

interface DiagnosticEvent {
  at: string;
  scenario?: PerformanceScenarioId;
  message: string;
  step?: ProveStep;
  scope?: ProveScope;
  circuit?: string;
  durationMs?: number;
  wasmMemoryBytes?: number;
}

interface LabDiagnostic {
  runId: string;
  state: "running" | "complete" | "failed" | "interrupted";
  startedAt: string;
  updatedAt: string;
  navigationType: string;
  crossOriginIsolated: boolean;
  hardwareConcurrency: number;
  userAgent: string;
  mode: LabMode;
  proverLifetime: ProverLifetime;
  threads: number;
  memoryMaximumMiB?: number;
  source?: string;
  scenario?: PerformanceScenarioId;
  srsPoints?: number;
  pageHiddenAt?: string;
  visibility?: DocumentVisibilityState;
  wakeLockSupported: boolean;
  wakeLockState: "unsupported" | "idle" | "requesting" | "active" | "released" | "denied";
  events: DiagnosticEvent[];
  error?: string;
}

interface Settings {
  proverLifetime: ProverLifetime;
  threads: number;
  memoryMaximumMiB?: number;
  memoryMaximumPages?: number;
  runs: number;
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const status = $<HTMLElement>("#status");
const statusText = $<HTMLElement>("#status-text");
const meter = $<HTMLElement>("#meter");
const phasesElement = $<HTMLOListElement>("#phases");
const summaryElement = $<HTMLElement>("#summary");
const savedElement = $<HTMLElement>("#saved");
const compareElement = $<HTMLElement>("#compare");
const resultElement = $<HTMLElement>("#result");
const scenariosElement = $<HTMLElement>("#scenarios");
const sourceElement = $<HTMLElement>("#source");
const shareButton = $<HTMLButtonElement>("#share");
const downloadButton = $<HTMLButtonElement>("#download");
const downloadDiagnosticsButton = $<HTMLButtonElement>("#download-diagnostics");
const clearButton = $<HTMLButtonElement>("#clear");
const runAllButton = $<HTMLButtonElement>("#run-all");
const setupButton = $<HTMLButtonElement>("#setup-only");
const loadSavedButton = $<HTMLButtonElement>("#load-saved");
const resultFilesInput = $<HTMLInputElement>("#result-files");
const lifecycleSelect = $<HTMLSelectElement>("#lifecycle");
const threadsSelect = $<HTMLSelectElement>("#threads");
const memoryLimitSelect = $<HTMLSelectElement>("#memory-limit");
const runsSelect = $<HTMLSelectElement>("#runs");
const deviceNameInput = $<HTMLInputElement>("#device-name");
const interruptedElement = $<HTMLElement>("#interrupted");
const interruptedResultElement = $<HTMLElement>("#interrupted-result");
$<HTMLElement>("#isolation").textContent = String(crossOriginIsolated);
$<HTMLElement>("#concurrency").textContent = String(navigator.hardwareConcurrency);
const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
if (deviceMemory !== undefined) $<HTMLElement>("#memory").textContent = `${deviceMemory} GiB`;

const savesResults = import.meta.env.VITE_PROOF_LAB_SAVES_RESULTS === "1";
if (savesResults) loadSavedButton.classList.remove("hidden");

const DIAGNOSTIC_KEY = "pcash-proof-lab-last-run";
const DEVICE_NAME_KEY = "pcash-proof-lab-device-name";
try {
  deviceNameInput.value = localStorage.getItem(DEVICE_NAME_KEY) ?? "";
} catch {
  // A remembered name is a convenience.
}
deviceNameInput.addEventListener("change", () => {
  try {
    localStorage.setItem(DEVICE_NAME_KEY, deviceNameInput.value.trim());
  } catch {
    // A remembered name is a convenience.
  }
});

const scenarioList = performanceScenarios();
const prepared = new Map<PerformanceScenarioId, Promise<{ scenario: PreparedScenario; prepareMs: number }>>();
const sourcePromise = resolveLabSource();
let source: LabSource | undefined;
let lastReport: LabReport | undefined;
let comparedReports: LabReport[] = [];
let currentDiagnostic: LabDiagnostic | undefined;
let runInProgress = false;

interface ScreenWakeLockSentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void, options?: { once?: boolean }): void;
}
const wakeLockApi = (navigator as Navigator & {
  wakeLock?: { request(type: "screen"): Promise<ScreenWakeLockSentinel> };
}).wakeLock;
let screenWakeLock: ScreenWakeLockSentinel | undefined;
let wakeLockRequestPending = false;
let proofRunActive = false;

// --- asset source and scenario buttons -------------------------------------

/** The reference wallet proves these circuits only natively; the lab proves them when a scenario is clicked. */
function foldsNativeOnlyCircuit(scenario: PerformanceScenario): boolean {
  return scenario.circuits.some((circuit) => !CIRCUIT_PROVING_RUNTIMES[circuit]?.includes("browser"));
}

const scenarioButtons = new Map<PerformanceScenarioId, HTMLButtonElement>();
for (const scenario of scenarioList) {
  const button = document.createElement("button");
  button.className = "scenario";
  button.disabled = true;
  const title = document.createElement("strong");
  title.textContent = scenario.label;
  const description = document.createElement("span");
  description.textContent = scenario.description;
  button.append(title, description);
  if (foldsNativeOnlyCircuit(scenario)) {
    const note = document.createElement("small");
    note.textContent = "The wallet proves this only natively. Not part of Run all: click to run.";
    button.append(note);
  }
  button.addEventListener("click", () => void run(scenario.id));
  scenarioButtons.set(scenario.id, button);
  scenariosElement.append(button);
}

/** What Run all proves: every served scenario the wallet would prove in a browser. */
function runAllScenarios(): PerformanceScenario[] {
  return source === undefined ? [] : scenarioList.filter((scenario) =>
    !foldsNativeOnlyCircuit(scenario) && source!.unavailable(scenario.circuits) === undefined);
}

sourcePromise.then((resolved) => {
  source = resolved;
  sourceElement.textContent = resolved.label;
  for (const scenario of scenarioList) {
    const reason = resolved.unavailable(scenario.circuits);
    if (reason === undefined) continue;
    const note = document.createElement("em");
    note.textContent = reason;
    scenarioButtons.get(scenario.id)!.append(note);
  }
  setRunDisabled(false);
}, (error: unknown) => {
  sourceElement.textContent = "unavailable";
  setState("failure", `No asset source: ${describePageError(error)}`);
});

// --- diagnostics that survive a crashed tab ----------------------------------

function navigationType(): string {
  const entry = performance.getEntriesByType("navigation")[0];
  return entry instanceof PerformanceNavigationTiming ? entry.type : "unknown";
}

function readDiagnostic(): LabDiagnostic | undefined {
  try {
    const stored = localStorage.getItem(DIAGNOSTIC_KEY);
    return stored === null ? undefined : JSON.parse(stored) as LabDiagnostic;
  } catch {
    return undefined;
  }
}

function persistDiagnostic(diagnostic: LabDiagnostic): void {
  currentDiagnostic = diagnostic;
  try {
    localStorage.setItem(DIAGNOSTIC_KEY, JSON.stringify(diagnostic));
    downloadDiagnosticsButton.disabled = false;
  } catch {
    // Diagnostics are best-effort when browser storage is unavailable.
  }
}

const previousDiagnostic = readDiagnostic();
if (previousDiagnostic?.state === "running") {
  const interrupted = {
    ...previousDiagnostic,
    state: "interrupted" as const,
    updatedAt: new Date().toISOString(),
    error: "the page loaded while the previous proof run was still marked active",
  };
  persistDiagnostic(interrupted);
  interruptedElement.classList.remove("hidden");
  interruptedResultElement.textContent = JSON.stringify(interrupted, null, 2);
} else if (previousDiagnostic !== undefined) {
  currentDiagnostic = previousDiagnostic;
  downloadDiagnosticsButton.disabled = false;
}

function beginDiagnostic(mode: LabMode, settings: Settings): void {
  const now = new Date().toISOString();
  const random = crypto.getRandomValues(new Uint32Array(2));
  interruptedElement.classList.add("hidden");
  persistDiagnostic({
    runId: `${Date.now()}-${random[0]}-${random[1]}`,
    state: "running",
    startedAt: now,
    updatedAt: now,
    navigationType: navigationType(),
    crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent,
    mode,
    proverLifetime: settings.proverLifetime,
    threads: settings.threads,
    ...(settings.memoryMaximumMiB === undefined ? {} : { memoryMaximumMiB: settings.memoryMaximumMiB }),
    ...(source === undefined ? {} : { source: source.label }),
    visibility: document.visibilityState,
    wakeLockSupported: wakeLockApi !== undefined,
    wakeLockState: wakeLockApi === undefined ? "unsupported" : "idle",
    events: [],
  });
}

function updateDiagnostic(patch: Partial<Omit<LabDiagnostic, "events">>, event?: DiagnosticEvent): void {
  if (currentDiagnostic === undefined) return;
  const events = event === undefined ? currentDiagnostic.events : [...currentDiagnostic.events, event].slice(-100);
  persistDiagnostic({ ...currentDiagnostic, ...patch, updatedAt: new Date().toISOString(), events });
}

function describePageError(error: unknown): string {
  if (error instanceof Error) {
    return [...new Set([
      `${error.name || "Error"}: ${error.message || "(no message)"}`,
      error.stack,
      error.cause === undefined ? undefined : `cause: ${String(error.cause)}`,
    ].filter((part): part is string => typeof part === "string" && part.length > 0))].join("\n");
  }
  if (typeof error === "object" && error !== null) {
    try {
      const properties = Object.fromEntries(
        Reflect.ownKeys(error).map((key) => [String(key), String(Reflect.get(error, key))]),
      );
      return `${Object.prototype.toString.call(error)} ${JSON.stringify(properties)}`;
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}

function wakeLockEvent(message: string): void {
  updateDiagnostic({}, { at: new Date().toISOString(), message, circuit: "screen-wake-lock" });
}

async function acquireScreenWakeLock(): Promise<void> {
  if (
    !proofRunActive
    || wakeLockApi === undefined
    || document.visibilityState !== "visible"
    || screenWakeLock?.released === false
    || wakeLockRequestPending
    || currentDiagnostic?.wakeLockState === "denied"
  ) return;
  wakeLockRequestPending = true;
  updateDiagnostic({ wakeLockState: "requesting" });
  try {
    const lock = await wakeLockApi.request("screen");
    screenWakeLock = lock;
    updateDiagnostic({ wakeLockState: "active" });
    wakeLockEvent("screen wake lock acquired");
    lock.addEventListener("release", () => {
      if (screenWakeLock === lock) screenWakeLock = undefined;
      updateDiagnostic({ wakeLockState: "released" });
      wakeLockEvent("screen wake lock released by the browser or operating system");
    });
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    updateDiagnostic({ wakeLockState: "denied" });
    wakeLockEvent(`screen wake lock unavailable: ${reason}`);
  } finally {
    wakeLockRequestPending = false;
  }
}

async function releaseScreenWakeLock(): Promise<void> {
  proofRunActive = false;
  const lock = screenWakeLock;
  screenWakeLock = undefined;
  if (lock === undefined || lock.released) return;
  try {
    await lock.release();
  } catch {
    // The browser may already have released it while the proof was finishing.
  }
}

// --- rendering -----------------------------------------------------------------

function setState(kind: "running" | "success" | "failure" | "", message: string): void {
  status.className = `status ${kind}`;
  statusText.textContent = message;
}

function cell(text: string, className?: string): HTMLTableCellElement {
  const element = document.createElement("td");
  element.textContent = text;
  if (className !== undefined) element.className = className;
  return element;
}

/** The coarse proving/memory bucket; active gates and opcodes still affect work within it. */
function domainOf(gates: number): string {
  return `2^${Math.max(1, Math.ceil(Math.log2(gates)))}`;
}

/**
 * The primary result. One row per scenario with the number you would quote, and
 * one indented row per circuit showing where it went, from the median run.
 */
function renderSummary(report: LabReport): void {
  if (report.scenarios.length === 0) {
    summaryElement.replaceChildren();
    return;
  }
  const table = document.createElement("table");
  table.className = "summary";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const text of [
    "Scenario", "Gates", "Domain", "Execute", "Prove", "Artifacts",
    "Memory", "Required", "Wall",
  ]) {
    const th = document.createElement("th");
    th.textContent = text;
    th.style.textAlign = text === "Scenario" ? "left" : "right";
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  const excluded = { crsMs: 0, runtimeMs: 0, loadMs: 0, otherMs: 0, downloads: 0 };
  let requiredMs = 0;
  let slowest: ScenarioReport | undefined;
  for (const scenario of report.scenarios) {
    const row = document.createElement("tr");
    const median = medianRun(scenario.runs);
    row.className = median === undefined ? "scenario-row failed" : "scenario-row";
    row.append(cell(scenario.label, "name"));
    if (median === undefined || scenario.summary === undefined) {
      const failure = scenario.error ?? scenario.runs.find((entry) => !entry.ok)?.error ?? "running";
      const oom = scenario.runs.some((entry) => entry.likelyOutOfMemory);
      const memory = scenario.runs.at(-1)?.timing.peakWasmMemoryBytes;
      const message = cell(`${oom ? "likely out of memory" : "failed"}${memory === undefined ? "" : ` (last reading ${mebibytes(memory)})`}: ${failure.split("\n")[0]}`);
      message.colSpan = 8;
      row.append(message);
      body.append(row);
      continue;
    }
    const timing = median.timing;
    for (const entry of scenario.runs) {
      excluded.crsMs += entry.timing.crsMs;
      excluded.runtimeMs += entry.timing.runtimeMs;
      excluded.loadMs += entry.timing.loadMs;
      excluded.otherMs += entry.timing.otherMs;
      if (entry.timing.crsDownloaded) excluded.downloads += 1;
    }
    requiredMs += scenario.summary.requiredMs.median;
    if (slowest?.summary === undefined || scenario.summary.requiredMs.median > slowest.summary.requiredMs.median) slowest = scenario;
    const totalGates = timing.circuits.reduce((sum, entry) => sum + (entry.gates ?? 0), 0);
    const totalOf = (pick: (entry: CircuitTiming) => number) => timing.circuits.reduce((sum, entry) => sum + pick(entry), 0);
    const { min, max, median: quoted } = scenario.summary.requiredMs;
    row.append(
      cell(totalGates === 0 ? "—" : totalGates.toLocaleString(), "num"),
      cell(`2^${Math.log2(scenario.srsPoints)} SRS`, "num"),
      cell(seconds(totalOf((entry) => entry.assembleMs + entry.executeMs)), "num"),
      cell(seconds(totalOf((entry) => entry.proveMs) + timing.stack.proveMs), "num"),
      cell(seconds(totalOf((entry) => entry.artifactsMs) + timing.stack.artifactsMs), "num"),
      cell(scenario.summary.peakWasmMemoryBytes === undefined ? "—" : mebibytes(scenario.summary.peakWasmMemoryBytes), "num"),
      cell(max > min ? `${seconds(quoted)} (${seconds(min)}–${seconds(max)})` : seconds(quoted), "num total"),
      cell(seconds(timing.wallMs), "num"),
    );
    body.append(row);
    for (const entry of timing.circuits) {
      const detail = document.createElement("tr");
      detail.className = "circuit-row";
      detail.append(
        cell(entry.circuit, "name indent"),
        cell(entry.gates === undefined ? "—" : entry.gates.toLocaleString(), "num"),
        cell(entry.gates === undefined ? "—" : domainOf(entry.gates), "num"),
        cell(seconds(entry.assembleMs + entry.executeMs), "num"),
        cell(seconds(entry.proveMs), "num"),
        cell(seconds(entry.artifactsMs), "num"),
        cell(entry.wasmMemoryBytes === undefined ? "—" : mebibytes(entry.wasmMemoryBytes), "num"),
        cell(seconds(entry.assembleMs + entry.executeMs + entry.proveMs + entry.artifactsMs), "num"),
        cell("", "num"),
      );
      body.append(detail);
    }
    const detail = document.createElement("tr");
    detail.className = "circuit-row";
    detail.append(
      cell("CHONK final proof", "name indent"),
      cell("—", "num"),
      cell("—", "num"),
      cell(seconds(0), "num"),
      cell(seconds(timing.stack.proveMs), "num"),
      cell(seconds(timing.stack.artifactsMs), "num"),
      cell(timing.peakWasmMemoryBytes === undefined ? "—" : mebibytes(timing.peakWasmMemoryBytes), "num"),
      cell(seconds(timing.stack.proveMs + timing.stack.artifactsMs), "num"),
      cell("", "num"),
    );
    body.append(detail);
  }
  table.append(head, body);
  const scroller = document.createElement("div");
  scroller.className = "table-scroll";
  scroller.append(table);

  const headline = document.createElement("p");
  headline.className = "headline";
  const measured = report.scenarios.filter((scenario) => scenario.summary !== undefined);
  const parts = [`${measured.length} of ${report.scenarios.length} scenario${report.scenarios.length === 1 ? "" : "s"}`, `${seconds(requiredMs)} required`];
  if (slowest?.summary !== undefined && measured.length > 1) parts.push(`slowest ${slowest.label} at ${seconds(slowest.summary.requiredMs.median)}`);
  headline.textContent = parts.join(" · ");

  const note = document.createElement("p");
  note.className = "counting";
  const outside = [
    "verification, which the network does anyway",
    excluded.runtimeMs > 0 ? `${seconds(excluded.runtimeMs)} of prover startup` : undefined,
    excluded.loadMs > 0 ? `${seconds(excluded.loadMs)} of circuit loading` : undefined,
    excluded.crsMs > 0 ? `${seconds(excluded.crsMs)} of proving parameters${excluded.downloads > 0 ? ` (${excluded.downloads} download${excluded.downloads === 1 ? "" : "s"})` : ""}` : undefined,
    excluded.otherMs > 0 ? `${seconds(excluded.otherMs)} unattributed (worker round trips, scheduling)` : undefined,
  ].filter((part): part is string => part !== undefined);
  note.textContent = "Every figure is measured around the operation itself. "
    + "Required is witness execution, folding, the final proof, and recursion artifacts; with several runs it is the median, with the range in brackets, and the breakdown is the median run. "
    + "Memory is the prover's Wasm memory after each step; the scenario row is its peak. "
    + (report.settings.proverLifetime === "one-shot"
      ? "One-shot mode creates a fresh prover for every run, as the website does. "
      : "Warm mode reuses one prover across consecutive runs with the same SRS profile. ")
    + `Reported outside Required, summed over all runs: ${outside.join("; ")}.`;
  summaryElement.replaceChildren(headline, note, scroller);
}

function renderPhases(phases: Array<{ elapsedMs: number; message: string }>): void {
  phasesElement.replaceChildren(...phases.map((phase) => {
    const row = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = seconds(phase.elapsedMs);
    const text = document.createElement("span");
    text.className = "phase";
    text.textContent = phase.message;
    row.append(time, text);
    return row;
  }));
}

function renderReports(): void {
  const reports = lastReport === undefined || comparedReports.some((report) => report.runId === lastReport!.runId)
    ? comparedReports
    : [...comparedReports, lastReport];
  renderComparison(reports, compareElement);
}

function setRunDisabled(disabled: boolean): void {
  const ready = !disabled && source !== undefined;
  for (const scenario of scenarioList) {
    scenarioButtons.get(scenario.id)!.disabled = !ready || source!.unavailable(scenario.circuits) !== undefined;
  }
  runAllButton.disabled = !ready || runAllScenarios().length === 0;
  setupButton.disabled = !ready;
  for (const control of [clearButton, lifecycleSelect, threadsSelect, memoryLimitSelect, runsSelect, deviceNameInput]) {
    control.disabled = disabled;
  }
}

function takeRunLock(): boolean {
  if (runInProgress || source === undefined) return false;
  runInProgress = true;
  setRunDisabled(true);
  return true;
}

function releaseRunLock(): void {
  runInProgress = false;
  setRunDisabled(false);
}

// --- running -------------------------------------------------------------------

function readSettings(): Settings {
  const requestedThreads = threadsSelect.value === "auto" ? "auto" : Number(threadsSelect.value);
  const selectedMemory = memoryLimitSelect.value === "auto" ? "auto" : Number(memoryLimitSelect.value);
  const pages = memoryMaximumPages(selectedMemory);
  return {
    proverLifetime: lifecycleSelect.value === "warm" ? "warm" : "one-shot",
    threads: normalizeProverThreads(requestedThreads, navigator.hardwareConcurrency),
    ...(selectedMemory === "auto" ? {} : { memoryMaximumMiB: selectedMemory }),
    ...(pages === undefined ? {} : { memoryMaximumPages: pages }),
    runs: Number(runsSelect.value),
  };
}

function createProver(settings: Settings, srsPoints: SupportedSrsPoints): BrowserProverSession {
  return createBrowserProverSession({
    srsPoints,
    threads: settings.threads,
    reportWasmMemory: true,
    allowNativeOnlyCircuits: true,
    ...(settings.memoryMaximumPages === undefined ? {} : { memoryMaximumPages: settings.memoryMaximumPages }),
  }, source!.assetSource, LINEAGE_CIRCUIT_PROFILES);
}

async function deviceDetails(): Promise<Pick<LabReport["device"], "model" | "platform">> {
  const userAgentData = (navigator as Navigator & {
    userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ model?: string; platform?: string; platformVersion?: string }> };
  }).userAgentData;
  if (userAgentData === undefined) return {};
  try {
    const values = await userAgentData.getHighEntropyValues(["model", "platformVersion"]);
    return {
      ...(values.model ? { model: values.model } : {}),
      ...(values.platform ? { platform: `${values.platform} ${values.platformVersion ?? ""}`.trim() } : {}),
    };
  } catch {
    return {};
  }
}

async function newReport(settings: Settings): Promise<LabReport> {
  const random = crypto.getRandomValues(new Uint32Array(2));
  const name = deviceNameInput.value.trim();
  return {
    kind: "pcash-proof-lab",
    runId: `${Date.now()}-${random[0]}-${random[1]}`,
    startedAt: new Date().toISOString(),
    device: {
      ...(name === "" ? {} : { name }),
      userAgent: navigator.userAgent,
      ...await deviceDetails(),
      hardwareConcurrency: navigator.hardwareConcurrency,
      ...(deviceMemory === undefined ? {} : { deviceMemoryGiB: deviceMemory }),
      crossOriginIsolated,
    },
    settings: {
      proverLifetime: settings.proverLifetime,
      threads: settings.threads,
      ...(settings.memoryMaximumMiB === undefined ? {} : { memoryMaximumMiB: settings.memoryMaximumMiB }),
      runs: settings.runs,
    },
    source: {
      kind: source!.kind,
      label: source!.label,
      assetSetId: source!.assetSource.assetSetId,
      ...(source!.bundleDigest === undefined ? {} : { bundleDigest: source!.bundleDigest }),
      ...(source!.rpcUrl === undefined ? {} : { rpcUrl: source!.rpcUrl }),
    },
    scenarios: [],
  };
}

function prepareScenario(scenario: PerformanceScenario) {
  let entry = prepared.get(scenario.id);
  if (entry === undefined) {
    const started = performance.now();
    entry = scenario.prepare(source!.context).then((value) => ({
      scenario: value,
      prepareMs: Math.round(performance.now() - started),
    }));
    // A failed preparation is retried on the next click rather than cached.
    entry.catch(() => prepared.delete(scenario.id));
    prepared.set(scenario.id, entry);
  }
  return entry;
}

async function proofDigest(proof: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(proof.length);
  bytes.set(proof);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer));
  return `0x${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function runOnce(
  scenario: PerformanceScenario,
  preparedScenario: PreparedScenario,
  prover: BrowserProverSession,
  label: string,
): Promise<RunResult> {
  const started = performance.now();
  const marks: ProveStatus[] = [];
  // The log shows the run in progress; the report keeps every measurement.
  const phases: Array<{ elapsedMs: number; message: string }> = [];
  const onStatus = (progress: ProveStatus) => {
    marks.push(progress);
    updateDiagnostic({}, {
      at: new Date().toISOString(),
      scenario: scenario.id,
      message: progress.message,
      ...(progress.step === undefined ? {} : { step: progress.step }),
      ...(progress.scope === undefined ? {} : { scope: progress.scope }),
      ...(progress.circuit === undefined ? {} : { circuit: progress.circuit }),
      ...(progress.durationMs === undefined ? {} : { durationMs: progress.durationMs }),
      ...(progress.wasmMemoryBytes === undefined ? {} : { wasmMemoryBytes: progress.wasmMemoryBytes }),
    });
    // A measurement arrives after its work; the log shows what is happening now.
    if (progress.durationMs !== undefined) return;
    phases.push({ elapsedMs: Math.round(performance.now() - started), message: `${label}: ${progress.message}` });
    renderPhases(phases);
    setState("running", `${label}: ${progress.message}`);
  };
  try {
    const proof = await preparedScenario.run(prover, onStatus);
    return {
      ok: true,
      timing: summarizeRun(marks, Math.round(performance.now() - started), source!.gates, scenario.circuits),
      proofBytes: proof.proof.length,
      proofSha256: await proofDigest(proof.proof),
    };
  } catch (error) {
    const text = describePageError(error);
    return {
      ok: false,
      timing: summarizeRun(marks, Math.round(performance.now() - started), source!.gates, scenario.circuits),
      error: text,
      likelyOutOfMemory: looksOutOfMemory(text),
    };
  }
}

async function publishReport(report: LabReport): Promise<void> {
  lastReport = report;
  resultElement.textContent = JSON.stringify(report, null, 2);
  shareButton.disabled = false;
  downloadButton.disabled = false;
  renderReports();
  if (!savesResults) return;
  try {
    const response = await fetch(new URL("results", window.location.href), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    const body = await response.json() as { path?: string; error?: string };
    savedElement.textContent = response.ok ? `Saved on the lab machine: ${body.path}` : `Not saved: ${body.error ?? response.status}`;
  } catch (error) {
    savedElement.textContent = `Not saved: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function run(mode: PerformanceScenarioId | "all"): Promise<void> {
  if (!takeRunLock()) return;
  const settings = readSettings();
  beginDiagnostic(mode, settings);
  proofRunActive = true;
  await acquireScreenWakeLock();
  const invocationStarted = performance.now();
  const report = await newReport(settings);
  let warm: { prover: BrowserProverSession; srsPoints: SupportedSrsPoints } | undefined;
  try {
    if (!crossOriginIsolated) throw new Error("This page is not cross-origin isolated");
    shareButton.disabled = true;
    downloadButton.disabled = true;
    savedElement.textContent = "";
    phasesElement.replaceChildren();
    meter.style.width = "2%";
    const selected = mode === "all" ? runAllScenarios() : scenarioList.filter((scenario) => scenario.id === mode);
    const totalRuns = selected.length * settings.runs;
    let completedRuns = 0;
    for (const scenario of selected) {
      const srsPoints = source!.srsPoints(scenario.circuits);
      const scenarioReport: ScenarioReport = {
        id: scenario.id,
        label: scenario.label,
        circuits: scenario.circuits,
        srsPoints,
        gates: Object.fromEntries(scenario.circuits
          .filter((circuit) => source!.gates[circuit] !== undefined)
          .map((circuit) => [circuit, source!.gates[circuit]!])),
        runs: [],
      };
      report.scenarios.push(scenarioReport);
      updateDiagnostic({ scenario: scenario.id, srsPoints });
      setState("running", `${scenario.label}: preparing witnesses`);
      let preparedScenario: PreparedScenario;
      try {
        const entry = await prepareScenario(scenario);
        preparedScenario = entry.scenario;
        scenarioReport.prepareMs = entry.prepareMs;
        scenarioReport.privateValueCommitment = `0x${preparedScenario.privateValueCommitment.toString(16)}`;
        if (preparedScenario.assetId !== undefined) scenarioReport.assetId = `0x${preparedScenario.assetId.toString(16)}`;
      } catch (error) {
        scenarioReport.error = describePageError(error);
        completedRuns += settings.runs;
        renderSummary(report);
        continue;
      }
      for (let index = 0; index < settings.runs; index += 1) {
        let prover: BrowserProverSession;
        if (settings.proverLifetime === "one-shot") {
          prover = createProver(settings, srsPoints);
        } else {
          if (warm?.srsPoints !== srsPoints) {
            warm?.prover.destroy();
            warm = { prover: createProver(settings, srsPoints), srsPoints };
          }
          prover = warm.prover;
        }
        const label = settings.runs === 1 ? scenario.label : `${scenario.label} ${index + 1}/${settings.runs}`;
        let result: RunResult;
        try {
          result = await runOnce(scenario, preparedScenario, prover, label);
        } finally {
          if (settings.proverLifetime === "one-shot") prover.destroy();
        }
        if (!result.ok && settings.proverLifetime === "warm") {
          // A failed warm prover may be unusable; the next run gets a fresh one.
          warm?.prover.destroy();
          warm = undefined;
        }
        scenarioReport.runs.push(result);
        const summary = summarizeScenario(scenarioReport.runs);
        if (summary === undefined) delete scenarioReport.summary;
        else scenarioReport.summary = summary;
        completedRuns += 1;
        meter.style.width = `${Math.round((completedRuns / totalRuns) * 100)}%`;
        renderSummary(report);
      }
    }
    report.finishedAt = new Date().toISOString();
    const failed = report.scenarios.filter((scenario) => scenario.summary === undefined).length;
    const measured = report.scenarios.length - failed;
    const requiredMs = report.scenarios.reduce((sum, scenario) => sum + (scenario.summary?.requiredMs.median ?? 0), 0);
    setState(
      failed === 0 ? "success" : "failure",
      `${measured} measured${failed === 0 ? "" : `, ${failed} failed`} · ${seconds(requiredMs)} required · ${seconds(performance.now() - invocationStarted)} total`,
    );
    updateDiagnostic({ state: failed === 0 ? "complete" : "failed", scenario: undefined, srsPoints: undefined });
    await publishReport(report);
  } catch (error) {
    const text = describePageError(error);
    updateDiagnostic({ state: "failed", error: text });
    setState("failure", error instanceof Error ? error.message : String(error));
    report.finishedAt = new Date().toISOString();
    await publishReport(report);
  } finally {
    warm?.prover.destroy();
    await releaseScreenWakeLock();
    meter.style.width = "100%";
    releaseRunLock();
  }
}

async function runSetupOnly(): Promise<void> {
  if (!takeRunLock()) return;
  const settings = readSettings();
  beginDiagnostic("setup", settings);
  proofRunActive = true;
  await acquireScreenWakeLock();
  phasesElement.replaceChildren();
  meter.style.width = "10%";
  const started = performance.now();
  const phases: Array<{ elapsedMs: number; message: string }> = [];
  const marks: ProveStatus[] = [];
  const prover = createProver(settings, 2 ** 18);
  try {
    if (!crossOriginIsolated) throw new Error("This page is not cross-origin isolated");
    await prover.setup((progress) => {
      marks.push(progress);
      updateDiagnostic({}, {
        at: new Date().toISOString(),
        message: progress.message,
        ...(progress.step === undefined ? {} : { step: progress.step }),
        ...(progress.circuit === undefined ? {} : { circuit: progress.circuit }),
        ...(progress.durationMs === undefined ? {} : { durationMs: progress.durationMs }),
      });
      if (progress.durationMs !== undefined) return;
      phases.push({ elapsedMs: Math.round(performance.now() - started), message: progress.message });
      renderPhases(phases);
      setState("running", progress.message);
    });
    const timing = summarizeRun(marks, Math.round(performance.now() - started), {}, []);
    const parts = Object.entries(timing.runtime).map(([part, ms]) => `${part} ${seconds(ms)}`);
    setState("success", `2¹⁸ prover initialized in ${seconds(timing.wallMs)}: parameters ${seconds(timing.crsMs)}${timing.crsDownloaded ? " (downloaded)" : ""}, ${parts.join(", ")}`);
    resultElement.textContent = JSON.stringify(timing, null, 2);
    updateDiagnostic({ state: "complete", srsPoints: undefined });
  } catch (error) {
    const text = describePageError(error);
    setState("failure", error instanceof Error ? error.message : String(error));
    resultElement.textContent = text;
    updateDiagnostic({ state: "failed", error: text });
  } finally {
    prover.destroy();
    await releaseScreenWakeLock();
    meter.style.width = "100%";
    releaseRunLock();
  }
}

// --- sharing and comparison ----------------------------------------------------

function reportFileName(report: LabReport): string {
  const device = (report.device.name ?? "device").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "device";
  return `pcash-proof-lab-${device}-${report.startedAt.replace(/[:.]/g, "-")}.json`;
}

function downloadJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** A phone's share sheet where available, then the clipboard, then a download. */
async function shareReport(report: LabReport): Promise<void> {
  const text = JSON.stringify(report, null, 2);
  const file = new File([text], reportFileName(report), { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "PCASH proof lab result" });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    setState("success", "Result JSON copied to the clipboard");
    return;
  } catch {
    downloadJson(reportFileName(report), report);
  }
}

function addReports(reports: readonly LabReport[]): void {
  const known = new Set(comparedReports.map((report) => report.runId));
  comparedReports = [...comparedReports, ...reports.filter((report) => !known.has(report.runId))];
  renderReports();
}

runAllButton.addEventListener("click", () => void run("all"));
setupButton.addEventListener("click", () => void runSetupOnly());
shareButton.addEventListener("click", () => {
  if (lastReport !== undefined) void shareReport(lastReport);
});
downloadButton.addEventListener("click", () => {
  if (lastReport !== undefined) downloadJson(reportFileName(lastReport), lastReport);
});
downloadDiagnosticsButton.addEventListener("click", () => {
  if (currentDiagnostic !== undefined) downloadJson("pcash-proof-lab-diagnostics.json", currentDiagnostic);
});
loadSavedButton.addEventListener("click", () => {
  void fetch(new URL("results", window.location.href)).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    addReports(parseReports(await response.text()));
  }).catch((error: unknown) => setState("failure", `Could not load saved results: ${describePageError(error)}`));
});
resultFilesInput.addEventListener("change", () => {
  void Promise.all([...resultFilesInput.files ?? []].map(async (file) => parseReports(await file.text())))
    .then((lists) => addReports(lists.flat()))
    .catch((error: unknown) => setState("failure", `Could not read result files: ${describePageError(error)}`));
});
clearButton.addEventListener("click", () => {
  const request = indexedDB.deleteDatabase(BROWSER_CRS_DATABASE);
  request.onsuccess = () => setState("", "Cached proving parameters cleared");
  request.onerror = () => setState("failure", "Failed to clear cached proving parameters");
});

document.addEventListener("visibilitychange", () => {
  updateDiagnostic({ visibility: document.visibilityState });
  if (document.visibilityState === "visible") void acquireScreenWakeLock();
});
window.addEventListener("pagehide", () => {
  updateDiagnostic({ pageHiddenAt: new Date().toISOString(), visibility: document.visibilityState });
});
window.addEventListener("error", (event) => {
  if (currentDiagnostic?.state !== "running") return;
  const error = event.error === undefined ? event.message || "uncaught page error" : describePageError(event.error);
  updateDiagnostic({ state: "failed", error });
});
window.addEventListener("unhandledrejection", (event) => {
  if (currentDiagnostic?.state !== "running") return;
  updateDiagnostic({ state: "failed", error: describePageError(event.reason ?? "unhandled promise rejection") });
});
setRunDisabled(true);
