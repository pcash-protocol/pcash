const sources = import.meta.glob<string>([
  "../../../../docs/**/*.md",
  "!../../../../docs/internal/**",
  "!../../../../docs/terms.md",
  "!../../../../docs/privacy.md",
], { query: "?raw", import: "default", eager: true });

/** The Markdown source of a published document, by repository path. */
export function documentSource(file: string): string {
  return sources[`../../../../${file}`]!;
}

export const whitepaperSource = documentSource("docs/whitepaper.md");
export const specSource = documentSource("docs/protocol-spec.md");
