import { chatInputModelSelectionSchema } from "@okouai/api-contracts/contracts/chat-input-model";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSequences } from "@okouai/db/schema/chat-event-sequence";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { command } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  lte,
  notExists,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { v5 as uuidv5 } from "uuid";
import { number, object, uuid, type infer as zInfer } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import {
  canonicalChatEventInputCtes,
  canonicalChatEventInsertSql,
  chatEventCommandResultSchema,
} from "./chat-event-append.service";
import { pendingChatQueueEventCondition } from "./chat-event-queue.service";
import { touchChatThreadLastMessageAtIndependently$ } from "./chat-event-shared.service";
import { prepareChatEvent } from "./chat-event.service";
import type { ChatRunFinishedEvent } from "./chat-run-finished-event";
import { pickEnqueuedChatThread$ } from "./chat-thread-queue-drain.service";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import {
  normalChatInputConflictSql,
  normalChatInputInsertSql,
} from "./normal-chat-input-publication-sql";
import { queuedChatThreadEnqueuePlan } from "./queued-chat-thread.service";

const JOB_KIND = FeatureSwitchKey.AutoContinueBusyChats;
const JOB_VERSION = 1;
const RETRY_NAMESPACE = "ac2eae18-dd8a-48f0-9732-201888ca3c4b";
const RETRY_DELAYS_MS = [60_000, 180_000, 300_000] as const;
const retryInputSchema = object({
  chatThreadId: uuid(),
  runId: uuid(),
  failedSeqId: number().int().positive(),
  modelSelection: chatInputModelSelectionSchema,
  attempt: number().int().min(1).max(RETRY_DELAYS_MS.length),
});

/** The failed callback durably schedules work; it never starts a polling model. */
export const scheduleModelBusyRetry$ = command(
  async ({ get, set }, event: ChatRunFinishedEvent, signal: AbortSignal) => {
    if (
      event.runStatus !== "failed" ||
      event.failureReason !== "provider_overloaded"
    ) {
      return;
    }
    const database = get(db$);
    const [source] = await database
      .select({
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        selectedModel: chatThreads.selectedModel,
        codexServiceTier: chatThreads.codexServiceTier,
        modelSettings: chatThreads.modelSettings,
        failedSeqId: chatEvents.seqId,
        failedAt: chatEvents.createdAt,
      })
      .from(agentRuns)
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
          eq(chatThreads.userId, agentRuns.userId),
          eq(chatThreads.agentId, agentRuns.agentId),
        ),
      )
      .innerJoin(
        chatEvents,
        and(
          eq(chatEvents.runId, agentRuns.id),
          eq(chatEvents.chatThreadId, chatThreads.id),
          eq(chatEvents.eventType, "run.failed"),
          eq(chatEvents.failureReason, "provider_overloaded"),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, event.runId),
          eq(agentRuns.selectedModel, chatThreads.selectedModel),
          eq(chatThreads.id, event.chatThreadId),
          eq(chatThreads.archived, false),
          eq(chatThreads.hidden, false),
          gt(agentRuns.autonomyBudget, 0),
          // Channel delivery and hidden Official Workflows retain their own lifecycle.
          inArray(agentRuns.triggerSource, [
            "web",
            "agent",
            "automation-schedule",
            "automation-event",
          ]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!source) {
      return;
    }
    const features = await set(
      loadUserFeatureSwitchContext$,
      source.orgId,
      source.userId,
      signal,
    );
    if (!isFeatureEnabled(JOB_KIND, features)) {
      return;
    }
    // A claimed input retains the queued event ID in revokesEventId. Only our
    // durable receipt advances the retry count; user-written "continue" does not.
    const [input] = await database
      .select({ retry: backgroundJobs.input })
      .from(chatEvents)
      .leftJoin(
        backgroundJobs,
        and(
          eq(backgroundJobs.id, chatEvents.revokesEventId),
          eq(backgroundJobs.kind, JOB_KIND),
          eq(backgroundJobs.handlerVersion, JOB_VERSION),
          eq(backgroundJobs.userId, source.userId),
          eq(backgroundJobs.orgId, source.orgId),
        ),
      )
      .where(
        and(
          eq(chatEvents.runId, event.runId),
          eq(chatEvents.eventType, "input.prompt"),
        ),
      )
      .orderBy(desc(chatEvents.seqId))
      .limit(1);
    signal.throwIfAborted();
    const attempt = input?.retry
      ? retryInputSchema.parse(input.retry).attempt + 1
      : 1;
    const delay = RETRY_DELAYS_MS[attempt - 1];
    if (delay === undefined) {
      return;
    }
    await set(writeDb$)
      .insert(backgroundJobs)
      .values({
        id: uuidv5(event.runId, RETRY_NAMESPACE),
        kind: JOB_KIND,
        handlerVersion: JOB_VERSION,
        userId: source.userId,
        orgId: source.orgId,
        input: {
          chatThreadId: event.chatThreadId,
          runId: event.runId,
          failedSeqId: source.failedSeqId,
          modelSelection: {
            selectedModel: source.selectedModel,
            codexServiceTier: source.codexServiceTier,
            reasoningEffort:
              source.modelSettings[source.selectedModel]?.effort ?? null,
          },
          attempt,
        },
        availableAt: new Date(source.failedAt.getTime() + delay),
        createdAt: nowDate(),
        updatedAt: nowDate(),
      })
      .onConflictDoNothing({ target: backgroundJobs.id });
    signal.throwIfAborted();
  },
);

