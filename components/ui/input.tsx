import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 rounded-md border border-slate-800 bg-slate-950/70 px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-sky-500/70 focus:ring-2 focus:ring-sky-500/15",
        className
      )}
      {...props}
    />
  );
}
