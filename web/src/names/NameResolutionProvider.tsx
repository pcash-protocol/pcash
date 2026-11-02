import { useWebsiteSettings } from "../lib/WebsiteSettings.tsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NameResolutionContext } from "./useEthereumName.ts";
import { NameResolutionSession, type NameResolverFactory } from "./NameResolutionSession.ts";

export function NameResolutionProvider({ createResolver, children }: { createResolver: NameResolverFactory | undefined; children: ReactNode }) {
  const { ensEnabled } = useWebsiteSettings();
  const [session] = useState(() => new NameResolutionSession(createResolver, () => localStorage));
  const lifetime = useRef(0);
  useEffect(() => {
    const generation = ++lifetime.current;
    session.queryClient.mount();
    return () => {
      session.queryClient.unmount();
      queueMicrotask(() => { if (lifetime.current === generation) session.stop(); });
    };
  }, [session]);
  useEffect(() => { session.setEnabled(ensEnabled); }, [session, ensEnabled]);
  return <NameResolutionContext.Provider value={session}>{children}</NameResolutionContext.Provider>;
}
