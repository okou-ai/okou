import { useGet, useLoadable, useLastLoadable } from "ccstate-react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { VncConnectionObservation } from "@okouai/api-contracts/contracts/vnc-connection-observations";
import { currentLocale } from "../../i18n/index.ts";
import { vncIdentity$, vncObservationsSnapshot$ } from "../../signals/vnc.ts";
import { vncObservationConfigurationRevision$ } from "../../signals/remote-access-refresh.ts";

function useVncObservations():
  | {
      readonly kind: "available";
      readonly observations: readonly VncConnectionObservation[];
    }
  | { readonly kind: "loading" | "unavailable" } {
  const identity = useLoadable(vncIdentity$);
  const current = useLoadable(vncObservationsSnapshot$);
  const retained = useLastLoadable(vncObservationsSnapshot$);
  const configurationRevision = useGet(vncObservationConfigurationRevision$);
  if (identity.state !== "hasData" || identity.data === null) {
    return { kind: "loading" };
  }
  if (current.state === "hasError") {
    return { kind: "unavailable" };
  }
  if (
    retained.state !== "hasData" ||
    retained.data.identity !== identity.data ||
    retained.data.configurationRevision !== configurationRevision
  ) {
    return { kind: "loading" };
  }
  return retained.data.observations === null
    ? { kind: "unavailable" }
    : { kind: "available", observations: retained.data.observations };
}

export function VncAttention({
  connections,
}: {
  readonly connections: readonly {
    readonly id: string;
    readonly generation: number;
    readonly createdAt: string;
  }[];
}) {
  const { t } = useTranslation();
  const status = useVncObservations();
  const count =
    status.kind === "available"
      ? connections.filter((connection) => {
          return status.observations.some((observation) => {
            return (
              observation.connectionId === connection.id &&
              observation.generation === connection.generation &&
              observation.connectionCreatedAt === connection.createdAt &&
              observation.failureReason !== null
            );
          });
        }).length
      : 0;
  const label =
    status.kind === "unavailable"
      ? t(($) => {
          return $.vnc.connectionStatus.unavailable;
        })
      : count > 0
        ? t(
            ($) => {
              return $.vnc.connectionStatus.attention;
            },
            { count },
          )
        : null;
  if (!label) {
    return null;
  }
  return (
    <span
      role="status"
      aria-label={label}
      className="inline-flex min-w-0 items-center gap-1 text-amber-600 dark:text-amber-400"
    >
      <AlertTriangle size={12} className="shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function VncHostWarning({
  connectionId,
  generation,
  createdAt,
}: {
  readonly connectionId: string;
  readonly generation: number;
  readonly createdAt: string;
}) {
  const { t } = useTranslation();
  const status = useVncObservations();
  const observation =
    status.kind === "available"
      ? status.observations.find((item) => {
          return (
            item.connectionId === connectionId &&
            item.generation === generation &&
            item.connectionCreatedAt === createdAt
          );
        })
      : undefined;
  if (!observation?.failureReason) {
    return null;
  }
  const reason = observation.failureReason;
  return (
    <div
      role="status"
      className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400"
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="grid gap-1">
        <p>
          {t(($) => {
            return $.vnc.connectionStatus.reasons[reason];
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
