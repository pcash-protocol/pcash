import { useState, type FormEvent } from "react";
import { PcashNodeClient } from "@pcash/sdk/clients";
import { browserNetwork, parseEndpoint, type NetworkProfile } from "../lib/networks.ts";
import { l1RpcChanges, l1RpcList, savedRpcEndpoints, saveRpcEndpoints, useWebsiteSettings, type L1RpcChoice, type RpcEndpoints } from "../lib/WebsiteSettings.tsx";
import { requestSiteDataClear } from "../lib/siteStorage.ts";
import { Tooltip } from "./Tooltip.tsx";
import { SubmissionModeControl } from "./SubmissionModeControl.tsx";
import styles from "./WalletSettings.module.css";

export function SettingsSwitch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange(value: boolean): void }) {
  return <button type="button" role="switch" className={styles.switch} aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
    <span aria-hidden="true" className={styles.track}><span className={styles.thumb} /></span>
    <span aria-hidden="true">{checked ? "On" : "Off"}</span>
  </button>;
}
export function WalletSettings({ onBack }: { onBack(): void }) {
  const settings = useWebsiteSettings();
  return <section className={styles.settings} aria-label="Wallet settings">
    <button type="button" className={styles.back} onClick={onBack}>← Back</button>
    <h2 data-wallet-heading tabIndex={-1}>Settings</h2>
    <div className={styles.row}><Tooltip tip="Shows ENS, .gwei and .wei names and avatars for addresses, and lets you pay a name. Lookups send names and addresses to naming services and are cached in this browser.">{(id) =>
      <button type="button" className={styles.nameHelp} aria-label="About ENS names" aria-describedby={id}>Show ENS names <span className={styles.info} aria-hidden="true">?</span></button>}</Tooltip>
      <SettingsSwitch label="Show ENS names" checked={settings.ensEnabled} onChange={settings.setEnsEnabled} /></div>
    <SubmissionModeControl label="Default speed" value={settings.defaultSubmissionMode} onChange={settings.setDefaultSubmissionMode} />
    <p>New transactions start at this speed. You can change it for each one.</p>
    <ClearSiteData />
    <details className={styles.advanced}><summary>Advanced</summary><RpcSettings /></details>
  </section>;
}
async function jsonRpc(url: string, method: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }), signal: controller.signal });
    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (body.error !== undefined) throw new Error(body.error.message ?? "RPC error");
    return body.result;
  } finally {
    clearTimeout(timeout);
  }
}

/** Rejects an endpoint that does not serve this deployment's network. */
export async function checkRpcEndpoints(network: NetworkProfile, endpoints: RpcEndpoints): Promise<void> {
  const reach = async <T,>(label: string, read: () => Promise<T>) => {
    try { return await read(); } catch { throw new Error(`Could not reach the ${label}.`); }
  };
  await Promise.all([
    endpoints.pcashRpcUrl === undefined ? undefined : (async () => {
      const status = await reach("PCASH node", () => new PcashNodeClient(endpoints.pcashRpcUrl!).status());
      if (status.pcashChainId !== network.pcashChainId || status.l1ChainId !== BigInt(network.l1ChainId)
        || (network.genesisHash !== undefined && status.genesisHash.toLowerCase() !== network.genesisHash.toLowerCase())) {
        throw new Error(`That PCASH node serves a different network than ${network.name}.`);
      }
      // Every proof this website makes loads its circuits from the node.
      if (status.proverAssets === null) throw new Error("That PCASH node does not serve prover assets, so this website cannot make proofs with it.");
    })(),
    // The deployment's own Ethereum RPCs are its operator's to check; the ones this browser adds are checked here.
    ...(endpoints.l1Rpcs?.added ?? []).filter((rpc) => rpc.enabled).map(async ({ url }) => {
      const chainId = await reach(`Ethereum RPC at ${url}`, () => jsonRpc(url, "eth_chainId"));
      if (typeof chainId !== "string" || BigInt(chainId) !== BigInt(network.l1ChainId)) {
        throw new Error(`The Ethereum RPC at ${url} serves a different chain than ${network.name}.`);
      }
    }),
  ]);
}

function withAddedL1Rpc(list: L1RpcChoice[], value: string): L1RpcChoice[] {
  const url = parseEndpoint(value.trim(), "Ethereum RPC URL");
  if (list.some((rpc) => rpc.url === url)) throw new Error("That Ethereum RPC is already in the list.");
  return [...list, { url, enabled: true }];
}

