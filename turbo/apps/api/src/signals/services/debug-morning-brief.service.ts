import type { DebugMorningBriefResponse } from "@okouai/api-contracts/contracts/debug-morning-brief";
import { isMorningBriefDefinitionName } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { agents } from "@okouai/db/schema/agent";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { workflows } from "@okouai/db/schema/workflow";
import { command, computed, state, type Computed } from "ccstate";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { conflict } from "../../lib/error";
import { now, nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { canonicalChatEventAppendCtes } from "./chat-event-append.service";
import { resolveEnqueuedChatInputModel$ } from "./chat-input-model.service";
import {
  loadMorningBriefDefaultAgentId$,
  loadMorningBriefState$,
} from "./morning-brief-state.service";
import { selectDueMorningBriefWorkflow$ } from "./morning-brief-workflow-selection.service";
import { observedWorkflowAutomationCondition } from "./workflow-automation-snapshot";
import { workflowAutomationQueueEventPlan } from "./workflow-automation-enqueue.service";
import {
  persistedWorkflowAutomationEventPayload,
  workflowAutomationDisplayMessage,
  type WorkflowAutomationContext,
} from "./workflow-automation-context.service";
import { ensureWorkflowUserAutomationThread$ } from "./workflow-user-automation-thread.service";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}

function createDebugMorningBriefReceipt(
  owner$: Computed<Owner>,
  requestId$: Computed<string | Promise<string>>,
) {
  const receiptRevision$ = state(0);
  const receipt$ = computed(
    async (get): Promise<DebugMorningBriefResponse | null> => {
      get(receiptRevision$);
      const owner = get(owner$);
      const requestId = await get(requestId$);
      const revoker = alias(chatEvents, "debug_brief_revoker");
      const [row] = await get(db$)
        .select({
          chatThreadId: chatThreads.id,
          runId: chatEvents.runId,
          runStatus: agentRuns.status,
          eventType: chatEvents.eventType,
          revokedBy: revoker.id,
        })
        .from(chatAutomationContext)
        .innerJoin(
          chatThreads,
          eq(chatThreads.id, chatAutomationContext.chatThreadId),
        )
        .innerJoin(agents, eq(agents.id, chatThreads.agentId))
        .innerJoin(
          chatEvents,
          and(
            eq(chatEvents.contextId, chatAutomationContext.id),
            eq(chatEvents.contextType, "automation"),
            inArray(chatEvents.eventType, [
              "input.automation",
              "input.prompt",
              "input.rejected",
            ]),
          ),
        )
        .leftJoin(agentRuns, eq(agentRuns.id, chatEvents.runId))
        .leftJoin(revoker, eq(revoker.revokesEventId, chatEvents.id))
        .where(
          and(
            eq(chatAutomationContext.id, requestId),
            eq(chatAutomationContext.eventType, "morning-brief-debug"),
            eq(chatThreads.userId, owner.userId),
            eq(agents.orgId, owner.orgId),
            or(eq(agents.visibility, "public"), eq(agents.owner, owner.userId)),
          ),
        )
        .orderBy(desc(chatEvents.seqId))
        .limit(1);
      if (!row) {
        return null;
      }
      const status =
        row.eventType === "input.rejected" ||
        (row.runId === null && row.revokedBy !== null)
          ? "failed"
          : row.runStatus === "completed"
            ? "completed"
            : row.runStatus === "failed" ||
                row.runStatus === "cancelled" ||
                row.runStatus === "timeout"
              ? "failed"
              : row.runId === null ||
                  row.runStatus === "pending" ||
                  row.runStatus === "queued"
                ? "queued"
                : "running";
      return {
        requestId,
        chatThreadId: row.chatThreadId,
        runId: row.runId,
        status,
      };
    },
  );

  const reload$ = command(({ set }) => {
    set(receiptRevision$, (value) => {
      return value + 1;
    });
  });
  return { receipt$, reload$ };
}

