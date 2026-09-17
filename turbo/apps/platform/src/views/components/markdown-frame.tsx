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
        "min-w-0 max-w-full !bg-transparent !text-foreground text-sm",
        className,
      )}
      style={{
        backgroundColor: "transparent",
        fontSize: "0.875rem",
        lineHeight: "1.5",
        fontFamily: "var(--font-family-sans)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
