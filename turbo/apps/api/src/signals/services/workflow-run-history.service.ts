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
import { archivedProactiveWorkflowRuns } from "@okouai/db/schema/archived-proactive-workflow-run";
import { computed } from "ccstate";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { iso, object, uuid, type infer as zInfer } from "zod";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import { safeJsonParse } from "../utils";
import {
  readableWorkflows,
  visibleWorkflowCondition,
} from "./workflow-visibility";

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

interface WorkflowHistoryArgs {
  readonly workflowId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly before: RunPosition | undefined;
}

function workflowRunPage(args: WorkflowHistoryArgs) {
  const query = new QueryBuilder();
  // Resolve the immutable trigger ID from the original FK or the archive inside the
  // same snapshot. Keep workspace/user ownership and microsecond cursor semantics.
  const runFields = {
    id: agentRuns.id,
    createdAt: agentRuns.createdAt,
    cursorTime:
      sql`to_char(${agentRuns.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
        .mapWith(pgTextDecoder)
        .as("cursor_time"),
    status: agentRuns.status,
    sourceThreadId: agentRuns.chatThreadId,
  };
  const ownedRun = and(
    eq(agentRuns.orgId, args.orgId),
    eq(agentRuns.userId, args.userId),
    inArray(agentRuns.triggerSource, [
      "automation-schedule",
      "automation-event",
    ]),
    args.before
      ? sql`(${agentRuns.createdAt}, ${agentRuns.id}) < (${args.before.createdAt}::timestamp, ${args.before.id}::uuid)`
      : undefined,
  );
  const links = query
    .select({
      ...runFields,
      automationId: sql`${workflowAutomations.id}`
        .mapWith(pgTextDecoder)
        .as("original_automation_id"),
    })
    .from(workflowAutomations)
    .innerJoin(
      agentRuns,
      eq(agentRuns.workflowAutomationId, workflowAutomations.id),
    )
    .where(
      and(
        eq(workflowAutomations.workflowId, args.workflowId),
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        ownedRun,
      ),
    )
    .unionAll(
      query
        .select({
          ...runFields,
          automationId: archivedProactiveWorkflowRuns.automationId,
        })
        .from(archivedProactiveWorkflowRuns)
        .innerJoin(
          agentRuns,
          eq(agentRuns.id, archivedProactiveWorkflowRuns.runId),
        )
        .where(
          and(
            eq(archivedProactiveWorkflowRuns.workflowId, args.workflowId),
            ownedRun,
          ),
        ),
    )
    .as("workflow_run_links");
  return query
    .select()
    .from(links)
    .orderBy(desc(links.createdAt), desc(links.id))
    .limit(PAGE_SIZE + 1)
    .as("workflow_run_page");
}

export function workflowRunHistory(args: WorkflowHistoryArgs) {
  return computed(async (get) => {
    const db = get(db$);
    const page = workflowRunPage(args);
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
      .from(readableWorkflows)
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
          eq(readableWorkflows.id, args.workflowId),
          eq(readableWorkflows.orgId, args.orgId),
          visibleWorkflowCondition(args.userId, readableWorkflows),
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