function debugMorningBriefPlan(args: {
  readonly requestId: string;
  readonly automation: Parameters<
    typeof workflowAutomationQueueEventPlan
  >[0]["automation"];
  readonly workflowName: string;
  readonly chatThreadId: string;
  readonly displayName: string | null;
  readonly modelSelection: Parameters<
    typeof workflowAutomationQueueEventPlan
  >[0]["modelSelection"];
  readonly currentTime: Date;
}) {
  const automationContext: WorkflowAutomationContext = {
    workflowName: args.workflowName,
    eventType: "morning-brief-debug",
    trigger: `one-off Morning Brief requested from Debug at ${args.currentTime.toISOString()}.`,
    event: {
      automationId: args.automation.id,
      trigger: "morning-brief-debug",
      requestedAt: args.currentTime.toISOString(),
    },
  };
  return workflowAutomationQueueEventPlan({
    automation: args.automation,
    chatThreadId: args.chatThreadId,
    queueEventId: args.requestId,
    workflowName: args.workflowName,
    displayName: args.displayName,
    displayPrompt: workflowAutomationDisplayMessage(automationContext),
    workflowAutomationEventType: automationContext.eventType,
    workflowAutomationEventPayload: persistedWorkflowAutomationEventPayload(
      automationContext.event,
    ),
    modelSelection: args.modelSelection,
    triggerBrief: "Requested from Debug",
  });
}

