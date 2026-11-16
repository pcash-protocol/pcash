import { blo } from "blo";
import { useState } from "react";

// The site is cross-origin isolated, so a cross-origin avatar loads only as a
// CORS request. A host that refuses CORS falls back to the address icon.
export function AccountAvatar({ address, avatar, className }: {
  address: string | undefined;
  avatar?: string | undefined;
  className?: string | undefined;
}) {
  const [failed, setFailed] = useState<string>();
  const remote = avatar !== undefined && avatar !== failed ? avatar : undefined;
  const src = remote ?? (address === undefined ? undefined : blo(address.toLowerCase() as `0x${string}`));
  if (src === undefined) return <span className={className} aria-hidden="true" />;
  if (remote === undefined) return <img className={className} src={src} alt="" />;
  return <img className={className} src={src} alt="" crossOrigin="anonymous" onError={() => setFailed(remote)} />;
}
