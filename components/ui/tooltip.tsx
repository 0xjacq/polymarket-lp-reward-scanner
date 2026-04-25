import type { ReactNode } from "react";

export function Tooltip({
  children,
  content
}: {
  children: ReactNode;
  content: string;
}) {
  return <span title={content}>{children}</span>;
}
