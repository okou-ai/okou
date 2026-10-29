import { agentDeletionError } from "@okouai/core/agent-protection";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { claimedWorkflowAttachments } from "@okouai/db/schema/claimed-workflow-attachment";
import { agentRunDeletionMembership } from "@okouai/db/operations/run-history-deletion";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  officialWorkflowAutomationIdentities,
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatEventSequences } from "@okouai/db/schema/chat-event-sequence";
import {
  and,
  asc,
  count,
  eq,
  exists,
  gte,
  inArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  boolean as zBoolean,
  array,
  object,
  string,
  enum as zEnum,
  type output,
  type ZodType,
} from "zod";

import { requireAgentPermission } from "../../lib/require-agent-permission";
import { pgBooleanDecoder } from "../../lib/db-structured-result";

export interface DeleteAgentArgs {
  readonly agentId: string;
  readonly orgId: string;
  readonly member: { readonly userId: string; readonly role: string };
}
const agentRows = array(
  object({
    id: string(),
    owner: string(),
    visibility: zEnum(["public", "private"]),
  }),
);
const orgRows = array(object({ defaultAgentId: string().nullable() }));
const runRows = array(
  object({
    id: string(),
    orgId: string(),
    agentId: string().nullable(),
    status: string(),
    workflowAttachmentsRetained: zBoolean(),
  }),
);
interface AdmissionStatement {
  readonly sql: SQL;
  readonly rowSchema: ZodType;
}
type AdmissionFailure =
  | { readonly kind: "missing" }
  | { readonly kind: "ownership-conflict" }
  | { readonly kind: "active-run" }
  | {
      readonly kind: "forbidden";
      readonly response:
        | NonNullable<ReturnType<typeof requireAgentPermission>>
        | {
            readonly status: 400;
            readonly body: {
              readonly error: NonNullable<
                ReturnType<typeof agentDeletionError>
              >;
            };
          };
    };
type AdmissionResult =
  | AdmissionFailure
  | {
      readonly kind: "ready";
      readonly runIds: readonly string[];
    };
type AdmissionPlan<T> = Generator<AdmissionStatement, T, readonly unknown[]>;
function statement(query: SQL, rowSchema: ZodType): AdmissionStatement {
  return { sql: query, rowSchema };
}
export function agentDeletionIdentityCondition(args: {
  readonly agentId: string;
  readonly orgId: string;
}) {
  return and(eq(agents.id, args.agentId), eq(agents.orgId, args.orgId));
}
export function agentDeletionWorkflowCondition(args: DeleteAgentArgs) {
  return and(
    eq(workflows.agentId, args.agentId),
    eq(workflows.orgId, args.orgId),
  );
}
export function agentDeletionAutomationCondition(args: DeleteAgentArgs) {
  return exists(
    new QueryBuilder()
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.id, workflowAutomations.workflowId),
          agentDeletionWorkflowCondition(args),
        ),
      ),
  );
}
export function agentDeletionWorkflowIdentityCondition(args: DeleteAgentArgs) {
  return exists(
    new QueryBuilder()
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.id, officialWorkflowAutomationIdentities.workflowId),
          agentDeletionWorkflowCondition(args),
        ),
      ),
  );
}
export function agentDeletionThreadSequencesSql(agentId: string) {
  return new QueryBuilder()
    .select({ id: chatEventSequences.chatThreadId })
    .from(chatEventSequences)
    .innerJoin(chatThreads, eq(chatThreads.id, chatEventSequences.chatThreadId))
    .where(eq(chatThreads.agentId, agentId))
    .orderBy(asc(chatEventSequences.chatThreadId))
    .for("update", { of: chatEventSequences })
    .getSQL();
}

