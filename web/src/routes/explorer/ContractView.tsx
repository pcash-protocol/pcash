import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { friendlyError } from "../../components/friendlyError.ts";
import { Link } from "react-router-dom";
import { stringify } from "viem";
import type {
  ContractSourceBundle,
  ContractSourceView,
  ImplementationSourceFile,
  ImplementationSourceView,
  PublishedContractConfigurationFieldPresentation,
  PublishedContractFunctionPresentation,
  PublishedContractPresentationProfile,
  PublishedConfigurationOpening,
  PublishedImplementation,
} from "@pcash/sdk/clients";
import {
  contractBlockHash,
  contractBlockNumber,
  contractFunctionSetCommitment,
  implementationFor,
  implementationSourceState,
  quantity,
  reproductionCommand,
  selectedFunction,
  selectorHex,
} from "./model.ts";
import { shortHex } from "./format.ts";
import {
  formatPresentedValue,
  formatNoirAbiType,
  isConfigurationSalt,
  orderSourceFiles,
  presentationAttribution,
  type LoadedSourceFile,
} from "./contractUx.ts";
import { useReadyExplorer, type ExplorerReader } from "./ExplorerProvider.tsx";
import { pscanIdentityMatches } from "./rpc.ts";
import { CopyButton } from "../../components/CopyButton.tsx";
import { AddressDisplay, Failure, Hash, Loading } from "./ui.tsx";
import styles from "./ExplorerRoute.module.css";
import layout from "./ContractView.module.css";
import { AccountAvatar } from "../../components/AccountAvatar.tsx";
import { EtherAmount } from "../../components/EtherAmount.tsx";
import { PcashAmount } from "../../components/PcashAmount.tsx";
import { Metadata } from "../Metadata.tsx";

type ContractTab = "overview" | "source" | "activity";

type ConfigurationFieldPresentation = PublishedContractConfigurationFieldPresentation;
type FunctionPresentation = PublishedContractFunctionPresentation;
type ContractPresentationProfile = PublishedContractPresentationProfile;

function json(value: unknown): string {
  return stringify(value, null, 2);
}

function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function implementationName(summary: PublishedImplementation | undefined, selector: number): string {
  if (summary === undefined) return `Function ${selectorHex(selector)}`;
  const parts = summary.implementationLabel.split(".");
  return parts[parts.length - 1] || summary.implementationLabel;
}

function ImplementationDetails({ summary }: { summary: PublishedImplementation }) {
  return <dl className={styles.keyValue}>
    <dt>Application VK hash</dt><dd><Hash value={summary.applicationVkHash} /></dd>
    <dt>Source bundle digest</dt><dd><Hash value={summary.sourceBundleDigest} /></dd>
    <dt>Decoded ACIR SHA-256</dt><dd><Hash value={summary.decodedAcirSha256} /></dd>
    <dt>Noir proving ABI SHA-256</dt><dd><Hash value={summary.noirProvingAbiSha256} /></dd>
    <dt>Verification-key SHA-256</dt><dd><Hash value={summary.verificationKeySha256} /></dd>
    <dt>Package</dt><dd><code className={styles.mono}>{summary.packageName}</code> in <code className={styles.mono}>{summary.packageRoot}</code></dd>
    <dt>Toolchain</dt><dd>Nargo {summary.toolchain.nargo.version} · Barretenberg {summary.toolchain.barretenberg.version} · {summary.toolchain.barretenberg.verifierTarget}</dd>
  </dl>;
}

function useSourceFiles(reader: ExplorerReader, source: ImplementationSourceView) {
  const [files, setFiles] = useState<ImplementationSourceFile[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    setFiles(undefined);
    setError(undefined);
    void Promise.all(source.sourceFiles.map(async ({ path }) => {
      const file = await reader.sourceFile(source.implementation.applicationVkHash, path);
      if (file === null) throw new Error(`Source file ${path} is unavailable.`);
      return file;
    })).then((loaded) => {
      if (!cancelled) setFiles(loaded);
    }).catch((cause) => {
      if (!cancelled) setError(friendlyError(cause));
    });
    return () => { cancelled = true; };
  }, [reader, source]);
  return { files, error };
}

