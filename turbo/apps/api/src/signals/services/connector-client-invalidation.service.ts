import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { ConnectorChangedPayload } from "@okouai/api-contracts/contracts/realtime";

import { logger } from "../../lib/log";
import { publishUserSignal } from "../external/realtime";
import { settleIncludingAbort } from "../utils";

const L = logger("ConnectorClientInvalidation");

export interface CapturedConnectorClientInvalidationAbort {
  readonly reason: unknown;
}

/**
 * Attempts the built-in connector notification after an authoritative mutation
 * commits, then surfaces any request abort observed across that boundary.
 */
export async function publishBuiltinConnectorInvalidationAfterCommit(
  args: {
    readonly userId: string;
    readonly connectorSlug: ConnectorSlug;
    readonly previouslyCapturedAbort?: CapturedConnectorClientInvalidationAbort;
  },
  signal: AbortSignal,
): Promise<void> {
  const capturedAbort =
    args.previouslyCapturedAbort ??
    (signal.aborted ? { reason: signal.reason } : undefined);
  const outcome = await settleIncludingAbort(
    publishUserSignal([args.userId], "connector:changed", {
      connectorSlug: args.connectorSlug,
    } satisfies ConnectorChangedPayload),
  );
  if (!outcome.ok) {
    L.warn("Failed to publish connector client invalidation", {
      kind: "builtin",
      audience: "user",
      userId: args.userId,
      connectorSlug: args.connectorSlug,
      recipientUserId: args.userId,
      error: outcome.error,
    });
  }
  if (capturedAbort) {
    throw capturedAbort.reason;
  }
  signal.throwIfAborted();
}
