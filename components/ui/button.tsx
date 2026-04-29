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
        "ui-button",
        variant === "default" && "ui-button-default",
        variant === "secondary" && "ui-button-secondary",
        variant === "ghost" && "ui-button-ghost",
        variant === "outline" && "ui-button-outline",
        className
      )}
      {...props}
    />
  );
}