/** Preserve the thread cascade's SET NULL effects for retained references. */
export function agentDeletionCascadeSql(args: {
  readonly agentId: string;
  readonly orgId: string;
}) {
  const deletedAgentThreads = new QueryBuilder()
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .innerJoin(agents, eq(chatThreads.agentId, agents.id))
    .where(agentDeletionIdentityCondition(args));
  return sql`WITH detached_runs AS (
      UPDATE ${agentRuns}
      SET ${sql.identifier(agentRuns.chatThreadId.name)} = NULL
      WHERE ${inArray(agentRuns.chatThreadId, deletedAgentThreads)}
      RETURNING ${agentRuns.id}
    ), detached_bindings AS (
      UPDATE ${workflowUserAutomationThreads}
      SET ${sql.identifier(workflowUserAutomationThreads.chatThreadId.name)} = NULL
      WHERE ${inArray(workflowUserAutomationThreads.chatThreadId, deletedAgentThreads)}
      RETURNING ${workflowUserAutomationThreads.id}
    )
    DELETE FROM ${agents}
    WHERE ${eq(agents.id, args.agentId)} AND ${eq(agents.orgId, args.orgId)}
      AND ${gte(
        sql`(SELECT ${count()} FROM detached_runs) +
          (SELECT ${count()} FROM detached_bindings)`,
        sql`0`,
      )}`;
}

function agentSnapshotSql(args: DeleteAgentArgs, lock = false) {
  const query = new QueryBuilder()
    .select({
      id: agents.id,
      owner: agents.owner,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(agentDeletionIdentityCondition(args))
    .limit(1);
  return lock ? query.for("update", { noWait: true }).getSQL() : query.getSQL();
}
function orgSnapshotSql(orgId: string) {
  return new QueryBuilder()
    .select({
      defaultAgentId: sql`${orgMetadata.defaultAgentId}`.as("defaultAgentId"),
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .getSQL();
}
function deletionPermission(
  agent: output<typeof agentRows>[number],
  args: DeleteAgentArgs,
): AdmissionFailure | undefined {
  const permission = requireAgentPermission(
    agent.owner,
    args.member,
    "delete agent",
    { visibility: agent.visibility },
  );
  return permission ? { kind: "forbidden", response: permission } : undefined;
}
function* admitAgentIdentity(
  args: DeleteAgentArgs,
  lock: boolean,
): AdmissionPlan<output<typeof agentRows>[number] | AdmissionFailure> {
  const [agent] = agentRows.parse(
    yield statement(agentSnapshotSql(args, lock), agentRows.element),
  );
  if (!agent) {
    return { kind: "missing" };
  }
  const permission = deletionPermission(agent, args);
  if (permission) {
    return permission;
  }
  const [org] = orgRows.parse(
    yield statement(orgSnapshotSql(args.orgId), orgRows.element),
  );
  const identity = agentDeletionError(agent.id === org?.defaultAgentId);
  return identity
    ? {
        kind: "forbidden",
        response: { status: 400, body: { error: identity } },
      }
    : agent;
}
export function* agentDeletionAdmissionPlan(
  args: DeleteAgentArgs,
): AdmissionPlan<AdmissionResult> {
  const preflight = yield* admitAgentIdentity(args, false);
  if ("kind" in preflight) {
    return preflight;
  }
  // Revalidate permission/default identity under the existing Agent NOWAIT lock.
  const agent = yield* admitAgentIdentity(args, true);
  if ("kind" in agent) {
    return agent;
  }
  const runs = runRows.parse(
    yield statement(
      new QueryBuilder()
        .select({
          id: agentRuns.id,
          orgId: sql`${agentRuns.orgId}`.as("orgId"),
          agentId: sql`${agentRuns.agentId}`.as("agentId"),
          status: agentRuns.status,
          workflowAttachmentsRetained: exists(
            new QueryBuilder()
              .select({ id: claimedWorkflowAttachments.runId })
              .from(claimedWorkflowAttachments)
              .where(eq(claimedWorkflowAttachments.runId, agentRuns.id)),
          )
            .mapWith(pgBooleanDecoder)
            .as("workflowAttachmentsRetained"),
        })
        .from(agentRuns)
        .where(agentRunDeletionMembership([args.agentId]))
        .orderBy(asc(agentRuns.id))
        .for("update", { noWait: true })
        .getSQL(),
      runRows.element,
    ),
  );
  if (
    runs.some((run) => {
      return (
        run.orgId !== args.orgId ||
        (run.agentId !== null && run.agentId !== args.agentId)
      );
    })
  ) {
    return { kind: "ownership-conflict" };
  }
  if (
    runs.some((run) => {
      return (
        run.status === "pending" ||
        run.status === "running" ||
        run.workflowAttachmentsRetained
      );
    })
  ) {
    return { kind: "active-run" };
  }
  return {
    kind: "ready",
    runIds: runs.map((run) => {
      return run.id;
    }),
  };
}
