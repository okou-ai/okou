import Ably from "ably";
import { delay } from "signal-timers";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  sessionOutputChannelName,
  type SessionOutputDelta,
} from "@okouai/api-contracts/contracts/realtime";
import { nowDate } from "../../lib/time";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { assistantEventIdForRunEvent } from "../services/assistant-event-id";
import { waitUntil } from "../context/wait-until";
import { bestEffort, settleIncludingAbort } from "../utils";

const L = logger("SessionOutputStream");
const occupancySchema = z.object({
  metrics: z.object({ subscribers: z.number() }),
});

/** An attempt owns this connection. It observes occupancy without subscribing
 * to application messages, so its own attachment is not counted as a viewer. */
export function createSessionOutputStream(
  target: { userId: string; orgId: string; threadId: string; runId: string },
  signal: AbortSignal,
) {
  const client = new Ably.Realtime({
    key: env("ABLY_API_KEY"),
    queueMessages: false,
  });
  const channel = client.channels.get(
    sessionOutputChannelName(target.userId, target.orgId, target.runId),
    { modes: ["PUBLISH"], params: { occupancy: "metrics.subscribers" } },
  );
  let subscribers = 0;
  let closed = false;
  let draining: Promise<void> | undefined;
  const pending: SessionOutputDelta[] = [];
  const createdAt = nowDate().toISOString();
  channel.on((change) => {
    if (change.current !== "attached") {
      subscribers = 0;
    }
  });
  waitUntil(
    bestEffort(
      channel.subscribe("[meta]occupancy", (message) => {
        const parsed = occupancySchema.safeParse(message.data);
        subscribers = parsed.success ? parsed.data.metrics.subscribers : 0;
      }),
    ),
  );
  const abort = () => {
    closed = true;
    pending.length = 0;
    client.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }

  async function drain(): Promise<void> {
    while (pending.length > 0 && !signal.aborted) {
      const chunk = pending.shift();
      if (!chunk || subscribers === 0) {
        continue;
      }
      const result = await settleIncludingAbort(
        (async () => {
          await channel.publish(target.runId, chunk);
          // Cap message frequency and combine tokens arriving during the write.
          await delay(50, { signal });
        })(),
      );
      if (!result.ok) {
        pending.length = 0;
        subscribers = 0;
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
      if (closed || subscribers === 0) {
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
        waitUntil(draining);
      }
    },
    close(): void {
      closed = true;
      signal.removeEventListener("abort", abort);
      // Publication is optional background work; never hold up the durable commit.
      waitUntil(
        bestEffort(
          (async () => {
            await draining;
            client.close();
          })(),
        ),
      );
    },
  };
}