const NOIR_TOKENS = /\/\/.*$|"(?:\\.|[^"\\])*"|0x[0-9a-fA-F]+|\b\d+\b|\b(?:pub|fn|struct|impl|trait|use|mod|let|mut|for|in|if|else|constrain|global|comptime|return_data|as)\b|\b[A-Z][A-Za-z0-9_]*\b|\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/g;

function tokenClass(token: string): string | undefined {
  if (token.startsWith("//")) return styles.syntaxComment;
  if (token.startsWith("\"")) return styles.syntaxString;
  if (/^(?:0x|\d)/.test(token)) return styles.syntaxNumber;
  if (/^(?:pub|fn|struct|impl|trait|use|mod|let|mut|for|in|if|else|constrain|global|comptime|return_data|as)$/.test(token)) return styles.syntaxKeyword;
  if (/^[A-Z]/.test(token)) return styles.syntaxType;
  return styles.syntaxFunction;
}

function HighlightedNoir({ content }: { content: string }) {
  return <pre className={styles.sourceCode}>{content.split("\n").map((line, lineIndex) => {
    const pieces: ReactNode[] = [];
    let cursor = 0;
    for (const match of line.matchAll(NOIR_TOKENS)) {
      const index = match.index;
      if (index > cursor) pieces.push(line.slice(cursor, index));
      pieces.push(<span className={tokenClass(match[0])} key={`${index}:${match[0]}`}>{match[0]}</span>);
      cursor = index + match[0].length;
    }
    if (cursor < line.length) pieces.push(line.slice(cursor));
    return <span className={styles.sourceLine} key={lineIndex}>{pieces}{"\n"}</span>;
  })}</pre>;
}

/** A path that wraps after a slash rather than inside a name. */
function SourcePath({ path }: { path: string }) {
  return <code>{path.split("/").map((part, index) => <Fragment key={index}>{index > 0 && <>/<wbr /></>}{part}</Fragment>)}</code>;
}

function SourceFileCard({ file, kind }: { file: LoadedSourceFile; kind: string }) {
  return <article className={styles.sourceFile}>
    <header><span><SourcePath path={file.path} /><small>{kind}</small></span><span><CopyButton value={file.content} label={`Copy ${file.path}`} /><button type="button" onClick={() => download(file.path.split("/").pop() ?? "source.nr", file.content, "text/plain")}>Download</button></span></header>
    <HighlightedNoir content={file.content} />
  </article>;
}

function SourceCode({ reader, source, summary, onDownloadBundle }: { reader: ExplorerReader; source: ImplementationSourceView; summary: PublishedImplementation; onDownloadBundle?: (() => void) | undefined }) {
  const loaded = useSourceFiles(reader, source);
  const groups = useMemo(() => loaded.files === undefined ? undefined : orderSourceFiles(summary.packageRoot, loaded.files), [loaded.files, summary.packageRoot]);
  if (loaded.error) return <Failure>{loaded.error}</Failure>;
  if (groups === undefined) return <Loading>Loading complete source…</Loading>;
  return <>
    {groups.application.length > 0 && <section><h3>Application package</h3>{groups.application.map((file) => <SourceFileCard file={file} kind="Application package" key={file.path} />)}</section>}
    {groups.dependencies.length > 0 && <section><h3>Imported definitions</h3>{groups.dependencies.map((file) => <SourceFileCard file={file} kind="Dependency" key={file.path} />)}</section>}
    {groups.verification.length > 0 && <details className={styles.dependencyDetails}>
      <summary>Complete dependency closure ({groups.verification.length} additional files)</summary>
      <div>{groups.verification.map((file) => <SourceFileCard file={file} kind="Verification dependency" key={file.path} />)}</div>
    </details>}
    <details className={styles.buildDetails}>
      <summary>Build &amp; Reproduce</summary>
      <div className={styles.buildBody}>
        {groups.build.length > 0 && <div className={styles.buildFiles}>{groups.build.map((file) => <article key={file.path}><h4><SourcePath path={file.path} /></h4><pre>{file.content}</pre></article>)}</div>}
        <ImplementationDetails summary={summary} />
        <h4>Reproduction command</h4>
        <pre className={styles.command}>{reproductionCommand()}</pre>
        {onDownloadBundle && <button type="button" onClick={onDownloadBundle}>Download complete verification bundle</button>}
      </div>
    </details>
  </>;
}

