import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, isNotNull, lte, ne, sql, type SQLWrapper } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";

const precedingRun = alias(agentRuns, "finalizing_preceding_run");

interface PreviousChatRunInput {
  readonly runId: SQLWrapper;
  readonly chatThreadId: SQLWrapper;
  readonly userId: SQLWrapper;
  readonly orgId: SQLWrapper;
  readonly createdAt: SQLWrapper;
}

/** Identity precedes resource/native eligibility; never backtrack to a compatible Run. */
export function previousChatRunPlan(args: PreviousChatRunInput) {
  return {
    fields: { id: precedingRun.id },
    table: precedingRun,
    where: and(
      isNotNull(precedingRun.chatThreadId),
      eq(precedingRun.chatThreadId, args.chatThreadId),
      eq(precedingRun.userId, args.userId),
      eq(precedingRun.orgId, args.orgId),
      ne(precedingRun.id, args.runId),
      isNotNull(precedingRun.startedAt),
      // Creation and claims use different clocks. Keep the admission bound
      // in its API-clock domain, independently of execution ordering.
      lte(precedingRun.createdAt, args.createdAt),
    ),
    orderBy: [
      sql`${precedingRun.startedAt} DESC NULLS LAST`,
      sql`${precedingRun.createdAt} DESC NULLS LAST`,
      sql`${precedingRun.id} DESC NULLS LAST`,
    ],
  };
}

export function previousChatRunId(args: PreviousChatRunInput) {
  const plan = previousChatRunPlan(args);
  return sql`(${new QueryBuilder()
    .select(plan.fields)
    .from(plan.table)
    .where(plan.where)
    .orderBy(...plan.orderBy)
    .limit(1)})`;
}
