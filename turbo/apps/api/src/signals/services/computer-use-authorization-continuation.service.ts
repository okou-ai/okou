import { command } from "ccstate";
import { and, eq, exists, gt, inArray, isNull, not, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { boolean, object } from "zod";
import type { ChatInputModelSelection } from "@okouai/api-contracts/contracts/chat-input-model";
import { modelSettingsSchema } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { computerUseHosts } from "@okouai/db/runtime/computer-use-host";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSequences } from "@okouai/db/schema/chat-event-sequence";
import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";
import { computerUseAuthorizationRequests } from "@okouai/db/schema/computer-use-host";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { parseRawRows } from "../../lib/db-raw-rows";
import {
  pgBooleanDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import {
  type PreparedChatEventRow,
  canonicalChatEventInputCtes,
  canonicalChatEventInsertSql,
} from "./chat-event-append.service";
import { chatThreadEventInsertPlan } from "./chat-thread-event.service";
import { resolveChatInputModelSelection$ } from "./chat-input-model.service";
import { queuedChatThreadEnqueuePlan } from "./queued-chat-thread.service";
import { webChatContextId } from "./web-chat-queue-context.service";

interface Scope {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly chatThreadId: string;
}

function chatBusy(scope: Scope) {
  return exists(
    new QueryBuilder()
      .select({ id: activeAgentRuns.runId })
      .from(activeAgentRuns)
      .where(eq(activeAgentRuns.chatThreadId, scope.chatThreadId)),
  );
}

function superseded(scope: Scope) {
  // Consumed inputs retain their Run identity. A later prompt (including a
  // pending one) means the old card no longer owns the next round.
  return sql`EXISTS (SELECT 1 FROM ${chatEvents} AS newer
    WHERE newer.chat_thread_id = ${scope.chatThreadId}::uuid
      AND newer.event_type = 'input.prompt'
      AND newer.seq_id > (SELECT COALESCE(MAX(seq_id), 0) FROM ${chatEvents}
        WHERE chat_thread_id = ${scope.chatThreadId}::uuid
          AND run_id = ${scope.runId}::uuid AND event_type = 'input.prompt'))`;
}

export const readComputerUseContinuation$ = command(
  async ({ get }, scope: Scope, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select({
        thread: {
          agentId: agents.id,
          selectedModel: chatThreads.selectedModel,
          codexServiceTier: chatThreads.codexServiceTier,
          modelSettings: chatThreads.modelSettings,
          rowVersion: sql`${chatThreads}.xmin::text`.mapWith(pgTextDecoder),
        },
        source: agentRuns.triggerSource,
        runStatus: agentRuns.status,
        busy: chatBusy(scope).mapWith(pgBooleanDecoder),
        superseded: superseded(scope).mapWith(pgBooleanDecoder),
        lastSeqId: chatEventSequences.lastSeqId,
      })
      .from(chatThreads)
      .innerJoin(
        agents,
        and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, scope.orgId)),
      )
      .innerJoin(
        agentRuns,
        and(
          eq(agentRuns.id, scope.runId),
          eq(agentRuns.chatThreadId, scope.chatThreadId),
          eq(agentRuns.orgId, scope.orgId),
          eq(agentRuns.userId, scope.userId),
        ),
      )
      .innerJoin(
        chatEventSequences,
        eq(chatEventSequences.chatThreadId, chatThreads.id),
      )
      .where(
        and(
          eq(chatThreads.id, scope.chatThreadId),
          eq(chatThreads.userId, scope.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    // Canonical Slack and Teams Runs also use source=chat authorization requests.
    // Only Web inputs may create a Web continuation.
    if (!row || row.source !== "web") {
      return null;
    }
    const blockedReason = ![
      "completed",
      "failed",
      "cancelled",
      "timeout",
    ].includes(row.runStatus)
      ? ("run_active" as const)
      : row.superseded
        ? ("request_superseded" as const)
        : row.busy
          ? ("chat_busy" as const)
          : null;
    return { ...row, blockedReason };
  },
);

type Context = NonNullable<
  Awaited<ReturnType<(typeof readComputerUseContinuation$)["write"]>>
>;

const completedContinuation$ = command(
  async ({ set }, scope: Scope, hostId: string, signal: AbortSignal) => {
    const [row] = await set(writeDb$)
      .select({
        completedAt: computerUseAuthorizationRequests.completedAt,
        hostId: chatThreadEvents.computerUseHostId,
      })
      .from(computerUseAuthorizationRequests)
      .leftJoin(
        chatThreadEvents,
        eq(chatThreadEvents.id, computerUseAuthorizationRequests.id),
      )
      .where(
        and(
          eq(computerUseAuthorizationRequests.id, scope.id),
          eq(computerUseAuthorizationRequests.userId, scope.userId),
          eq(computerUseAuthorizationRequests.orgId, scope.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row?.completedAt
      ? row.hostId === hostId
        ? ("applied" as const)
        : ("conflict" as const)
      : null;
  },
);

function continuationEligibility(scope: Scope, hostId: string, now: Date) {
  return and(
    eq(computerUseAuthorizationRequests.id, scope.id),
    eq(computerUseAuthorizationRequests.orgId, scope.orgId),
    eq(computerUseAuthorizationRequests.userId, scope.userId),
    isNull(computerUseAuthorizationRequests.completedAt),
    gt(computerUseAuthorizationRequests.expiresAt, now),
    exists(
      new QueryBuilder()
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, scope.runId),
            eq(agentRuns.triggerSource, "web"),
            inArray(agentRuns.status, [
              "completed",
              "failed",
              "cancelled",
              "timeout",
            ]),
          ),
        ),
    ),
    not(chatBusy(scope)),
    not(superseded(scope)),
    exists(
      new QueryBuilder()
        .select({ id: computerUseHosts.id })
        .from(computerUseHosts)
        .where(
          and(
            eq(computerUseHosts.id, hostId),
            eq(computerUseHosts.orgId, scope.orgId),
            eq(computerUseHosts.userId, scope.userId),
            eq(computerUseHosts.status, "online"),
            isNull(computerUseHosts.revokedAt),
          ),
        ),
    ),
  );
}

function continuationInput(
  scope: Scope,
  model: ChatInputModelSelection,
  createdAt: Date,
): PreparedChatEventRow {
  return {
    id: scope.id,
    chatThreadId: scope.chatThreadId,
    eventType: "input.prompt",
    runId: null,
    contextType: "web",
    contextId: webChatContextId(),
    payload: {
      userMessage: {
        version: 1,
        parts: [
          {
            type: "text",
            text: "Computer Use was authorized for this chat's selected computer. Recheck access and continue the previous task. Do not replay uncertain input.",
          },
        ],
      },
    },
    modelSelection: model,
    createdAt,
  };
}

export const applyComputerUseContinuation$ = command(
  async (
    { set },
    scope: Scope,
    context: Context,
    hostId: string,
    signal: AbortSignal,
  ) => {
    const completed = await set(completedContinuation$, scope, hostId, signal);
    if (completed === "applied") {
      return { status: "applied" as const, enqueued: false };
    }
    if (completed === "conflict") {
      return { status: "conflict" as const, enqueued: false };
    }
    if (context.blockedReason) {
      return { status: "conflict" as const, enqueued: false };
    }
    const model = await set(
      resolveChatInputModelSelection$,
      {
        orgId: scope.orgId,
        userId: scope.userId,
        ...context.thread,
        modelSettings: modelSettingsSchema.parse(context.thread.modelSettings),
      },
      signal,
    );
    if ("status" in model) {
      return {
        status: "model_unavailable" as const,
        message: model.body.error.message,
        enqueued: false,
      };
    }
    const now = nowDate();
    const db = set(writeDb$);
    const eligible = continuationEligibility(scope, hostId, now);
    const pending = db
      .select({ id: computerUseAuthorizationRequests.id })
      .from(computerUseAuthorizationRequests)
      .where(eligible);
    const input = canonicalChatEventInputCtes(
      [continuationInput(scope, model, now)],
      sql`EXISTS (${pending})`,
      context.lastSeqId,
    );
    const updatedThread = db
      .update(chatThreads)
      .set({
        computerUseHostId: hostId,
        cloudBrowserEnabled: false,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatThreads.id, scope.chatThreadId),
          eq(chatThreads.userId, scope.userId),
          eq(chatThreads.agentId, context.thread.agentId),
          sql`${chatThreads}.xmin::text = ${context.thread.rowVersion}`,
          sql`EXISTS (SELECT 1 FROM reserved)`,
        ),
      )
      .returning({ id: chatThreads.id });
    const inserted = canonicalChatEventInsertSql("id", {
      eligibility: sql`EXISTS (SELECT 1 FROM updated_thread)`,
    });
    const complete = db
      .update(computerUseAuthorizationRequests)
      .set({ completedAt: now, updatedAt: now })
      .where(
        and(
          eq(computerUseAuthorizationRequests.id, scope.id),
          isNull(computerUseAuthorizationRequests.completedAt),
          sql`EXISTS (SELECT 1 FROM inserted)`,
        ),
      )
      .returning({ id: computerUseAuthorizationRequests.id });
    const listEvent = chatThreadEventInsertPlan(
      {
        kind: "computer_use_host_updated",
        eventId: scope.id,
        orgId: scope.orgId,
        userId: scope.userId,
        agentId: context.thread.agentId,
        chatThreadId: scope.chatThreadId,
        computerUseHostId: hostId,
        cloudBrowserEnabled: false,
        createdAt: now,
      },
      {
        gate: sql`EXISTS (SELECT 1 FROM completed_request)`,
        agentId: sql`${context.thread.agentId}::uuid`,
        reservationSource: sql`${sql.identifier("host_event_sequence")}`,
      },
    );
    const queue = queuedChatThreadEnqueuePlan({
      chatThreadId: scope.chatThreadId,
      orgId: scope.orgId,
    });
    // Both sequence domains, the host selection, completion, input and queue
    // publication share one commit. The event watermark yields to newer input.
    const [result] = parseRawRows(
      object({ applied: boolean() }),
      await db.execute(sql`
    WITH ${input}, updated_thread AS (${updatedThread.getSQL()}),
    inserted AS (${inserted}), completed_request AS (${complete.getSQL()}),
    host_event_sequence AS (${listEvent.reservation}), host_event AS (${listEvent.insertion}),
    enqueued AS (
      INSERT INTO ${queuedChatThreads} (chat_thread_id, org_id, queued_at)
      SELECT ${scope.chatThreadId}::uuid, ${scope.orgId}, ${queue.values.queuedAt.toISOString()}::timestamp FROM completed_request
      ON CONFLICT (chat_thread_id) DO UPDATE SET queued_at = greatest(EXCLUDED.queued_at, ${queuedChatThreads.queuedAt} + interval '1 millisecond')
    ) SELECT EXISTS (SELECT 1 FROM completed_request) AS applied
  `),
    );
    signal.throwIfAborted();
    if (!result) {
      throw new Error("Computer Use continuation returned no outcome");
    }
    if (result.applied) {
      return { status: "applied" as const, enqueued: true };
    }
    const replay = await set(completedContinuation$, scope, hostId, signal);
    return replay === "applied"
      ? { status: "applied" as const, enqueued: false }
      : { status: "conflict" as const, enqueued: false };
  },
);