function presentationProfile(view: ContractSourceView): ContractPresentationProfile | undefined {
  return view.presentation?.profile;
}

function functionPresentation(profile: ContractPresentationProfile | undefined, selector: number): FunctionPresentation | undefined {
  return profile?.functions.find((item) => quantity(item.selector) === selector);
}

function configurationField(profile: FunctionPresentation | undefined, position: number): ConfigurationFieldPresentation | undefined {
  return profile?.configurationFields.find((field) => quantity(field.position) === position);
}

function ConfigurationView({ opening, presentation }: { opening?: PublishedConfigurationOpening; presentation?: FunctionPresentation }) {
  if (opening === undefined) return <div className={styles.empty}><h2>Parameters unavailable</h2><p>No positional opening was published for this function’s committed parameters.</p></div>;
  if (opening.status !== "verified") return <Failure>The published parameters do not reproduce this function’s configuration commitment.</Failure>;
  const primaryValues = opening.values.filter((entry) => {
    const metadata = configurationField(presentation, quantity(entry.position));
    return metadata === undefined || !isConfigurationSalt(metadata.name);
  });
  return <div className={styles.parameterView}>
    <div className={styles.parameterList}>{primaryValues.map((entry) => {
      const position = quantity(entry.position);
      const metadata = configurationField(presentation, position);
      return <article className={styles.parameter} key={position}>
        <div><h3>{metadata?.label ?? entry.name ?? `Field ${position}`}</h3>{metadata?.description && <p>{metadata.description}</p>}</div>
        <strong>{metadata ? <PresentedValue format={metadata.displayFormat} raw={entry.value} /> : entry.value}</strong>
        <code>{entry.type ?? metadata?.displayFormat ?? "field"}</code>
      </article>;
    })}</div>
    <details className={styles.parameterAdvanced}><summary>Advanced · raw fields, salt and commitment</summary><dl className={styles.keyValue}>
      <dt>Configuration commitment</dt><dd><Hash value={opening.expectedConfigurationCommitment} /></dd>
      <dt>Commitment scheme</dt><dd>{opening.scheme}</dd>
      {opening.domain && <><dt>Commitment domain</dt><dd><Hash value={opening.domain} /></dd></>}
      {opening.values.map((entry) => {
        const position = quantity(entry.position);
        const metadata = configurationField(presentation, position);
        return <Fragment key={position}><dt>{metadata?.label ?? entry.name ?? `Field ${position}`}</dt><dd><code className={styles.mono}>{entry.value}</code></dd></Fragment>;
      })}
    </dl></details>
  </div>;
}


interface AbiParameter {
  name: string;
  type: unknown;
  visibility?: unknown;
}

function abiParameters(source: ImplementationSourceView): AbiParameter[] {
  const abi = source.noirProvingAbi as { parameters?: Array<{ name?: unknown; type?: unknown; visibility?: unknown }> };
  return (abi.parameters ?? []).flatMap((parameter) => typeof parameter.name === "string"
    ? [{ name: parameter.name, type: parameter.type, visibility: parameter.visibility }]
    : []);
}

function abiType(parameter: AbiParameter | undefined): string {
  if (parameter === undefined) return "Private witness";
  return formatNoirAbiType(parameter.type);
}

function ProofRow({ name, description, parameter }: { name: string; description: string; parameter?: AbiParameter }) {
  return <div className={styles.proofRow}><code>{name}</code><span>{description}</span><small>{abiType(parameter)}</small></div>;
}

function ProofInputsView({ source, presentation }: { source: ImplementationSourceView; presentation?: FunctionPresentation }) {
  const parameters = abiParameters(source);
  const byName = new Map(parameters.map((parameter) => [parameter.name, parameter]));
  const covered = new Set<string>();
  for (const group of presentation?.proofGroups ?? []) for (const item of group.items) covered.add(item.abiParameter);
  const remaining = parameters.filter((parameter) => !covered.has(parameter.name));
  return <div className={styles.proofView}>
    {(presentation?.proofGroups ?? []).map((group) => <section className={styles.proofGroup} key={group.title}><header><h3>{group.title}</h3><p>{group.description}</p></header><div>{group.items.map((item) => {
      const parameter = byName.get(item.abiParameter);
      return <ProofRow name={item.abiParameter} description={item.description} {...(parameter === undefined ? {} : { parameter })} key={item.abiParameter} />;
    })}</div></section>)}
    {remaining.length > 0 && <section className={styles.proofGroup}><header><h3>Additional function inputs</h3></header><div>{remaining.map((parameter) => <ProofRow name={parameter.name} description="Private witness with no published description." parameter={parameter} key={parameter.name} />)}</div></section>}
    <section className={styles.proofOutput}><strong>Rule output</strong><span>Returns the rule statement: the authorization commitment, action commitment, recent PCASH block hash and event entry.</span></section>
  </div>;
}

