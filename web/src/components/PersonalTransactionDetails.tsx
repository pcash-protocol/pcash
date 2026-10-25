import { createContext, useContext, type ReactNode } from "react";

export interface PersonalTransactionPayment {
  contentHash: string;
  kind: "mine" | "payment";
  minedAmount?: bigint;
  recipientAddress: string;
  amount: bigint;
  openFeeAmount: bigint;
}

export interface PersonalTransactionDetailsValue {
  network?: { chainId: bigint; genesisHash: string };
  payments: PersonalTransactionPayment[];
}

const EMPTY_DETAILS: PersonalTransactionDetailsValue = { payments: [] };
const PersonalTransactionDetailsContext = createContext<PersonalTransactionDetailsValue>(EMPTY_DETAILS);

export function PersonalTransactionDetailsProvider({ value, children }: { value: PersonalTransactionDetailsValue; children: ReactNode }) {
  return <PersonalTransactionDetailsContext.Provider value={value}>{children}</PersonalTransactionDetailsContext.Provider>;
}

export function usePersonalTransactionDetails(): PersonalTransactionDetailsValue {
  return useContext(PersonalTransactionDetailsContext);
}
