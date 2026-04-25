import type { SelectHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-10 rounded-md border border-slate-800 bg-slate-950/70 px-3 text-sm text-slate-100 outline-none transition focus:border-sky-500/70 focus:ring-2 focus:ring-sky-500/15",
        className
      )}
      {...props}
    />
  );
}
