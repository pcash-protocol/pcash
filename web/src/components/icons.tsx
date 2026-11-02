import type { ReactNode } from "react";

// Paths copied from Lucide (ISC license, https://lucide.dev).
const iconProps = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

function Icon({ size = 14, children }: { size?: number | undefined; children: ReactNode }) {
  return <svg {...iconProps} width={size} height={size}>{children}</svg>;
}

type IconProps = { size?: number };

export function CopyIcon({ size = 16 }: IconProps) {
  return <Icon size={size}><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></Icon>;
}

export function CheckIcon({ size = 16 }: IconProps) {
  return <Icon size={size}><path d="M20 6 9 17l-5-5" /></Icon>;
}

/** Marks a link that opens another site in a new tab; sized to the surrounding text. */
export function ExternalLinkIcon() {
  return <svg {...iconProps} width="1em" height="1em" style={{ verticalAlign: "-0.125em", marginLeft: "0.25em" }}>
    <path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </svg>;
}

export function ArrowUpRightIcon({ size }: IconProps) {
  return <Icon size={size}><path d="M7 7h10v10" /><path d="M7 17 17 7" /></Icon>;
}

export function ArrowDownLeftIcon({ size }: IconProps) {
  return <Icon size={size}><path d="M17 7 7 17" /><path d="M17 17H7V7" /></Icon>;
}

export function PickaxeIcon({ size }: IconProps) {
  return <Icon size={size}>
    <path d="m14 13-8.381 8.38a1 1 0 0 1-3.001-3L11 9.999" />
    <path d="M15.973 4.027A13 13 0 0 0 5.902 2.373c-1.398.342-1.092 2.158.277 2.601a19.9 19.9 0 0 1 5.822 3.024" />
    <path d="M16.001 11.999a19.9 19.9 0 0 1 3.024 5.824c.444 1.369 2.26 1.676 2.603.278A13 13 0 0 0 20 8.069" />
    <path d="M18.352 3.352a1.205 1.205 0 0 0-1.704 0l-5.296 5.296a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l5.296-5.296a1.205 1.205 0 0 0 0-1.704z" />
  </Icon>;
}

export function UserCheckIcon({ size }: IconProps) {
  return <Icon size={size}><path d="m16 11 2 2 4-4" /><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /></Icon>;
}

export function TagIcon({ size }: IconProps) {
  return <Icon size={size}>
    <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
    <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
  </Icon>;
}

export function LockIcon({ size }: IconProps) {
  return <Icon size={size}><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></Icon>;
}

export function ShoppingCartIcon({ size }: IconProps) {
  return <Icon size={size}><circle cx="8" cy="21" r="1" /><circle cx="19" cy="21" r="1" /><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" /></Icon>;
}

export function HandCoinsIcon({ size }: IconProps) {
  return <Icon size={size}>
    <path d="M11 15h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 17" />
    <path d="m7 21 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9" />
    <path d="m2 16 6 6" />
    <circle cx="16" cy="9" r="2.9" />
    <circle cx="6" cy="5" r="3" />
  </Icon>;
}

export function Undo2Icon({ size }: IconProps) {
  return <Icon size={size}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" /></Icon>;
}

export function CirclePlusIcon({ size }: IconProps) {
  return <Icon size={size}><circle cx="12" cy="12" r="10" /><path d="M8 12h8" /><path d="M12 8v8" /></Icon>;
}

export function FlameIcon({ size }: IconProps) {
  return <Icon size={size}><path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4" /></Icon>;
}

export function GiftIcon({ size }: IconProps) {
  return <Icon size={size}>
    <path d="M12 7v14" />
    <path d="M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8" />
    <path d="M7.5 7a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5 1 1 0 0 1 0 5" />
    <rect x="3" y="7" width="18" height="4" rx="1" />
  </Icon>;
}
