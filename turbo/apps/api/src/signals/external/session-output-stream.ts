import { delay } from "signal-timers";
import { randomUUID } from "node:crypto";
import type { SessionOutputDelta } from "@okouai/api-contracts/contracts/realtime";
import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import { assistantEventIdForRunEvent } from "../services/assistant-event-id";
import { waitUntil } from "../context/wait-until";
import { settleIncludingAbort } from "../utils";
import { publishSessionOutputDelta } from "./realtime";

const L = logger("SessionOutputStream");

/** An attempt owns the transient text buffer and its publication lifetime. */
export function createSessionOutputStream(
  target: { userId: string; orgId: string; threadId: string; runId: string },
  signal: AbortSignal,
) {
  let closed = false;
  let draining: Promise<void> | undefined;
  const pending: SessionOutputDelta[] = [];
  const createdAt = nowDate().toISOString();
  const abort = () => {
    closed = true;
    pending.length = 0;
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }

  async function drain(): Promise<void> {
    while (pending.length > 0 && !signal.aborted) {
      const chunk = pending.shift();
      if (!chunk) {
        continue;
      }
      const result = await settleIncludingAbort(
        (async () => {
          await publishSessionOutputDelta(target, chunk);
          // Cap message frequency and combine tokens arriving during the write.
          await delay(50, { signal });
        })(),
      );
      if (!result.ok) {
        pending.length = 0;
        if (!signal.aborted) {
          L.warn("Transient text publication failed", {
            runId: target.runId,
            error: result.error,
          });
        }
        break;
      }
    }
    draining = undefined;
  }

  return {
    eventIdPrefix: `api-first:${randomUUID()}`,
    onDelta(
      chunk: Pick<SessionOutputDelta, "runEventId" | "chunkIndex" | "delta">,
    ): void {
      if (closed) {
        return;
      }
      const previous = pending.at(-1);
      if (
        previous?.runEventId === chunk.runEventId &&
        previous.delta.length + chunk.delta.length <= 4096
      ) {
        previous.delta += chunk.delta;
      } else {
        pending.push({
          ...chunk,
          threadId: target.threadId,
          runId: target.runId,
          eventId: assistantEventIdForRunEvent(target.runId, chunk.runEventId),
          createdAt,
        });
      }
      if (!draining) {
        draining = drain();
        // Publication remains background work so the durable commit can proceed.
        waitUntil(draining);
      }
    },
    close(): void {
      closed = true;
      signal.removeEventListener("abort", abort);
    },
  };
}
