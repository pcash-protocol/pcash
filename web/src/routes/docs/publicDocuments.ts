/**
 * The repository documents published on the website. Everything under `docs/`
 * is listed here except `docs/internal/`, which is never published, and the
 * terms and privacy policy, which have their own pages. Routes, pages, raw
 * Markdown files, the AI texts, and the Developers page all follow this list.
 */
export interface PublicDocument {
  /** Route id. */
  id: string;
  /** Repository path. The page is at this path without ".md"; the raw Markdown is at the path itself. */
  file: string;
  title: string;
  description: string;
  /** The question this document answers, which places it in the list and on the Learn or Developers page. */
  group: DocumentGroupId;
  /** The label over the document's card. */
  eyebrow: string;
  /** Deepest heading level listed in the page's contents. */
  contentsDepth: number;
  footerLabel?: string;
}

/** The questions documents are grouped by, in list order. Learn presents the first group; Developers presents the rest. */
export const documentGroups = [
  {
    id: "learn",
    question: "What is PCASH, and why is it built this way?",
    summary: "What PCASH is, why it exists, what you trust when you use it, and the reasons for its design.",
  },
  {
    id: "build",
    question: "How do I build on it?",
    summary: "What you can build with PCASH account rules and contracts, from private assets to payouts settled by Ethereum events.",
  },
  {
    id: "run",
    question: "How do I run it?",
    summary: "Operate a node and the wallet service.",
  },
  {
    id: "reference",
    question: "What exactly are the rules?",
    summary: "The normative protocol specification.",
  },
] as const;

export type DocumentGroupId = (typeof documentGroups)[number]["id"];

export const publicDocuments: readonly PublicDocument[] = [
  {
    id: "whitepaper",
    file: "docs/whitepaper.md",
    title: "White paper",
    description: "Why PCASH exists and how it works: private money Ethereum can program, with no public form, no operator, and capped native issuance.",
    group: "learn",
    eyebrow: "Overview",
    contentsDepth: 3,
    footerLabel: "White paper",
  },
  {
    id: "security",
    file: "docs/security.md",
    title: "Security",
    description: "How PCASH protects its money and the people who use it, and the latest security review.",
    group: "learn",
    eyebrow: "Security",
    contentsDepth: 2,
    footerLabel: "Security",
  },
  {
    id: "guide-building",
    file: "docs/guides/building-on-pcash.md",
    title: "Building on PCASH",
    description: "A builder-oriented guide to private applications, authorization, assets, and Ethereum-grounded conditions.",
    group: "build",
    eyebrow: "Guide",
    contentsDepth: 2,
  },
  {
    id: "guide-node",
    file: "docs/guides/running-a-node.md",
    title: "Running a node",
    description: "Run and configure a node and the wallet service.",
    group: "run",
    eyebrow: "Guide",
    contentsDepth: 3,
  },
  {
    id: "spec",
    file: "docs/protocol-spec.md",
    title: "Protocol specification",
    description: "The normative PCASH protocol: derivation, state, transactions, proofs, accounts, issuance, and compensation.",
    group: "reference",
    eyebrow: "Normative",
    contentsDepth: 2,
  },
];

export function documentPath(file: string): string {
  return `/${file.replace(/\.md$/, "")}`;
}

/** The public source repository. Links from published documents to unpublished repository files lead here. */
export const SOURCE_REPOSITORY_URL = "https://github.com/pcash-protocol/pcash";
