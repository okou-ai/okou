import { RemoteCheckHistory } from "./remote-check-history.tsx";
import { useLoadable, useLastLoadable } from "ccstate-react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SshConnectionObservation } from "@okouai/api-contracts/contracts/ssh-connection-observations";
import { sshIdentity$, sshObservationsSnapshot$ } from "../../signals/ssh.ts";
import { i18n, currentLocale } from "../../i18n/index.ts";

function useSshObservations():
  | {
      readonly kind: "available";
      readonly observations: readonly SshConnectionObservation[];
    }
  | { readonly kind: "loading" | "unavailable" } {
  const identity = useLoadable(sshIdentity$);
  const current = useLoadable(sshObservationsSnapshot$);
  const retained = useLastLoadable(sshObservationsSnapshot$);
  if (identity.state !== "hasData" || identity.data === null) {
    return { kind: "loading" };
  }
  if (current.state === "hasError") {
    return { kind: "unavailable" };
  }
  if (
    retained.state !== "hasData" ||
    retained.data.identity !== identity.data
  ) {
    return { kind: "loading" };
  }
  return retained.data.observations === null
    ? { kind: "unavailable" }
    : { kind: "available", observations: retained.data.observations };
}

export function SshAttention({
  connections,
}: {
  readonly connections: readonly {
    readonly id: string;
    readonly generation: number;
    readonly createdAt: string;
  }[];
}) {
  const { t } = useTranslation();
  const status = useSshObservations();
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
          return $.ssh.connectionStatus.unavailable;
        })
      : count > 0
        ? t(
            ($) => {
              return $.ssh.connectionStatus.attention;
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

function failureDescription(
  reason: NonNullable<SshConnectionObservation["failureReason"]>,
  tailscaleSsh: boolean,
): string {
  switch (reason) {
    case "access_rejected": {
      return i18n.t(($) => {
        return $.ssh.connectionStatus.accessRejected;
      });
    }
    case "access_tls_failure": {
      return i18n.t(($) => {
        return $.ssh.connectionStatus.accessTlsFailure;
      });
    }
    case "access_protocol_failure": {
      return i18n.t(($) => {
        return $.ssh.connectionStatus.accessProtocolFailure;
      });
    }
    case "invalid_credential": {
      return i18n.t(($) => {
        return $.ssh.connectionStatus.invalidCredential;
      });
    }
    case "unsupported_credential": {
      return i18n.t(($) => {
        return $.ssh.connectionStatus.unsupportedCredential;
      });
    }
    case "credential_resource_limit": {
      return i18n.t(($) => {
        return $.ssh.connectionStatus.credentialResourceLimit;
      });
    }
    case "unsafe_destination": {
      return i18n.t(($) => {
        return $.ssh.connectionStatus.unsafeDestination;
      });
    }
    case "network_failure": {
      return i18n.t(($) => {
        return $.ssh.connectionStatus.networkFailure;
      });
    }
    case "host_key_mismatch": {
      return i18n.t(($) => {
        return $.ssh.connectionStatus.hostKeyMismatch;
      });
    }
    case "unsupported_host_key": {
      return i18n.t(($) => {
        return $.ssh.connectionStatus.unsupportedHostKey;
      });
    }
    case "authentication_failed": {
      if (tailscaleSsh) {
        return i18n.t(($) => {
          return $.ssh.tailscale.authenticationFailed;
        });
      }
      return i18n.t(($) => {
        return $.ssh.connectionStatus.authenticationFailed;
      });
    }
    case "protocol": {
      return i18n.t(($) => {
        return $.ssh.connectionStatus.protocol;
      });
    }
    case "timed_out": {
      return i18n.t(($) => {
        return $.ssh.connectionStatus.timedOut;
      });
    }
  }
}

export function SshHostWarning({
  connectionId,
  generation,
  createdAt,
  tailscaleSsh,
}: {
  readonly connectionId: string;
  readonly generation: number;
  readonly createdAt: string;
  readonly tailscaleSsh: boolean;
}) {
  const { t } = useTranslation();
  const status = useSshObservations();
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
  return (
    <div
      role="status"
      className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400"
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="grid gap-1">
        <p>{failureDescription(observation.failureReason, tailscaleSsh)}</p>
        <time
          dateTime={observation.observedAt}
          className="text-xs text-muted-foreground"
        >
          {t(
            ($) => {
              return $.ssh.connectionStatus.observedAt;
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

export function SshLastCheck({
  connectionId,
  generation,
  createdAt,
}: {
  readonly connectionId: string;
  readonly generation: number;
  readonly createdAt: string;
}) {
  const status = useSshObservations();
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
  return <RemoteCheckHistory kind={status.kind} observation={observation} />;
}