function overviewTerms(view: ContractSourceView, profile: ContractPresentationProfile) {
  return profile.functions.flatMap((fnProfile) => {
    const opening = view.configurationOpenings.find((item) => quantity(item.selector) === quantity(fnProfile.selector));
    if (opening?.status !== "verified") return [];
    return fnProfile.configurationFields.flatMap((metadata) => {
      if (metadata.overviewOrder === null) return [];
      const value = opening.values.find((entry) => quantity(entry.position) === quantity(metadata.position));
      return value === undefined ? [] : [{ metadata, value }];
    });
  }).sort((a, b) => quantity(a.metadata.overviewOrder ?? 0n) - quantity(b.metadata.overviewOrder ?? 0n));
}

/** A publisher-formatted value; amounts keep their exact value in hover text. */
function PresentedValue({ format, raw }: { format: string; raw: string }) {
  if (format === "ethereum-address") return <AddressDisplay address={formatPresentedValue(format, raw)} short />;
  if (format === "eth-amount") return <EtherAmount value={BigInt(raw)} />;
  if (format === "pcash-amount") return <PcashAmount value={BigInt(raw)} />;
  return <>{formatPresentedValue(format, raw)}</>;
}

function ContractOverview({ view, profile, inspect }: { view: ContractSourceView; profile: ContractPresentationProfile | undefined; inspect(selector: number): void }) {
  const terms = profile === undefined ? [] : overviewTerms(view, profile);
  return <div className={layout.overview}>
    {terms.length > 0 && <section><div className={layout.sectionHeading}><h2>Contract terms</h2><span>Committed parameters</span></div><dl className={layout.terms}>{terms.map(({ metadata, value }, index) => <div key={`${metadata.name}:${index}`}><dt>{metadata.label}</dt><dd><PresentedValue format={metadata.displayFormat} raw={value.value} /></dd></div>)}</dl></section>}
    <section><div className={layout.sectionHeading}><h2>What this contract allows</h2><span>{view.contract.functions.length} installed functions</span></div><div>{view.contract.functions.map((fn) => {
      const selector = quantity(fn.selector);
      const presentation = functionPresentation(profile, selector);
      return <article className={layout.function} key={selector}><strong>{presentation?.name ?? implementationName(implementationFor(view, fn), selector)}</strong><p>{presentation?.summary ?? `Installed function ${selectorHex(selector)}. No published description is available.`}</p><button type="button" onClick={() => inspect(selector)}>Inspect function →</button></article>;
    })}</div></section>
    <details className={layout.details}><summary>Contract identity &amp; network details</summary><dl className={layout.facts}>
      <dt>Address</dt><dd><AddressDisplay address={view.address} /></dd>
      <dt>Function-set commitment</dt><dd><Hash value={contractFunctionSetCommitment(view)} /></dd>
      <dt>Authenticated snapshot</dt><dd>PCASH block {contractBlockNumber(view).toString()} · <Hash value={contractBlockHash(view)} /></dd>
      <dt>Ethereum origin block</dt><dd>{view.contract.origin.l1BlockNumber.toString()}</dd>
      <dt>Ethereum block hash</dt><dd><Hash value={view.contract.origin.l1BlockHash} /></dd>
      <dt>Transaction index</dt><dd>{view.contract.origin.l1TransactionIndex.toString()}</dd>
      <dt>Batch item index</dt><dd>{view.contract.origin.batchItemIndex.toString()}</dd>
    </dl></details>
  </div>;
}