/** Rechecked in the admission statement so intervening input takes precedence. */
function eligibleBusyChatQuery(
  job: Pick<typeof backgroundJobs.$inferSelect, "orgId" | "userId">,
  input: zInfer<typeof retryInputSchema>,
) {
  return new QueryBuilder()
    .select({ lastSeqId: chatEventSequences.lastSeqId })
    .from(chatThreads)
    .innerJoin(
      chatEventSequences,
      eq(chatEventSequences.chatThreadId, chatThreads.id),
    )
    .innerJoin(
      agentRuns,
      and(
        eq(agentRuns.id, input.runId),
        eq(agentRuns.chatThreadId, chatThreads.id),
        eq(agentRuns.agentId, chatThreads.agentId),
        eq(agentRuns.userId, job.userId),
        eq(agentRuns.orgId, job.orgId),
        eq(agentRuns.status, "failed"),
        gt(agentRuns.autonomyBudget, 0),
      ),
    )
    .where(
      and(
        eq(chatThreads.id, input.chatThreadId),
        eq(chatThreads.userId, job.userId),
        eq(chatThreads.archived, false),
        eq(chatThreads.hidden, false),
        eq(chatThreads.selectedModel, input.modelSelection.selectedModel),
        notExists(
          new QueryBuilder()
            .select({ id: chatEvents.id })
            .from(chatEvents)
            .where(
              and(
                eq(chatEvents.runId, input.runId),
                eq(chatEvents.eventType, "control.interrupt"),
              ),
            ),
        ),
        notExists(
          new QueryBuilder()
            .select({ id: activeAgentRuns.runId })
            .from(activeAgentRuns)
            .where(eq(activeAgentRuns.chatThreadId, input.chatThreadId)),
        ),
        notExists(
          new QueryBuilder()
            .select({ id: chatEvents.id })
            .from(chatEvents)
            .where(
              and(
                eq(chatEvents.chatThreadId, input.chatThreadId),
                pendingChatQueueEventCondition(),
              ),
            ),
        ),
        notExists(
          new QueryBuilder()
            .select({ id: chatEvents.id })
            .from(chatEvents)
            .where(
              and(
                eq(chatEvents.chatThreadId, input.chatThreadId),
                gt(chatEvents.seqId, input.failedSeqId),
                inArray(chatEvents.eventType, [
                  "input.prompt",
                  "input.automation",
                  "input.budget",
                  "input.rejected",
                  "control.interrupt",
                  "control.revoke",
                  "run.completed",
                  "run.failed",
                  "run.cancelled",
                ]),
              ),
            ),
        ),
      ),
    )
    .limit(1);
}

