import { CircleCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

export function ConnectedIndicator({
  testId,
  connectedDetail,
}: {
  readonly testId?: string;
  readonly connectedDetail?: string | null;
}) {
  const { t } = useTranslation();

  return (
    <span
      data-testid={testId}
      className="inline-flex min-w-0 max-w-52 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground"
    >
      <CircleCheck className="h-3 w-3 text-green-600" />
      <span className="min-w-0 truncate">
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
