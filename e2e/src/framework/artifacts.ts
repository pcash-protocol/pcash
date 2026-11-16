import { chmod, lstat, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { redactEvidence, redactText } from "./redact.ts";

export class ScenarioArtifacts {
  readonly root: string;
  readonly logs: string;
  readonly evidence: Array<Record<string, unknown>> = [];
  readonly explicitlyKept: boolean;

  private constructor(root: string, explicitlyKept: boolean) {
    this.root = root;
    this.logs = join(root, "logs");
    this.explicitlyKept = explicitlyKept;
  }

  static async create(
    name: string,
    exactRoot?: string,
    keep = false,
  ): Promise<ScenarioArtifacts> {
    const root = exactRoot !== undefined
      ? await preparePrivateRunDirectory(exactRoot)
      : await mkdtemp(join(tmpdir(), `pcash-e2e-${safeName(name)}-`));
    if (!isAbsolute(root)) throw new Error("scenario artifact directory must resolve to an absolute path");
    await mkdir(join(root, "logs"), { recursive: true, mode: 0o700 });
    return new ScenarioArtifacts(
      root,
      exactRoot !== undefined || keep,
    );
  }

  path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  record(event: string, detail: Record<string, unknown> = {}): void {
    this.evidence.push({ at: new Date().toISOString(), event, ...detail });
  }

  async finish(failure?: unknown): Promise<{ preserved: boolean; path: string }> {
    const payload = redactEvidence({
      complete: failure === undefined,
      failure: failure === undefined
        ? undefined
        : redactText(failure instanceof Error ? failure.stack ?? failure.message : String(failure)),
      events: this.evidence,
    });
    await writeFile(join(this.root, "evidence.json"), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    const preserved = failure !== undefined || this.explicitlyKept;
    if (!preserved) await rm(this.root, { recursive: true, force: true });
    return { preserved, path: this.root };
  }
}

/** Create, or accept only an empty, ordinary, current-user run directory. */
export async function preparePrivateRunDirectory(path: string): Promise<string> {
  if (path.trim() === "") throw new Error("run output directory must not be blank");
  const root = resolve(path);
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const details = await lstat(root);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(`run output path ${root} must be an ordinary directory`);
    }
    if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
      throw new Error(`run output directory ${root} is not owned by the current user`);
    }
    if ((await readdir(root)).length !== 0) {
      throw new Error(`run output directory ${root} must be newly created or empty`);
    }
  }
  await chmod(root, 0o700);
  return root;
}

function safeName(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return safe === "" ? "scenario" : safe;
}
