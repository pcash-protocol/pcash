import { Link } from "react-router-dom";
import { Metadata } from "../Metadata.tsx";
import { addressPath, searchPath } from "../explorer/paths.ts";
import { fixtureIds as ids, fixtureWorld as world } from "../explorer/fixtures/world.ts";

const zeroHash = `0x${"00".repeat(32)}`;
const noneHash = `0x${"ff".repeat(32)}`;

interface Group {
  title: string;
  note?: string;
  links: Array<[label: string, path: string]>;
}

const tx = (label: string): string => {
  const id = ids.transactions[label];
  if (id === undefined) throw new Error(`the recording has no transaction labelled ${label}`);
  return id;
};

/** The exact bytes one labelled transaction was built from. Never equal to its id. */
const content = (label: string): string => {
  const entry = world.transactionsById.get(tx(label).toLowerCase());
  if (entry === undefined) throw new Error(`the recording has no transaction body for ${label}`);
  return entry.summary.contentHash;
};

const actor = (name: string): string => {
  const address = ids.addresses.actors[name];
  if (address === undefined) throw new Error(`the recording has no actor ${name}`);
  return address;
};

const blockNumber = (hash: string): bigint => {
  const block = world.blocksByHash.get(hash.toLowerCase());
  if (block === undefined) throw new Error(`the recording has no block ${hash}`);
  return block.number;
};

const pendingContentHash = (index: number): string => {
  const hash = ids.pending[index];
  if (hash === undefined) throw new Error(`the recording has fewer than ${index + 1} pending transactions`);
  return hash;
};

const outcomeLinks: Array<[string, string]> = Object.entries(ids.outcomes)
  .filter(([outcome]) => outcome !== "succeeded")
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([outcome, id]) => [`Failed: ${outcome}`, `/tx/${id}`]);

const groups: Group[] = [
  {
    title: "Connection",
    note: "?fixture= selects a connection or reader state on any explorer page.",
    links: [
      ["Ready", "/explorer"],
      ["Connecting", "/explorer?fixture=connecting"],
      ["Unavailable", "/explorer?fixture=unavailable"],
      ["Identity mismatch", "/explorer?fixture=mismatch"],
      ["Misconfigured", "/explorer?fixture=misconfigured"],
      ["Every read pending", "/blocks?fixture=loading"],
      ["Every read failing", "/blocks?fixture=error"],
    ],
  },
  {
    title: "Chain",
    links: [
      ["Dashboard", "/explorer"],
      ["Block list", "/blocks"],
      ["Latest block", `/block/${ids.blocks.latest}`],
      ["Block with transactions", `/block/${blockNumber(ids.blocks.withTransactions)}`],
      ["Unknown block", "/block/999999"],
      ["Invalid block number", "/block/nope"],
      ["Transaction list", "/transactions"],
    ],
  },
  {
    title: "Transactions",
    links: [
      ["Transfer, open route", `/tx/${tx("transfer-s-r")}`],
      ["Transfer, designated route", `/tx/${tx("transfer-m-r")}`],
      ["Asset creation, zero fee", `/tx/${tx("asset:create")}`],
      ["Two-input transfer to a recordless address", `/tx/${tx("transfer-r-x")}`],
      ["Account creation", `/tx/${tx("account-s")}`],
      ["Account creation without a receive key", `/tx/${tx("account-k")}`],
      ["Account update: receive key replaced", `/tx/${tx("update-r-receive-key")}`],
      ["Contract creation, later verified", `/tx/${tx("paid-offer:contract")}`],
      ["Contract creation, private vault", `/tx/${tx("private-vault:contract")}`],
      ["Marketplace claim", `/tx/${tx("marketplace:claim")}`],
      ...outcomeLinks,
      ["Unknown transaction", `/tx/${zeroHash}`],
      ["Invalid transaction id", "/tx/nope"],
    ],
  },
  {
    title: "Content hash",
    note: "The same route takes a content hash, which names the exact signed bytes rather than one "
      + "inclusion of them. It resolves to every inclusion of those bytes, or, when nothing has "
      + "carried them yet, to this node's own mempool as “Not posted”.",
    links: [
      ["Bytes posted once", `/tx/${content("transfer-s-r")}`],
      ["Bytes posted twice", `/tx/${content("paid-offer:contract")}`],
      ["Signed, not posted", `/tx/${pendingContentHash(0)}`],
      ["Unknown bytes", `/tx/${noneHash}`],
    ],
  },
  {
    title: "L1 batches",
    links: [
      ["All items admitted", `/batch/${ids.batches.allAdmitted}`],
      ["Excluded items and index gaps", `/batch/${ids.batches.withExclusions}`],
      ["Every item excluded", `/batch/${ids.batches.allExcluded}`],
      ["Blob carrier", `/batch/${ids.batches.blob}`],
      ["Event carrier: Marketplace buy", `/batch/${ids.batches.event}`],
      ...Object.entries(ids.batches.excluded).map(([label, hash]): [string, string] => [`Carrier excluded: ${label}`, `/batch/${hash}`]),
      ["Unknown batch", `/batch/${zeroHash}`],
    ],
  },
  {
    title: "Accounts",
    note: "One route for every address, user or contract. It renders the private balance, the account "
      + "record, its public account record, and its activity, plus the verified source and ABI when "
      + "the address holds contract code.",
    links: [
      ...ids.contracts.verified.map((address, index): [string, string] => [`Verified Marketplace contract ${index + 1}`, addressPath(address)]),
      ["Private vault, not verified", addressPath(ids.contracts.unverified)],
      ["User with an account, receive key replaced", addressPath(actor("R"))],
      ["User with an account, seller", addressPath(actor("S"))],
      ["Account without a receive key", addressPath(ids.addresses.keyless)],
      ["Received a system payout without an account (relayer)", addressPath(ids.addresses.relayer)],
      ["Unknown address", addressPath(ids.addresses.unknown)],
    ],
  },
  { title: "Contracts", links: [["Directory", "/contracts"]] },
  { title: "Get PCASH", links: [["Mine and relay", "/get"]] },
  {
    title: "Search",
    note: "The query is a query string. A query that names one thing redirects to it; the results page "
      + "appears only when the same bytes name several.",
    links: [
      ["No query", "/search"],
      ["Block number", searchPath(blockNumber(ids.blocks.withTransactions).toString())],
      ["Address", searchPath(actor("R"))],
      ["Transaction id", searchPath(tx("transfer-s-r"))],
      ["Content hash with two inclusions", searchPath(content("paid-offer:contract"))],
      ["Matches nothing", searchPath(noneHash)],
    ],
  },
];

/** Every explorer route in every state the recording holds, as links. Fixture mode only. */
export default function StatesRoute() {
  return <section className="panel">
    <Metadata title="Fixture states" description="Every explorer route in every state the recorded fixture holds." />
    <p className="eyebrow">Fixture mode</p>
    <h1>Every route, every state</h1>
    <p>Recorded from a seeded local chain, no node. Each link is one route in one state; the header shows the node as “Fixture data”.</p>
    {groups.map((group) => <div key={group.title}>
      <h2>{group.title}</h2>
      {group.note && <p className="muted">{group.note}</p>}
      <ul>{group.links.map(([label, path]) => <li key={path}><Link to={path}>{label}</Link> <code>{path}</code></li>)}</ul>
    </div>)}
  </section>;
}
