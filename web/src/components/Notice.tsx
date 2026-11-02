import type { ReactNode } from "react";

export interface NoticeProps {
  children: ReactNode;
  tone?: "warning" | "error" | "success";
}

export function Notice({ children, tone = "warning" }: NoticeProps) {
  const className = tone === "warning" ? "notice" : `notice ${tone}`;
  return <div className={className} role={tone === "error" ? "alert" : "status"}>{children}</div>;
}
