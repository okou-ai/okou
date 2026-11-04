import type { settle } from "../utils";
import { logger } from "../../lib/log";

const L = logger("QueuedLaunchEnrichment");

/**
 * Optional history/name lookups cannot block an accepted input: unavailable
 * optional enrichment is omitted with a warning and the fallback is used.
 * Callers own loading and cancellation before resolving the completed result.
 */
export function resolveOptionalChatEnrichment<T>(
  channel: string,
  result: Awaited<ReturnType<typeof settle<T>>>,
  fallback: (error: unknown) => T,
): T {
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
