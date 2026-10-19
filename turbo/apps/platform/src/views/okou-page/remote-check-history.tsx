import { useTranslation } from "react-i18next";
import { currentLocale } from "../../i18n/index.ts";

export function RemoteCheckHistory({
  kind,
  observation,
}: {
  readonly kind: "available" | "loading" | "unavailable";
  readonly observation?: {
    readonly failureReason: string | null;
    readonly observedAt: string;
  };
}) {
  const { t } = useTranslation();
  return (
    <span
      className="grid gap-1 text-xs text-muted-foreground"
      title={t(($) => {
        return $.remoteControlSetup.historyHelp;
      })}
    >
      <span>
        {t(($) => {
          return kind === "loading"
            ? $.remoteControlSetup.loading
            : kind === "unavailable"
              ? $.remoteControlSetup.unavailable
              : !observation
                ? $.remoteControlSetup.unchecked
                : observation.failureReason
                  ? $.remoteControlSetup.failed
                  : $.remoteControlSetup.passed;
        })}
      </span>
      {observation && (
        <time dateTime={observation.observedAt}>
          {new Intl.DateTimeFormat(currentLocale(), {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(observation.observedAt))}
        </time>
      )}
    </span>
  );
}