const continueModelBusyChat$ = command(
  async (
    { get, set },
    job: typeof backgroundJobs.$inferSelect,
    signal: AbortSignal,
  ) => {
    const input = retryInputSchema.parse(job.input);
    const features = await set(
      loadUserFeatureSwitchContext$,
      job.orgId,
      job.userId,
      signal,
    );
    const database = get(db$);
    const currentThread = eligibleBusyChatQuery(job, input);
    const [thread] = isFeatureEnabled(JOB_KIND, features)
      ? await database.select().from(currentThread.as("eligible_busy_chat"))
      : [];
    signal.throwIfAborted();
    const pendingJob = and(
      eq(backgroundJobs.id, job.id),
      eq(backgroundJobs.status, "pending"),
    );
    if (!thread) {
      await set(writeDb$)
        .update(backgroundJobs)
        .set({
          status: "cancelled",
          completedAt: nowDate(),
          updatedAt: nowDate(),
        })
        .where(pendingJob);
      signal.throwIfAborted();
      return false;
    }
    const createdAt = nowDate();
    const prepared = prepareChatEvent({
      id: job.id,
      chatThreadId: input.chatThreadId,
      eventType: "input.prompt",
      contextType: "agent_run",
      contextId: input.runId,
      modelSelection: input.modelSelection,
      userMessage: { version: 1, parts: [{ type: "text", text: "continue" }] },
      createdAt,
    });
    const queue = queuedChatThreadEnqueuePlan({
      chatThreadId: input.chatThreadId,
      orgId: job.orgId,
    });
    // The existing sequence watermark arbitrates a concurrent manual input.
    // Receipt consumption, input insertion and queue wakeup commit together.
    const rows = parseRawRows(
      chatEventCommandResultSchema,
      await set(writeDb$).execute(sql`
      WITH ${canonicalChatEventInputCtes([prepared.row], exists(currentThread), thread.lastSeqId)},
      admitted AS (
        UPDATE ${backgroundJobs}
        SET status = 'completed', completed_at = ${createdAt.toISOString()}::timestamp,
          updated_at = ${createdAt.toISOString()}::timestamp
        WHERE ${pendingJob} AND EXISTS (SELECT 1 FROM reserved)
        RETURNING id
      ), inserted AS (${canonicalChatEventInsertSql("id", {
        eligibility: sql`EXISTS (SELECT 1 FROM admitted) AND EXISTS (SELECT 1 FROM reserved)`,
      })}), queued AS (${normalChatInputInsertSql(
        queuedChatThreads,
        queue.values,
        sql`EXISTS (SELECT 1 FROM inserted)`,
        normalChatInputConflictSql(
          queuedChatThreads,
          [queue.conflict.target],
          queue.conflict.set,
        ),
      )})
      SELECT id, created_at::text AS "createdAt", seq_id AS "seqId",
        run_event_sequence_number AS "sequenceNumber" FROM inserted
    `),
    );
    signal.throwIfAborted();
    const inserted = rows[0];
    if (!inserted) {
      return false;
    }
    await set(
      touchChatThreadLastMessageAtIndependently$,
      input.chatThreadId,
      { touchedAt: inserted.createdAt, eventId: inserted.id },
      signal,
    );
    await publishChatThreadMessageCreatedSafely({
      userId: job.userId,
      orgId: job.orgId,
      threadId: input.chatThreadId,
    });
    signal.throwIfAborted();
    await set(
      pickEnqueuedChatThread$,
      { orgId: job.orgId, chatThreadId: input.chatThreadId },
      signal,
    );
    return true;
  },
);

/** Existing minute cron drives only due receipts, independently of open tabs. */
export const continueModelBusyChats$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const jobs = await get(db$)
      .select()
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.kind, JOB_KIND),
          eq(backgroundJobs.handlerVersion, JOB_VERSION),
          eq(backgroundJobs.status, "pending"),
          lte(backgroundJobs.availableAt, nowDate()),
        ),
      )
      .orderBy(asc(backgroundJobs.availableAt), asc(backgroundJobs.id))
      .limit(100);
    signal.throwIfAborted();
    let continued = 0;
    for (const job of jobs) {
      if (await set(continueModelBusyChat$, job, signal)) {
        continued += 1;
      }
    }
    return continued;
  },
);
