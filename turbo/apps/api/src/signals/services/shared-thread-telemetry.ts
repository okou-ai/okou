import { waitUntil } from "../context/wait-until";
import { nowDate } from "../../lib/time";
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import { settleIncludingAbort, isAbortError } from "../utils";

interface SharedThreadPhase {
  readonly shareId: string;
  readonly phase: "title" | "prepare" | "alias" | "copy" | "total";
  readonly durationMs: number;
  readonly status?: string;
  readonly attempts?: number;
  readonly copyCount?: number;
  readonly uploadCount?: number;
  readonly resourceCount?: number;
}

/**
 * These phases settle before the route returns, so the request logger owns
 * the telemetry flush. Do not issue a separate flush for every alias.
 * No content, private URLs, or provider errors enter timing telemetry.
 */
export function recordSharedThreadPhase(phase: SharedThreadPhase): void {
  waitUntil(
    settleIncludingAbort(() => {
      return ingestToAxiom(getDatasetName("web-logs"), [
        {
          _time: nowDate().toISOString(),
          type: "shared_thread_phase",
          source: "api",
          ...phase,
        },
      ]);
    }),
  );
}

/** Measure both success and rejection without changing operation lifetime. */
export async function measureSharedThreadPhase<T>(
  details: Omit<SharedThreadPhase, "durationMs" | "status">,
  operation: Promise<T>,
  status: (value: T) => string = () => {
    return "completed";
  },
  startedAt = performance.now(),
): Promise<T> {
  const result = await settleIncludingAbort(operation);
  recordSharedThreadPhase({
    ...details,
    durationMs: Math.round(performance.now() - startedAt),
    status: result.ok
      ? status(result.value)
      : isAbortError(result.error)
        ? "cancelled"
        : "failed",
  });
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
