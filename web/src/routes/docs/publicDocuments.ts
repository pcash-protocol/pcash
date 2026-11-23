/**
 * The repository documents published on the website. Everything under `docs/`
 * is listed here except `docs/internal/`, which is never published, and the
 * terms and privacy policy, which have their own pages. Routes, pages, raw
 * Markdown files, llms.txt, and the Docs page all follow this list.
 */
export interface PublicDocument {
  /** Route id. */
  id: string;
  /** Repository path. The page is at this path without ".md"; the raw Markdown is at the path itself. */
  file: string;
  title: string;
  description: string;
  /** The question this document answers, which places it in the list and on the Docs page. */
  group: DocumentGroupId;
  /** The label over the document's card. */
  eyebrow: string;
  /** Deepest heading level listed in the page's contents. */
  contentsDepth: number;
}

/** The questions documents are grouped by, in list order, as the Docs page and llms.txt present them. */
export const documentGroups = [
  {
    id: "overview",
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
    description: "Why PCASH exists and how it works: programmable private money secured by Ethereum, with no public form, no operator, and capped native issuance.",
    group: "overview",
    eyebrow: "Overview",
    contentsDepth: 3,
  },
  {
    id: "security",
    file: "docs/security.md",
    title: "Security",
    description: "How PCASH protects its money and the people who use it, and the latest security review.",
    group: "overview",
    eyebrow: "Security",
    contentsDepth: 2,
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
    id: "guide-merchant",
    file: "docs/guides/merchant-payments.md",
    title: "Merchant payments",
    description: "Invoices, confirmation, recovery and receipts for private payments, step by step with code from a tested scenario.",
    group: "build",
    eyebrow: "Guide",
    contentsDepth: 2,
  },
  {
    id: "guide-private-dollars",
    file: "docs/guides/private-dollars.md",
    title: "Private dollars",
    description: "How to issue a private dollar on PCASH: the vault and deny list an issuer deploys, how holders deposit and mint, redemptions and freezes, and what is public.",
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

/** Where published documents live: each one at its repository path under docs/. */
export const DOCS_PATH = "/docs";

export function documentPath(file: string): string {
  return `/${file.replace(/\.md$/, "")}`;
}

/** The public source repository. Links from published documents to unpublished repository files lead here. */
export const SOURCE_REPOSITORY_URL = "https://github.com/pcash-protocol/pcash";

/** PCASH Wallet for Mac (Apple Silicon, testnet) on the public repository's latest release, and its setup steps. */
export const MAC_WALLET_DOWNLOAD_URL = `${SOURCE_REPOSITORY_URL}/releases/latest/download/pcash-wallet-darwin-arm64.tar.gz`;
export const MAC_WALLET_SETUP_PATH = `${documentPath("docs/guides/running-a-node.md")}#run-the-apple-silicon-testnet-wallet-over-tor`;
