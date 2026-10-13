import { useLoadable } from "ccstate-react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { currentLocale } from "../../i18n/index.ts";
import { vncIdentity$, vncObservationsSnapshot$ } from "../../signals/vnc.ts";

export function VncConnectionStatus({
  connectionId,
  generation,
}: {
  readonly connectionId: string;
  readonly generation: number;
}) {
  const { t } = useTranslation();
  const identity = useLoadable(vncIdentity$);
  const snapshot = useLoadable(vncObservationsSnapshot$);
  if (snapshot.state === "hasError") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.connectionStatus.unavailable;
        })}
      </p>
    );
  }
  if (
    identity.state !== "hasData" ||
    !identity.data ||
    snapshot.state !== "hasData" ||
    snapshot.data.identity !== identity.data
  ) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.connectionStatus.loading;
        })}
      </p>
    );
  }
  if (snapshot.data.observations === null) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.connectionStatus.unavailable;
        })}
      </p>
    );
  }
  const observation = snapshot.data.observations.find((item) => {
    return item.connectionId === connectionId && item.generation === generation;
  });
  if (!observation) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.connectionStatus.unobserved;
        })}
      </p>
    );
  }
  const reason = observation.failureReason;
  return (
    <div
      role="status"
      className={
        reason
          ? "flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400"
          : "flex items-start gap-2 text-sm text-muted-foreground"
      }
    >
      {reason && (
        <AlertTriangle
          size={16}
          className="mt-0.5 shrink-0"
          aria-hidden="true"
        />
      )}
      <div className="grid gap-1">
        <p>
          {reason
            ? t(($) => {
                return $.vnc.connectionStatus.reasons[reason];
              })
            : t(($) => {
                return $.vnc.connectionStatus.succeeded;
              })}
        </p>
        <time
          dateTime={observation.observedAt}
          className="text-xs text-muted-foreground"
        >
          {t(
            ($) => {
              return $.vnc.connectionStatus.observedAt;
            },
            {
              time: new Intl.DateTimeFormat(currentLocale(), {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(observation.observedAt)),
            },
          )}
        </time>
      </div>
    </div>
  );
}
