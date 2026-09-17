import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { and, eq, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { revokeChatEvent, insertChatEvent } from "./chat-event.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import type { Tx } from "../../lib/db-types";
import { canonicalChatEventGoalId } from "./canonical-chat-event-read.service";
import { lockChatQueueThread } from "./chat-event-queue.service";

type DbTransaction = Tx;

const QUEUED_RUN_ASSISTANT_MESSAGE = "Waiting in queue...";

const QUEUED_RUN_MARKER_EVENT_ID = "queue:queued";

const revoker = alias(chatEvents, "revoker");
const QUEUED_RUN_MARKER_REVOKE_EVENT_ID = "queue:dequeued";

export interface QueueMarkerRevokeNotification {
  readonly chatThreadId: string;
  readonly userId: string;
}

type QueuedRunMarkerAppendResult =
  | { readonly kind: "not-queued" }
  | { readonly kind: "existing" }
  | { readonly kind: "appended"; readonly markerId: string };

export async function appendQueuedRunAssistantMarker(
  tx: DbTransaction,
  args: {
    readonly chatThreadId: string;
    readonly runId: string;
    readonly runGroupId?: string;
    readonly createdAfter?: Date;
  },
): Promise<QueuedRunMarkerAppendResult> {
  // Queue maintenance owns thread -> run -> provider. Marker insertion also
  // writes the thread sequence, so it must acquire the same thread first.
  await lockChatQueueThread(tx, args.chatThreadId);
  const [run] = await tx
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .for("update");
  if (run?.status !== "queued") {
    return { kind: "not-queued" };
  }

  const [existing] = await tx
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, args.runId),
        chatEventTypeIn(["run.queued"]),
        eq(chatEvents.runEventId, QUEUED_RUN_MARKER_EVENT_ID),
      ),
    )
    .limit(1);
  if (existing) {
    return { kind: "existing" };
  }

  const marker = await insertChatEvent(tx, {
    chatThreadId: args.chatThreadId,
    eventType: "run.queued",
    content: QUEUED_RUN_ASSISTANT_MESSAGE,
    runId: args.runId,
    runGroupId: args.runGroupId,
    runEventId: QUEUED_RUN_MARKER_EVENT_ID,
    ...(args.createdAfter
      ? { createdAt: new Date(args.createdAfter.getTime() + 1) }
      : {}),
  });
  if (!marker) {
    return { kind: "existing" };
  }
  return { kind: "appended", markerId: marker.id };
}

export async function revokeQueuedRunAssistantMarkers(
  tx: DbTransaction,
  args: {
    readonly runId: string;
    readonly userId: string;
  },
): Promise<QueueMarkerRevokeNotification | null> {
  const markers = await tx
    .select({
      id: chatEvents.id,
      chatThreadId: chatEvents.chatThreadId,
      runGroupId: canonicalChatEventGoalId(),
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, args.runId),
        chatEventTypeIn(["run.queued"]),
        eq(chatEvents.runEventId, QUEUED_RUN_MARKER_EVENT_ID),
        notExists(
          tx
            .select({ one: revoker.id })
            .from(revoker)
            .where(eq(revoker.revokesEventId, chatEvents.id)),
        ),
      ),
    );

  let notifiedThreadId: string | null = null;
  for (const marker of markers) {
    const inserted = await revokeChatEvent(tx, marker.id, {
      chatThreadId: marker.chatThreadId,
      eventType: "run.dequeued",
      runId: args.runId,
      runGroupId: marker.runGroupId ?? undefined,
      runEventId: QUEUED_RUN_MARKER_REVOKE_EVENT_ID,
    });
    if (inserted) {
      notifiedThreadId = marker.chatThreadId;
    }
  }

  return notifiedThreadId
    ? { chatThreadId: notifiedThreadId, userId: args.userId }
    : null;
}