function RpcSettings() {
  const [defaults] = useState(browserNetwork);
  const [saved] = useState(() => savedRpcEndpoints());
  const [pcashRpcUrl, setPcashRpcUrl] = useState(saved.pcashRpcUrl ?? "");
  const [l1Rpcs, setL1Rpcs] = useState(() => l1RpcList(defaults.l1RpcUrls, saved.l1Rpcs));
  const [adding, setAdding] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const apply = async (endpoints: RpcEndpoints) => {
    setChecking(true); setError(undefined);
    try {
      if (endpoints.pcashRpcUrl !== undefined) parseEndpoint(endpoints.pcashRpcUrl, "PCASH node RPC URL");
      await checkRpcEndpoints(defaults, endpoints);
      saveRpcEndpoints(endpoints);
      // Every client starts on the new endpoints; the saved sign-in survives the reload.
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setChecking(false);
    }
  };
  /** The list with the URL in the add field appended, or undefined after reporting why it cannot be. */
  const add = (): L1RpcChoice[] | undefined => {
    try {
      // Listed as it will be saved: a deployment endpoint that was removed returns to its place.
      const next = l1RpcList(defaults.l1RpcUrls, l1RpcChanges(defaults.l1RpcUrls, withAddedL1Rpc(l1Rpcs, adding)));
      setL1Rpcs(next); setAdding(""); setError(undefined);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return undefined;
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // A URL still in the add field is part of what is being saved.
    const list = adding.trim() === "" ? l1Rpcs : add();
    if (list === undefined) return;
    if (!list.some((rpc) => rpc.enabled)) { setError("Keep at least one Ethereum RPC on."); return; }
    const changes = l1RpcChanges(defaults.l1RpcUrls, list);
    const pcash = pcashRpcUrl.trim();
    void apply({ ...(pcash === "" ? {} : { pcashRpcUrl: pcash }), ...(changes === undefined ? {} : { l1Rpcs: changes }) });
  };
  const customized = saved.pcashRpcUrl !== undefined || saved.l1Rpcs !== undefined;
  return <form className={styles.rpc} aria-label="RPC endpoints" onSubmit={submit}>
    <label>PCASH node RPC URL<input type="url" value={pcashRpcUrl} disabled={checking} placeholder={defaults.pcashRpcUrl} onChange={(event) => setPcashRpcUrl(event.target.value)} /></label>
    <fieldset className={styles.rpcList}>
      <legend>Ethereum RPCs</legend>
      <ul>{l1Rpcs.map((rpc) => <li key={rpc.url} className={rpc.enabled ? undefined : styles.rpcOff}>
        <span className={styles.rpcUrl}>{rpc.url}</span>
        {!rpc.enabled && <button type="button" className={styles.rpcRemove} disabled={checking} aria-label={`Remove ${rpc.url}`}
          onClick={() => setL1Rpcs(l1Rpcs.filter((other) => other !== rpc))}>Remove</button>}
        <SettingsSwitch label={`Use ${rpc.url}`} checked={rpc.enabled} disabled={checking}
          onChange={(enabled) => setL1Rpcs(l1Rpcs.map((other) => other === rpc ? { ...rpc, enabled } : other))} />
      </li>)}</ul>
      <div className={styles.rpcAdd}>
        <input type="url" aria-label="Ethereum RPC URL to add" value={adding} disabled={checking} placeholder="https://"
          onChange={(event) => setAdding(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
        <button type="button" className="button" disabled={checking} onClick={add}>Add</button>
      </div>
      <p>Tried in the order listed: the next is used when one fails. Turn one off to stop using it; it stays here until you remove it.</p>
    </fieldset>
    <p>Optional. Use your own endpoints instead of the shared public ones. They are stored in this browser and must serve {defaults.name}, and the PCASH node must serve prover assets. Saving reloads the page.</p>
    {error !== undefined && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.confirm}>
      <button type="submit" className="button primary" disabled={checking}>{checking ? "Checking…" : "Save"}</button>
      {customized && <button type="button" className="button" disabled={checking} onClick={() => void apply({})}>Use defaults</button>}
    </div>
  </form>;
}

function ClearSiteData() {
  const [confirming, setConfirming] = useState(false);
  return <div className={styles.clearData}>
    <strong>Clear site data</strong>
    <p>If the website behaves strangely, clear everything it stores in this browser and reload. This removes saved sign-ins, settings, cached wallet data, and records of unfinished transactions and Marketplace trades. Sign in again to recover your balance from the network.</p>
    {confirming ? <div className={styles.confirm} role="group" aria-label="Confirm clearing site data">
      <button type="button" className="button primary" onClick={requestSiteDataClear}>Clear and reload</button>
      <button type="button" className="button" onClick={() => setConfirming(false)}>Cancel</button>
    </div> : <button type="button" className="button" onClick={() => setConfirming(true)}>Clear site data</button>}
  </div>;
}
