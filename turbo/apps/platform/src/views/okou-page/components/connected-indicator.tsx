import { cn } from "@okouai/ui";
import { CircleCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

export function ConnectedIndicator({
  testId,
  connectedDetail,
  wrap = false,
}: {
  readonly wrap?: boolean;
  readonly testId?: string;
  readonly connectedDetail?: string | null;
}) {
  const { t } = useTranslation();

  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground",
        wrap ? "mr-auto max-w-full" : "max-w-52 shrink-0",
      )}
    >
      <CircleCheck className="h-3 w-3 shrink-0 text-green-600" />
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
