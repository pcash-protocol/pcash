import { Link } from "react-router-dom";
import { routeById } from "../routeManifest.ts";
import styles from "./IssuanceOverview.module.css";

/** The block issuance formulas of protocol-spec §14, in real-number form; constants stay symbolic. */
export function IssuanceFormulas() {
  return <section className={`panel ${styles.chartCard}`} aria-labelledby="formulas-title">
    <p className="eyebrow">Formulas</p>
    <h2 id="formulas-title">How each block’s issuance is set</h2>
    <p className={styles.lede}>Before a block’s transactions run, the protocol quotes it from the parent block’s state. After they run, its <var>n</var> successful qualifying transactions each receive <var>rewardEach</var>.</p>
    <dl className={styles.formulas}>
      <dt><var>baseline</var></dt><dd>= 2 × <var>S</var> × <var>τ</var> × √(1 − <var>I</var> / <var>S</var>) / <var>T</var></dd>
      <dt><var>allowance</var></dt><dd>= <var>k</var> × <var>baseline</var></dd>
      <dt><var>offerLag</var></dt><dd>= min(<var>L</var>, <var>lag</var> + <var>elapsed</var>)</dd>
      <dt><var>multiplier</var></dt><dd>= 2<sup><var>offerLag</var> / <var>H</var></sup>, or 0 when <var>offerLag</var> &lt; −128 × <var>H</var></dd>
      <dt><var>offer</var></dt><dd>= <var>baseline</var> × <var>multiplier</var></dd>
      <dt><var>rewardEach</var></dt><dd>= min(⌊<var>offer</var>⌋, ⌊<var>allowance</var> / <var>n</var>⌋, ⌊(<var>S</var> − <var>I</var>) / <var>n</var>⌋)</dd>
      <dt><var>nextIssued</var></dt><dd>= <var>I</var> + <var>n</var> × <var>rewardEach</var></dd>
      <dt><var>nextLag</var></dt><dd>= <var>offerLag</var> − (<var>p</var>(<var>nextIssued</var>) − <var>p</var>(<var>I</var>)), where <var>p</var>(<var>I</var>) = <var>T</var> × (1 − √(1 − <var>I</var> / <var>S</var>))</dd>
    </dl>
    <p className={styles.caption}>Amounts are in atomic units (10<sup>−18</sup> PCASH) and times in seconds. <var>S</var> is the supply cap, <var>I</var> the amount issued before the block, <var>T</var> the supply curve’s reference duration, <var>τ</var> the reference interval between qualifying transactions, <var>k</var> the maximum issuance speed, <var>H</var> the controller’s half-life and <var>L</var> the most lag it remembers, which caps the multiplier at 2<sup><var>L</var> / <var>H</var></sup>. <var>lag</var> is the parent block’s lag, positive when issuance is behind the curve <var>p</var> and negative when ahead; <var>elapsed</var> is the time since the parent block.</p>
    <p className={styles.caption}>With <var>n</var> = 0 nothing is issued and <var>nextLag</var> = <var>offerLag</var>. Once <var>I</var> = <var>S</var>, issuance has ended: <var>baseline</var>, <var>allowance</var>, <var>offer</var> and <var>rewardEach</var> are zero, <var>I</var> stays at <var>S</var>, and <var>nextLag</var> = <var>lag</var>, with no elapsed time added. The mining reward now is <var>rewardEach</var> with <var>n</var> = 1.</p>
    <p className={styles.caption}>The multiplier follows Bitcoin Cash’s ASERT difficulty adjustment. Consensus computes it in exact integer arithmetic: <var>offerLag</var> / <var>H</var> is truncated toward zero to a multiple of 1/65536, whole half-lives are exact powers of two, and the fractional part uses the cubic approximation from Bitcoin Cash’s aserti3-2d. The <Link to={`${routeById("spec").path}#14-native-issuance-and-block-settlement`}>protocol specification, §14</Link>, gives the integer form and the constants’ values.</p>
  </section>;
}
