import { createContext, useContext, type ReactNode } from "react";

/** True inside a layout that already has the page's main heading, such as Try PCASH. */
export const SubpageHeadings = createContext(false);

export interface RouteHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
  aside?: ReactNode;
}

export function RouteHeader({ eyebrow, title, description, aside }: RouteHeaderProps) {
  const Heading = useContext(SubpageHeadings) ? "h2" : "h1";
  return <div className="route-heading"><div><p className="eyebrow">{eyebrow}</p><Heading>{title}</Heading><p>{description}</p></div>{aside}</div>;
}
