import type { ReactNode } from "react";

export interface RouteHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
  aside?: ReactNode;
}

export function RouteHeader({ eyebrow, title, description, aside }: RouteHeaderProps) {
  return <div className="route-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{aside}</div>;
}
