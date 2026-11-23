import { CopyButton } from "../../components/CopyButton.tsx";

/** Copies a document's Markdown source. */
export function CopyMarkdown({ source, className }: { source: string; className?: string | undefined }) {
  return <CopyButton className={className} value={source} label="Copy Markdown" showLabel />;
}

/** The raw Markdown sits beside each document page, at the page path plus ".md". */
export function markdownPath(pagePath: string): string {
  return `${pagePath}.md`;
}
