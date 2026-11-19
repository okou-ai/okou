import { cn } from "@okouai/ui";
import { CircleCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

export function ConnectedIndicator({
  testId,
  connectedDetail,
  wrap = false,
  variant = "badge",
}: {
  readonly wrap?: boolean;
  readonly variant?: "badge" | "text";
  readonly testId?: string;
  readonly connectedDetail?: string | null;
}) {
  const { t } = useTranslation();

  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs",
        variant === "text"
          ? "text-muted-foreground"
          : "rounded-lg border border-border bg-background px-1.5 py-1 font-medium text-secondary-foreground",
        wrap ? "flex-1" : "max-w-52 shrink-0",
      )}
    >
      {variant === "badge" ? (
        <CircleCheck className="h-3 w-3 shrink-0 text-green-600" />
      ) : null}
      <span className={cn("min-w-0", wrap ? "break-all" : "truncate")}>
        {connectedDetail
          ? t(
              ($) => {
                return $.works.connectedWithDetail;
              },
              { detail: connectedDetail },
            )
          : t(($) => {
              return $.works.connected;
            })}
      </span>
    </span>
  );
}
