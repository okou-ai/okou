import { cn } from "@okouai/ui";
import { useGet } from "ccstate-react";
import type { CSSProperties, ReactNode } from "react";

import { theme$ } from "../../signals/theme.ts";

export function MarkdownFrame({
  children,
  className,
  style,
}: {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  const theme = useGet(theme$);

  return (
    <div
      data-color-mode={theme}
      className={cn(
        "wmde-markdown",
        "min-w-0 max-w-full bg-transparent! text-foreground!",
        // The vendor's unlayered typography outranks normal utilities. Keep
        // caller-supplied runtime typography authoritative when it is present.
        style?.fontSize === undefined && "text-[0.875rem]!",
        style?.lineHeight === undefined && "leading-normal!",
        style?.fontFamily === undefined && "font-family-sans!",
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}