const prepareDebugMorningBrief$ = command(
  async (
    { get, set },
    owner: Owner,
    requestId: string,
    signal: AbortSignal,
  ) => {
    const state = await set(loadMorningBriefState$, owner, signal);
    const defaultAgentId = await set(
      loadMorningBriefDefaultAgentId$,
      owner,
      signal,
    );
    signal.throwIfAborted();
    if (
      state.kind !== "installed" ||
      !state.automation.enabled ||
      state.installation.agentId !== defaultAgentId
    ) {
      return {
        kind: "error" as const,
        response: conflict(
          "Enable Morning Brief for Okou in Preferences before running it from Debug.",
        ),
      };
    }
    // An in-flight scheduled occurrence owns the empty slot and its captured
    // definition. Do not switch that installation or interfere with its callback.
    if (state.automation.nextRunAt === null) {
      return {
        kind: "error" as const,
        response: conflict(
          "A scheduled Morning Brief is already in progress. Try again after it finishes.",
        ),
      };
    }
    const [target] = await get(db$)
      .select({
        automation: workflowAutomationColumns(),
        name: workflows.name,
        displayName: workflows.displayName,
      })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
      .where(
        and(
          eq(workflowAutomations.id, state.automation.id),
          eq(workflowAutomations.orgId, owner.orgId),
          eq(workflowAutomations.ownerUserId, owner.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!target || !isMorningBriefDefinitionName(target.name)) {
      return {
        kind: "error" as const,
        response: conflict("Morning Brief changed. Retry the request."),
      };
    }
    const selected = await set(
      selectDueMorningBriefWorkflow$,
      {
        automation: target.automation,
        agentId: state.installation.agentId,
        workflowName: target.name,
      },
      signal,
    );
    if (!selected) {
      return {
        kind: "error" as const,
        response: conflict(
          "Morning Brief is not ready. Retry after its workflow is synchronized.",
        ),
      };
    }
    const currentTime = nowDate();
    const chatThreadId = await set(
      ensureWorkflowUserAutomationThread$,
      {
        ...owner,
        workflowId: state.installation.id,
        agentId: state.installation.agentId,
        workflowTitle: target.displayName ?? "Morning Brief",
        currentTime,
      },
      signal,
    );
    const model = await set(
      resolveEnqueuedChatInputModel$,
      {
        threadId: chatThreadId,
        ...owner,
      },
      signal,
    );

    return {
      kind: "prepared" as const,
      owner,
      currentTime,
      automation: selected.automation,
      plan: debugMorningBriefPlan({
        requestId,
        automation: selected.automation,
        workflowName: selected.workflowName,
        chatThreadId,
        displayName: target.displayName,
        modelSelection: model.modelSelection,
        currentTime,
      }),
    };
  },
);

type PreparedDebugMorningBrief = Extract<
  Awaited<ReturnType<typeof prepareDebugMorningBrief$.write>>,
  { readonly kind: "prepared" }
>;

const commitDebugMorningBrief$ = command(
  async ({ set }, args: PreparedDebugMorningBrief, signal: AbortSignal) => {
    const { plan } = args;
    const db = set(writeDb$);
    const eligible = db
      .select({ id: workflowAutomations.id })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
      .where(
        and(
          observedWorkflowAutomationCondition(args.automation),
          eq(workflowAutomations.enabled, true),
          isNotNull(workflowAutomations.nextRunAt),
          eq(workflows.name, plan.context.workflowName),
          eq(workflows.officialInstallationState, "installed"),
        ),
      );
    // The canonical input, source context and queue wake-up are one atomic
    // statement. Only the inserted input owns dependent writes. The daily
    // schedule, last-run fields and user's stored model selection are untouched.
    const inserted = (
      await db.execute(sql`
      WITH ${canonicalChatEventAppendCtes([plan.row], "id", sql`EXISTS (${eligible})`)},
      context AS (
        INSERT INTO ${chatAutomationContext}
          (id, chat_thread_id, automation_id, workflow_name, event_type, event_payload, trigger_brief, created_at)
        SELECT ${plan.row.id}::uuid, ${plan.row.chatThreadId}::uuid, ${args.automation.id}::uuid,
          ${plan.context.workflowName}, ${plan.context.eventType},
          ${JSON.stringify(plan.context.eventPayload)}::jsonb, ${plan.context.triggerBrief},
          ${args.currentTime.toISOString()}::timestamp
        FROM inserted RETURNING id
      ), queued AS (
        INSERT INTO ${queuedChatThreads} (chat_thread_id, org_id, queued_at)
        SELECT ${plan.row.chatThreadId}::uuid, ${args.owner.orgId}, ${args.currentTime.toISOString()}::timestamp
        FROM context
        ON CONFLICT (chat_thread_id) DO UPDATE SET queued_at =
          greatest(EXCLUDED.queued_at, ${queuedChatThreads.queuedAt} + interval '1 millisecond')
        RETURNING chat_thread_id
      ) SELECT chat_thread_id FROM queued
    `)
    ).rowCount;
    signal.throwIfAborted();

    return inserted === 0 ? null : { eventId: plan.row.id, committedAt: now() };
  },
);

/** The canonical input identity doubles as the durable retry receipt. */
export function createDebugMorningBrief(
  owner$: Computed<Owner>,
  requestId$: Computed<string | Promise<string>>,
) {
  const receipt = createDebugMorningBriefReceipt(owner$, requestId$);
  const enqueue$ = command(async ({ get, set }, signal: AbortSignal) => {
    const existing = await get(receipt.receipt$);
    signal.throwIfAborted();
    if (existing) {
      return { kind: "existing" as const, response: existing };
    }
    const owner = get(owner$);
    const requestId = await get(requestId$);
    signal.throwIfAborted();
    const prepared = await set(
      prepareDebugMorningBrief$,
      owner,
      requestId,
      signal,
    );
    if (prepared.kind === "error") {
      return prepared;
    }
    const enqueueCommit = await set(commitDebugMorningBrief$, prepared, signal);
    if (!enqueueCommit) {
      // A UUID loser must re-read its owned winner after SQL arbitration.
      set(receipt.reload$);
      const existing = await get(receipt.receipt$);
      signal.throwIfAborted();
      return existing
        ? { kind: "existing" as const, response: existing }
        : {
            kind: "error" as const,
            response: conflict(
              "Morning Brief changed or this request ID is already in use. Retry the request.",
            ),
          };
    }
    return {
      kind: "enqueued" as const,
      enqueueCommit,
      response: {
        requestId,
        chatThreadId: prepared.plan.row.chatThreadId,
        runId: null,
        status: "queued",
      } satisfies DebugMorningBriefResponse,
    };
  });
  return { receipt$: receipt.receipt$, enqueue$ };
}
