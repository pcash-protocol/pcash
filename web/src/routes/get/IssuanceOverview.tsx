import { Link } from "react-router-dom";
import type { IssuanceQuoteResult } from "@pcash/sdk/clients";
import { routeById } from "../routeManifest.ts";
import { compactNumber } from "./chartParts.tsx";
import { IssuanceRateChart } from "./IssuanceRateChart.tsx";
import { SupplyChart } from "./SupplyChart.tsx";
import { measuredPace, pcashNumber, rewardPosition, targetPerDay, type IssuanceHistory, type Pace } from "./issuanceOverviewModel.ts";
import styles from "./IssuanceOverview.module.css";

const DAY = 86_400;

function windowLabel(pace: Pace, asked: number): string {
  if (pace.seconds >= asked) return asked === DAY ? "Last 24 hours" : "Last 7 days";
  const hours = pace.seconds / 3_600;
  return `Since launch (${hours < 48 ? `${Math.max(1, Math.round(hours))} hours` : `${Math.round(hours / 24)} days`})`;
}

function PaceTile({ pace, asked }: { pace: Pace | undefined; asked: number }) {
  if (pace === undefined) return <div><p className="eyebrow">{asked === DAY ? "Last 24 hours" : "Last 7 days"}</p><strong>Unavailable</strong></div>;
  return <div>
    <p className="eyebrow">{windowLabel(pace, asked)}</p>
    <strong>{compactNumber(pace.issuedPerDay)} PCASH a day</strong>
    <p>{new Intl.NumberFormat("en", { maximumSignificantDigits: 2 }).format(pace.ratio * 100)}% of target · {compactNumber(pace.actionsPerDay)} qualifying transactions a day</p>
  </div>;
}

/** Issuance per day against the target per day: the comparison that decides which way the reward moves. */
function PacePanel({ quote, history }: { quote: IssuanceQuoteResult; history: IssuanceHistory | undefined }) {
  const target = pcashNumber(targetPerDay(quote.baseline));
  const day = history === undefined ? undefined : measuredPace(history, "day", quote.baseline);
  const week = history === undefined ? undefined : measuredPace(history, "week", quote.baseline);
  const showWeek = week !== undefined && day !== undefined && week.seconds > day.seconds;
  return <section className={`panel ${styles.pace}`} aria-labelledby="pace-title">
    <p className="eyebrow">Pace</p>
    <h2 id="pace-title">Issuance against the target</h2>
    <p className={styles.lede}>When new PCASH is issued more slowly than the target, the reward per mine rises; when faster, it falls.</p>
    <div className={styles.paceTiles}>
      <div>
        <p className="eyebrow">Target now</p>
        <strong>{compactNumber(target)} PCASH a day</strong>
        <p>Falls as supply is issued: half the starting rate at 75% issued, zero at the cap.</p>
      </div>
      <PaceTile pace={day} asked={DAY} />
      {showWeek && <PaceTile pace={week} asked={7 * DAY} />}
    </div>
  </section>;
}

export function IssuanceOverview({ quote, history, error, onRetry }: {
  quote: IssuanceQuoteResult | null | undefined;
  history?: IssuanceHistory | undefined;
  error?: string | undefined;
  onRetry?: (() => void) | undefined;
}) {
  if (quote === undefined) return <section className={`panel ${styles.unavailable}`}><h2>Issuance</h2><p>{error ?? "Loading issuance information…"}</p>{error && <button onClick={onRetry}>Try again</button>}</section>;
  if (quote === null) return <section className="panel"><h2>Issuance</h2><p>Issuance information will be available after the first PCASH block.</p></section>;
  const position = rewardPosition(quote);
  return <div className={styles.overview}>
    {error !== undefined && <p role="status">{error} <button onClick={onRetry}>Try again</button></p>}
    {position !== undefined && <PacePanel quote={quote} history={history} />}
    <IssuanceRateChart quote={quote} history={history} />
    <SupplyChart quote={quote} history={history} />
    <p className={styles.learn}><Link to={`${routeById("whitepaper").path}#how-issuance-keeps-pace`}>How PCASH issuance works →</Link></p>
  </div>;
}
