import { agentDeletionError } from "@okouai/core/agent-protection";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunDeletionMembership } from "@okouai/db/operations/run-history-deletion";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { blobs } from "@okouai/db/schema/blob";
import { workflows } from "@okouai/db/schema/workflow";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatEventSequences } from "@okouai/db/schema/chat-event-sequence";
import { and, asc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  array,
  object,
  string,
  enum as zEnum,
  type output,
  type ZodType,
} from "zod";

import { requireAgentPermission } from "../../lib/require-agent-permission";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { deletedRunHistoryReferences } from "./conversation-history-deletion.service";

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
export function agentDeletionAutomationCondition(args: DeleteAgentArgs) {
  return and(
    eq(workflows.orgId, args.orgId),
    eq(workflows.agentId, args.agentId),
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
      return run.status === "pending" || run.status === "running";
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

export function conversationReferenceBatches(
  removed: ReturnType<typeof deletedRunHistoryReferences>,
) {
  const references = [...removed.references]
    .sort(([a], [b]) => {
      return a.localeCompare(b);
    })
    .map(([hash, references]) => {
      return { hash, release_count: references };
    });
  const batches: (typeof references)[] = [];
  for (let offset = 0; offset < references.length; offset += 500) {
    batches.push(references.slice(offset, offset + 500));
  }
  return {
    batches,
    receipt: {
      deletedRuns: removed.deletedRuns,
      releasedReferences: references.reduce((total, entry) => {
        return total + entry.release_count;
      }, 0),
      releasedHashes: references.length,
    },
  };
}
type ReferenceBatch = ReturnType<
  typeof conversationReferenceBatches
>["batches"][number];
export function conversationBlobLockCondition(batch: ReferenceBatch) {
  return inArray(
    blobs.hash,
    batch.map((entry) => {
      return entry.hash;
    }),
  );
}
export function conversationBlobReleaseValues(batch: ReferenceBatch) {
  return {
    values: { refCount: sql`${blobs.refCount} - removed.release_count` },
    from: sql`jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS removed(hash text, release_count integer)`,
    where: and(
      eq(blobs.hash, sql`removed.hash`),
      gte(blobs.refCount, sql`removed.release_count`),
    ),
  };
}
export function conversationDeletionDatabaseError(error: unknown) {
  return new Error("Conversation history deletion database operation failed", {
    cause: { code: safeSqlStateCode(error) },
  });
}