function ContractWorkspace({ reader, view, profile, selector, setSelector, sources, sourcesLoading, downloadBundle }: { reader: ExplorerReader; view: ContractSourceView; profile: ContractPresentationProfile | undefined; selector: number | undefined; setSelector(value: number): void; sources: ReadonlyMap<string, ImplementationSourceView | null>; sourcesLoading: boolean; downloadBundle(): void }) {
  const fn = selectedFunction(view, selector);
  if (fn === undefined) return <p>This contract has no installed functions.</p>;
  const selected = quantity(fn.selector);
  const fnProfile = functionPresentation(profile, selected);
  const summary = implementationFor(view, fn);
  const source = summary ? sources.get(summary.applicationVkHash.toLowerCase()) : undefined;
  const sourceState = implementationSourceState(view.verificationStatus, summary?.applicationVkHash, sources, sourcesLoading);
  const opening = view.configurationOpenings.find((item) => quantity(item.selector) === selected);
  return <div className={layout.workspace}>
    <div className={layout.toolbar}><h2>Implementation</h2><label>Function <select aria-label="Select function" value={selected} onChange={(event) => setSelector(Number(event.target.value))}>{view.contract.functions.map((item) => {
      const value = quantity(item.selector);
      return <option value={value} key={value}>{functionPresentation(profile, value)?.name ?? implementationName(implementationFor(view, item), value)}</option>;
    })}</select></label></div>
    <div className={layout.functionIntro}><h3>{fnProfile?.name ?? implementationName(summary, selected)}()</h3>{fnProfile?.summary && <p>{fnProfile.summary}</p>}<code>{selectorHex(selected)}</code></div>
    <div className={styles.sourceStack}>
      <section><h3>Parameters</h3><ConfigurationView {...(fnProfile === undefined ? {} : { presentation: fnProfile })} {...(opening === undefined ? {} : { opening })} /></section>
      {sourceState === "loading" ? <Loading>Loading implementation source…</Loading> : sourceState !== "available" || source == null || summary === undefined
        ? <p>Implementation source unavailable for this function.</p>
        : <>
          <section><h3>Proof inputs</h3><ProofInputsView source={source} {...(fnProfile === undefined ? {} : { presentation: fnProfile })} /></section>
          <SourceCode reader={reader} source={source} summary={summary} onDownloadBundle={downloadBundle} />
        </>}
    </div>
  </div>;
}

