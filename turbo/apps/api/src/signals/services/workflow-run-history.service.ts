import { runStatusSchema } from "@okouai/api-contracts/contracts/runs";
import {
  automationEventTypeSchema,
  type WorkflowRunHistoryEntry,
} from "@okouai/api-contracts/contracts/workflows";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { workflows } from "@okouai/db/schema/workflow";
import { computed } from "ccstate";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { iso, object, uuid, type infer as zInfer } from "zod";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import { safeJsonParse } from "../utils";
import { visibleWorkflowCondition } from "./workflow-visibility";

const PAGE_SIZE = 30;
const positionSchema = object({
  createdAt: iso.datetime({ precision: 6 }),
  id: uuid(),
});
type RunPosition = zInfer<typeof positionSchema>;

export function parseWorkflowRunHistoryCursor(cursor: string) {
  return positionSchema.safeParse(
    safeJsonParse(Buffer.from(cursor, "base64url").toString("utf8")),
  );
}

function historyEntry(
  run: {
    readonly id: string;
    readonly createdAt: Date;
    readonly status: string;
  },
  eventType: string | null,
  chatThreadId: string | null,
): WorkflowRunHistoryEntry {
  const event = automationEventTypeSchema.safeParse(eventType);
  const trigger =
    eventType === "manual" || eventType === "schedule"
      ? eventType
      : eventType === null
        ? null
        : "event";
  return {
    id: run.id,
    createdAt: run.createdAt.toISOString(),
    status: runStatusSchema.parse(run.status),
    trigger,
    eventType: event.success ? event.data : null,
    chatThreadId,
  };
}

export function workflowRunHistory(args: {
  readonly workflowId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly before: RunPosition | undefined;
}) {
  return computed(async (get) => {
    const db = get(db$);
    const page = db
      .select({
        id: agentRuns.id,
        createdAt: agentRuns.createdAt,
        // Keep PostgreSQL's microseconds in the cursor even when the UI uses a Date.
        cursorTime:
          sql`to_char(${agentRuns.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
            .mapWith(pgTextDecoder)
            .as("cursor_time"),
        status: agentRuns.status,
        sourceThreadId: agentRuns.chatThreadId,
        automationId: agentRuns.workflowAutomationId,
      })
      .from(workflowAutomations)
      .innerJoin(
        agentRuns,
        and(
          eq(agentRuns.workflowAutomationId, workflowAutomations.id),
          eq(agentRuns.orgId, args.orgId),
          eq(agentRuns.userId, args.userId),
        ),
      )
      .where(
        and(
          eq(workflowAutomations.workflowId, workflows.id),
          eq(workflowAutomations.orgId, args.orgId),
          eq(workflowAutomations.ownerUserId, args.userId),
          inArray(agentRuns.triggerSource, [
            "automation-schedule",
            "automation-event",
          ]),
          args.before
            ? sql`(${agentRuns.createdAt}, ${agentRuns.id}) < (${args.before.createdAt}::timestamp, ${args.before.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
      .limit(PAGE_SIZE + 1)
      .as("workflow_run_page");
    const trigger = db
      .select({ eventType: chatAutomationContext.eventType })
      .from(chatEvents)
      .innerJoin(
        chatAutomationContext,
        and(
          eq(chatAutomationContext.id, chatEvents.contextId),
          eq(chatAutomationContext.chatThreadId, page.sourceThreadId),
          eq(chatAutomationContext.automationId, page.automationId),
        ),
      )
      .where(
        and(
          eq(chatEvents.chatThreadId, page.sourceThreadId),
          eq(chatEvents.runId, page.id),
          eq(chatEvents.eventType, "input.prompt"),
          eq(chatEvents.contextType, "automation"),
        ),
      )
      .orderBy(asc(chatEvents.seqId))
      .limit(1)
      .as("workflow_run_trigger");
    const rows = await db
      .select({
        run: {
          id: page.id,
          createdAt: page.createdAt,
          cursorTime: page.cursorTime,
          status: page.status,
        },
        chatThreadId: chatThreads.id,
        eventType: trigger.eventType,
      })
      .from(workflows)
      .leftJoinLateral(page, sql`true`)
      .leftJoin(
        chatThreads,
        and(
          eq(chatThreads.id, page.sourceThreadId),
          eq(chatThreads.orgId, args.orgId),
          eq(chatThreads.userId, args.userId),
          eq(chatThreads.hidden, false),
        ),
      )
      .leftJoinLateral(trigger, sql`true`)
      .where(
        and(
          eq(workflows.id, args.workflowId),
          eq(workflows.orgId, args.orgId),
          visibleWorkflowCondition(args.userId),
        ),
      )
      .orderBy(desc(page.createdAt), desc(page.id));
    if (rows.length === 0) {
      return null;
    }

    const lastRun = rows[PAGE_SIZE - 1]?.run;
    const nextCursor =
      rows.length > PAGE_SIZE && lastRun
        ? Buffer.from(
            JSON.stringify({ createdAt: lastRun.cursorTime, id: lastRun.id }),
          ).toString("base64url")
        : null;
    const runs = rows
      .slice(0, PAGE_SIZE)
      .flatMap(({ run, chatThreadId, eventType }) => {
        return run ? [historyEntry(run, eventType, chatThreadId)] : [];
      });
    return { runs, nextCursor };
  });
}
