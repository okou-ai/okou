import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { command } from "ccstate";
import { and, eq, isNotNull, max } from "drizzle-orm";

import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { chatEventTypeIn } from "./chat-event-type.service";

/** The completion callback owns this admitted background metric's lifetime. */
export const recordLastEventToComplete$ = command(
  async ({ get }, runId: string): Promise<void> => {
    const db = get(db$);
    const [run] = await db
      .select({ completedAt: agentRuns.completedAt })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    if (!run?.completedAt) {
      return;
    }

    const [event] = await db
      .select({
        lastEventAt: max(chatEvents.createdAt).mapWith(
          nullableDriverValueDecoder(chatEvents.createdAt),
        ),
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.runId, runId),
          chatEventTypeIn(["output.message"]),
          isNotNull(chatEvents.runEventSequenceNumber),
        ),
      );
    if (!event?.lastEventAt) {
      return;
    }

    recordSandboxOperation({
      sandboxType: "runner",
      actionType: "last_event_to_complete",
      durationMs: Math.max(
        0,
        run.completedAt.getTime() - event.lastEventAt.getTime(),
      ),
      success: true,
      runId,
    });
  },
);
