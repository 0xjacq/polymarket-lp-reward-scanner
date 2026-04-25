import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Tabs({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid gap-3", className)} {...props} />;
}

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "inline-flex rounded-md border border-slate-800 bg-slate-950/70 p-1",
        className
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  active,
  ...props
}: HTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
}) {
  return (
    <button
      className={cn(
        "rounded px-3 py-1.5 text-sm font-semibold text-slate-400 transition hover:text-slate-100",
        active && "bg-slate-800 text-slate-50 shadow-sm",
        className
      )}
      type="button"
      {...props}
    />
  );
}
