import { blo } from "blo";

export function AccountAvatar({ address, avatar, className }: {
  address: string | undefined;
  avatar?: string | undefined;
  className?: string | undefined;
}) {
  const src = avatar ?? (address === undefined ? undefined : blo(address.toLowerCase() as `0x${string}`));
  if (src === undefined) return <span className={className} aria-hidden="true" />;
  return <img className={className} src={src} alt="" />;
}
