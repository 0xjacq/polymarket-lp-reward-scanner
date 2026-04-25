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
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        tone === "neutral" && "border-slate-700 bg-slate-900/70 text-slate-300",
        tone === "green" && "border-emerald-500/45 bg-emerald-500/12 text-emerald-200",
        tone === "blue" && "border-sky-500/45 bg-sky-500/12 text-sky-200",
        tone === "red" && "border-red-500/45 bg-red-500/12 text-red-200",
        tone === "amber" && "border-amber-500/45 bg-amber-500/12 text-amber-200",
        className
      )}
      {...props}
    />
  );
}
