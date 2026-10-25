import { CopyButton } from "../../components/CopyButton.tsx";
import { bundlePath, type DocumentBundle } from "./bundles.ts";

/** Copies a document's Markdown source, for pasting into an AI chat. */
export function CopyForLlm({ source, className }: { source: string; className?: string | undefined }) {
  return <CopyButton className={className} value={source} label="Copy for LLM" showLabel />;
}

async function served(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.text();
}

/** Copies a bundle's text, fetched from where the site serves it, so pages that offer a bundle do not carry its documents. */
export function CopyBundleForLlm({ bundle, className }: { bundle: DocumentBundle; className?: string | undefined }) {
  return <CopyButton className={className} load={() => served(bundlePath(bundle))} label="Copy for LLM" showLabel />;
}

/** The raw Markdown sits beside each document page, at the page path plus ".md". */
export function markdownPath(pagePath: string): string {
  return `${pagePath}.md`;
}
