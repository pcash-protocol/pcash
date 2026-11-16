import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export interface GetActivity {
  working: boolean;
  unsafeToLeave: boolean;
}

const idle: GetActivity = { working: false, unsafeToLeave: false };
const Context = createContext<GetActivity & { setActivity(activity: GetActivity): void }>({ ...idle, setActivity: () => undefined });

/** Only activity indicators outlive the page; proofs remain in its running operation. */
export function GetActivityProvider({ children }: { children: ReactNode }) {
  const [activity, setActivity] = useState(idle);
  const value = useMemo(() => ({ ...activity, setActivity }), [activity]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useGetActivity() {
  return useContext(Context);
}

export function confirmDiscardGetWork(message = "Leaving will cancel preparation and discard any unsubmitted proofs. An Ethereum transaction you have already confirmed may still be included. Continue?"): boolean {
  return window.confirm(message);
}
