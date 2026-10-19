import { collectTemporaryAuthDiagnostic } from "@okouai/core/temporary-auth-diagnostics";
import { addBreadcrumb } from "@sentry/browser";

import { isAbortError } from "../signals/utils.ts";
import { now } from "./time.ts";

export interface ConnectorOAuthWaitDiagnostic {
  readonly phase:
    "started" | "cleanup" | "race-settled" | "finished" | "failed";
  readonly branch?: "connectorChanged" | "popupClosed";
  readonly parentAborted: boolean;
  readonly waitAborted: boolean;
  readonly current: boolean;
  readonly completionVerified: boolean;
  readonly cleanupOwned?: boolean;
  readonly accepted?: boolean;
  readonly error?: unknown;
}

// Temporary #41171 evidence shares the existing auth probe's expiry. Neither
// metadata collection nor the diagnostic SDK may change the OAuth outcome.
export function createConnectorOAuthWaitDiagnostics(): (
  read: () => ConnectorOAuthWaitDiagnostic,
) => void {
  const flowId = collectTemporaryAuthDiagnostic(now, () => {
    return crypto.randomUUID();
  });
  return (read) => {
    if (flowId === undefined) {
      return;
    }
    collectTemporaryAuthDiagnostic(now, () => {
      const event = read();
      addBreadcrumb({
        category: "connector.oauth.wait",
        type: "debug",
        level: "info",
        message: event.phase,
        data: {
          flow_id: flowId,
          parent_aborted: event.parentAborted,
          wait_aborted: event.waitAborted,
          current: event.current,
          completion_verified: event.completionVerified,
          ...(event.branch === undefined ? {} : { branch: event.branch }),
          ...(event.cleanupOwned === undefined
            ? {}
            : { cleanup_owned: event.cleanupOwned }),
          ...(event.accepted === undefined ? {} : { accepted: event.accepted }),
          ...("error" in event
            ? { error_kind: isAbortError(event.error) ? "aborted" : "error" }
            : {}),
        },
      });
    });
  };
}
