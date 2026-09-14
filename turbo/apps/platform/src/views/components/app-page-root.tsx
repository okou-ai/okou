import type { ComponentProps } from "react";
import { cn } from "@okouai/ui";

interface AppPageRootProps extends ComponentProps<"div"> {
  /** Content-owned insets let workspace scrollports reach the viewport edge. */
  readonly bottomSafeArea?: "root" | "content";
}

/**
 * Outermost container for a full-page app layout mounted under #root.
 * Use once in a shared layout or at the root of an independent page. Pages
 * inside SidebarLayout or OnboardingShell only supply content, without another
 * AppPageRoot. Inner content owns scrolling; the page root clips overflow.
 */
export function AppPageRoot({
  className,
  bottomSafeArea = "root",
  ...props
}: AppPageRootProps) {
  return (
    <div
      data-slot="app-page-root"
      className={cn(
        "box-border h-full max-h-full min-h-full overflow-hidden",
        bottomSafeArea === "root" ? "pb-(--sab)" : "pb-0",
        className,
      )}
      {...props}
    />
  );
}
