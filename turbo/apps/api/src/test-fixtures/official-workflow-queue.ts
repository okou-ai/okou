import { chatEventCommandResultSchema } from "../signals/services/chat-event-append.service";
import { parseRawRows } from "../lib/db-raw-rows";
import { reserveFixtureChatEventSequence } from "./chat-event-sequences";
import { randomUUID } from "node:crypto";

import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";
import { nowDate } from "../lib/time";
import {
  chatEventReplacementInsertSql,
  requireChatEventReplacementTarget,
  chatEventReplacementTargetSql,
  chatEventReplacementTargetSchema,
} from "../signals/services/chat-event.service";

export async function readOfficialWorkflowQueueInputFixture(eventId: string) {
  const [row] = await db()
    .select()
    .from(chatEvents)
    .where(eq(chatEvents.id, eventId));
  if (!row || row.eventType !== "input.prompt" || row.runId !== null) {
    throw new Error("Expected an immutable runless Official queue source");
  }
  return row;
}

/**
 * Historical persisted-state exception (docs/testing.md rollout coexistence;
 * docs/testing/testing-external-behavior.md historical states): production
 * writers can no longer produce historical-brand or canonical queue encodings,
 * which web-chat-queue-context.service.ts still reads during the #29908
 * compatibility window. Delete with that reader when the window closes.
 * Append a test-owned persisted input and revoke the original; never update an
 * immutable event or relax its storage constraints.
 */
export async function appendOfficialWorkflowQueueInputFixture(args: {
  readonly eventId: string;
  readonly contextId: string;
  readonly contextType: NonNullable<
    (typeof chatEvents.$inferSelect)["contextType"]
  >;
  readonly claim: readonly string[] | null;
  readonly userMessage: UserMessageDocument;
}) {
  const source = await readOfficialWorkflowQueueInputFixture(args.eventId);
  return await db().transaction(async (tx) => {
    const revoked =
      parseRawRows(
        chatEventCommandResultSchema,
        await tx.execute(
          chatEventReplacementInsertSql(
            requireChatEventReplacementTarget(
              parseRawRows(
                chatEventReplacementTargetSchema,
                await tx.execute(chatEventReplacementTargetSql(source.id)),
              ),
            ),
            {
              chatThreadId: source.chatThreadId,
              eventType: "control.revoke",
              content: null,
            },
          ),
        ),
      )[0] ?? null;
    if (!revoked) {
      throw new Error("Official queue fixture source was already revoked");
    }
    const thread = {
      seqId: await reserveFixtureChatEventSequence(tx, source.chatThreadId, 1),
    };
    if (!thread) {
      throw new Error("Official queue fixture thread is missing");
    }
    const [row] = await tx
      .insert(chatEvents)
      .values({
        id: randomUUID(),
        chatThreadId: source.chatThreadId,
        eventType: "input.prompt",
        modelSelection: source.modelSelection,
        contextType: args.contextType,
        contextId: args.contextId,
        requiredOfficialWorkflowIds: args.claim,
        payload: { userMessage: args.userMessage },
        seqId: thread.seqId,
        createdAt: new Date(
          Math.max(nowDate().getTime(), revoked.createdAt.getTime() + 1),
        ),
      })
      .returning();
    if (!row) {
      throw new Error("Official queue fixture was not inserted");
    }
    return row;
  });
}
