import { settle } from "../utils";
import { logger } from "../../lib/log";

const L = logger("QueuedLaunchEnrichment");

/**
 * Optional history/name lookups cannot block an accepted input: unavailable
 * optional enrichment is omitted with a warning and the fallback is used.
 * Cancellation still propagates.
 */
export async function loadOptionalChatEnrichment<T>(
  channel: string,
  load: () => Promise<T>,
  fallback: (error: unknown) => T,
  signal: AbortSignal,
): Promise<T> {
  const result = await settle(load(), signal);
  if (result.ok) {
    return result.value;
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
