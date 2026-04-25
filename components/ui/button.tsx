import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Button({
  className,
  variant = "default",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "secondary" | "ghost" | "outline";
}) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:pointer-events-none disabled:opacity-50",
        variant === "default" &&
          "border-sky-500/60 bg-sky-500/15 text-sky-100 hover:bg-sky-500/25",
        variant === "secondary" &&
          "border-emerald-500/50 bg-emerald-500/12 text-emerald-100 hover:bg-emerald-500/22",
        variant === "ghost" &&
          "border-transparent bg-transparent text-slate-300 hover:bg-white/5 hover:text-white",
        variant === "outline" &&
          "border-slate-700 bg-slate-950/40 text-slate-200 hover:bg-slate-900",
        className
      )}
      {...props}
    />
  );
}
