import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Badge({
  className,
  tone = "neutral",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: "neutral" | "green" | "blue" | "red" | "amber";
}) {
  return (
    <span
      className={cn(
        "ui-badge",
        `ui-badge-${tone}`,
        className
      )}
      {...props}
    />
  );
}
