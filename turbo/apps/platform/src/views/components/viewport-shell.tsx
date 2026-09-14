import type { ComponentProps } from "react";
import { cn } from "@okouai/ui";

interface ViewportShellProps extends ComponentProps<"div"> {
  /** Content-owned insets let workspace scrollports reach the viewport edge. */
  readonly bottomSafeArea?: "shell" | "content";
}

export function ViewportShell({
  className,
  bottomSafeArea = "shell",
  ...props
}: ViewportShellProps) {
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
