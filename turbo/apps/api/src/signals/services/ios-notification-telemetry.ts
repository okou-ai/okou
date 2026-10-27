import { nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { flushAxiom, getDatasetName, ingestToAxiom } from "../external/axiom";
import { settleIncludingAbort } from "../utils";

/** Bounded delivery facts have their own telemetry stream, independent of debug logging. */
export function recordIosNotificationFact(
  fact: Readonly<{
    event: "apns_accepted" | "prefetch_observed";
    notificationId: string;
    source: "api" | "app" | "extension";
    runId?: string;
    threadId?: string;
    userId?: string;
    outcome?: "saved" | "failed" | "expired";
    durationMs: number;
    lastSeqId?: number;
    containsRun?: boolean;
  }>,
): void {
  waitUntil(
    settleIncludingAbort(async () => {
      const queued = ingestToAxiom(getDatasetName("web-logs"), [
        { _time: nowDate().toISOString(), type: "ios_notification", ...fact },
      ]);
      // APNs can finish after its callback response. This observer owns its flush.
      if (queued) {
        await flushAxiom({ client: "telemetry" });
      }
    }),
  );
}
