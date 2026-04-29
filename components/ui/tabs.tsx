import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Tabs({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-tabs", className)} {...props} />;
}

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-tabs-list", className)} {...props} />;
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
        "ui-tabs-trigger",
        active && "ui-tabs-trigger-active",
        className
      )}
      type="button"
      {...props}
    />
  );
}
