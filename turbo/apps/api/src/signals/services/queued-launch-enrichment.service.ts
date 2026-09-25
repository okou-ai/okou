import type { Db } from "../external/db";
import { settle } from "../utils";
import { isSplitChatEventWriteEnabled } from "./chat-event-write-mode.service";
import { logger } from "../../lib/log";

const L = logger("QueuedLaunchEnrichment");

/**
 * Optional history/name lookups cannot block an accepted input after activation.
 * PR2 removes the legacy failure branch after old operations and rollback APIs
 * drain; omitting unavailable optional enrichment is the permanent contract.
 */
export async function loadOptionalChatEnrichment<T>(
  db: Db,
  channel: string,
  load: () => Promise<T>,
  fallback: (error: unknown) => T,
  signal: AbortSignal,
): Promise<T> {
  const result = await settle(load(), signal);
  if (result.ok) {
    return result.value;
  }
  const splitWrites = await isSplitChatEventWriteEnabled(db);
  signal.throwIfAborted();
  if (!splitWrites) {
    throw result.error;
  }
  // A channel fallback may rethrow failures that keep its ingress retry
  // classification instead of omitting the enrichment.
  const value = fallback(result.error);
  L.warn("Optional chat input enrichment could not be loaded", {
    channel,
    errorName:
      result.error instanceof Error ? result.error.name : "UnknownError",
  });
  return value;
}
