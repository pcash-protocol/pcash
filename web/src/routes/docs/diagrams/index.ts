import type { ComponentType } from "react";
import { MoneyController, MoneySupply } from "./moneyIssuanceDiagrams.tsx";
import { NoPublicPcashDiagram, PaymentJourneyDiagram, ProofStackDiagram } from "./payment.tsx";
import { ContractAccountDiagram, EthTradeDiagram, NormalizedLogDiagram } from "./systemApplicationDiagrams.tsx";
import { AccountAuthorityDiagram } from "./systemAuthorizationDiagrams.tsx";
import { DerivationPipelineDiagram } from "./systemDerivationDiagrams.tsx";
import { HeaderStateMapDiagram } from "./systemStateDiagrams.tsx";

/**
 * The diagrams a Markdown document can place with
 * `<figure data-diagram="slug"><figcaption><p>…</p></figcaption></figure>`. A slug is
 * the component name in kebab case without a trailing "Diagram".
 */
export const diagrams: Readonly<Record<string, ComponentType>> = {
  "money-supply": MoneySupply,
  "money-controller": MoneyController,
  "payment-journey": PaymentJourneyDiagram,
  "no-public-pcash": NoPublicPcashDiagram,
  "proof-stack": ProofStackDiagram,
  "contract-account": ContractAccountDiagram,
  "eth-trade": EthTradeDiagram,
  "normalized-log": NormalizedLogDiagram,
  "account-authority": AccountAuthorityDiagram,
  "derivation-pipeline": DerivationPipelineDiagram,
  "header-state-map": HeaderStateMapDiagram,
};
