import type { ComponentProps } from "react";
import { cn } from "@okouai/ui";

interface ShellProps extends ComponentProps<"div"> {
  /** Content-owned insets let workspace scrollports reach the viewport edge. */
  readonly bottomSafeArea?: "shell" | "content";
}

export function Shell({
  className,
  bottomSafeArea = "shell",
  ...props
}: ShellProps) {
  return (
    <div
      data-slot="viewport-shell"
      className={cn(
        "box-border h-full max-h-full min-h-full overflow-hidden",
        bottomSafeArea === "shell" ? "pb-(--sab)" : "pb-0",
        className,
      )}
      {...props}
    />
  );
}