export function ContractView({ address, activity }: { address: string; activity?: ReactNode }) {
  const { reader } = useReadyExplorer();
  const [view, setView] = useState<ContractSourceView | null>();
  const [sources, setSources] = useState<Map<string, ImplementationSourceView | null>>(new Map());
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [selector, setSelector] = useState<number>();
  const [tab, setTab] = useState<ContractTab>("overview");
  const [error, setError] = useState<string>();
  const [sourceError, setSourceError] = useState<string>();
  const [downloadError, setDownloadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setTab("overview"); }, [address]);
  useEffect(() => {
    let cancelled = false;
    setView(undefined);
    setSources(new Map());
    setSourcesLoading(false);
    setError(undefined);
    setSourceError(undefined);
    setDownloadError(undefined);
    void (async () => {
      const { info, status: authorized } = await reader.sourceInfo();
      const identityMatch = pscanIdentityMatches(info, authorized);
      if (identityMatch !== true) throw new Error(identityMatch === false
        ? "The source-verification service is serving a different PCASH network."
        : "The source-verification service did not disclose enough identity to verify its contract data.");
      const next = await reader.contractSource(address);
      if (cancelled) return;
      setView(next);
      if (next === null) return;
      setSelector(next.contract.functions[0] ? quantity(next.contract.functions[0].selector) : undefined);
      if (next.verificationStatus !== "verified") return;
      setSourcesLoading(true);
      const loaded = await Promise.allSettled(next.implementations.map((summary) => reader.implementationSource(summary.applicationVkHash)));
      if (cancelled) return;
      setSources(new Map(next.implementations.map((summary, index) => {
        const result = loaded[index];
        return [summary.applicationVkHash.toLowerCase(), result?.status === "fulfilled" ? result.value : null];
      })));
      if (loaded.some((result) => result.status === "rejected")) setSourceError("Some implementation sources could not be loaded.");
      setSourcesLoading(false);
    })().catch((cause) => {
      if (!cancelled) { setError(friendlyError(cause)); setSourcesLoading(false); }
    });
    return () => { cancelled = true; };
  }, [address, reader, attempt]);
  const profile = view == null ? undefined : presentationProfile(view);
  const verified = view?.verificationStatus === "verified";
  const verificationLabel = error || view === null ? "Source unavailable" : view === undefined ? "Checking source…" : verified ? "Source verified · exact match" : "Source not verified";
  const openings = view?.configurationOpenings ?? [];
  const parametersVerified = view != null && view.contract.functions.length > 0 && view.contract.functions.every((fn) => openings.some((opening) => quantity(opening.selector) === quantity(fn.selector) && opening.status === "verified"));
  const attribution = profile && view?.presentation ? presentationAttribution(profile.publisherLabel, view.presentation.verificationAuthority, view.presentation.verificationMethod) : undefined;
  const runDownload = () => {
    if (view == null) return;
    setDownloadError(undefined);
    void reader.contractBundle(view.address).then((bundle: ContractSourceBundle | null) => {
      if (bundle === null) throw new Error("Contract verification bundle is unavailable.");
      download(`pcash-contract-${view.address}-verification.json`, json(bundle), "application/json");
    }).catch((cause) => setDownloadError(friendlyError(cause)));
  };
  const inspect = (value: number) => { setSelector(value); setTab("source"); };
  return <div className={layout.page}>
    <Metadata title={profile?.contractName ?? "Contract"} description={profile?.contractDescription ?? `PCASH contract at ${address}.`} />
    <div className={layout.breadcrumb}><Link to="/explorer">Explorer</Link> / <Link to="/contracts">Contracts</Link></div>
    <header className={layout.identity}><AccountAvatar address={address} className={layout.avatar} /><div className={layout.name}><h1>{profile?.contractName ?? "Contract"}</h1><AddressDisplay address={address} short /></div><button type="button" className={`${layout.badge} ${verified ? layout.verified : ""}`} onClick={() => setTab("source")}>{verified && <span aria-hidden="true">✓ </span>}{verificationLabel}</button></header>
    {profile?.contractDescription && <p className={layout.purpose}>{profile.contractDescription}</p>}
    {attribution && <p className={layout.byline}>{attribution.publisher}</p>}
    <div className={layout.verification}><span>{verified ? "✓ Source matches implementation" : verificationLabel}</span>{view != null && <span>{parametersVerified ? "✓ Parameters match commitments" : "Parameters not fully verified"}</span>}<button type="button" onClick={() => setTab("source")}>Verification details →</button></div>
    <nav className={layout.tabs} aria-label="Contract sections">{(["overview", "source", "activity"] as const).map((item) => <button type="button" key={item} aria-current={tab === item ? "page" : undefined} onClick={() => setTab(item)}>{item === "source" ? "Source & verification" : item === "overview" ? "Overview" : "Activity"}</button>)}</nav>
    <div className={layout.content}>
      {tab === "activity" ? activity ?? <p>No public account activity is available.</p> : <>
        {error && <div role="status"><Failure>{error}</Failure><button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry source lookup</button></div>}
        {!error && view === undefined && <Loading>Loading contract details…</Loading>}
        {view === null && <p>No contract source record is available for this address.</p>}
        {view != null && (tab === "overview" ? <ContractOverview view={view} profile={profile} inspect={inspect} /> : <>
          <section className={layout.sourceStatus}><h2>{verificationLabel}</h2><p>{verified ? "This source code builds exactly the functions this contract runs. The contract’s name and descriptions are written by its publisher: verification covers the code, not what the descriptions say." : "No exact source correspondence is available for this contract."}</p>{parametersVerified && <p>Published parameters reproduce this contract’s configuration commitments.</p>}<dl className={layout.facts}>{attribution && <><dt>Source registry</dt><dd>{attribution.source}</dd></>}<dt>Authenticated snapshot</dt><dd>PCASH block {contractBlockNumber(view).toString()} · <Hash value={contractBlockHash(view)} /></dd></dl></section>
          {sourceError && <p role="status">{sourceError} <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button></p>}
          {downloadError && <p role="alert">{downloadError}</p>}
          <ContractWorkspace reader={reader} view={view} profile={profile} selector={selector} setSelector={setSelector} sources={sources} sourcesLoading={sourcesLoading} downloadBundle={runDownload} />
        </>)}
      </>}
    </div>
  </div>;
}
