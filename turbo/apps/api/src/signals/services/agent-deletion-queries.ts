import { agentDeletionError } from "@okouai/core/agent-protection";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { conversations } from "@okouai/db/schema/conversation";
import { blobs } from "@okouai/db/schema/blob";
import { storages } from "@okouai/db/schema/storage";
import { workflows } from "@okouai/db/schema/workflow";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatEventSequences } from "@okouai/db/schema/chat-event-sequence";
import {
  getInstructionsStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { and, asc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { z } from "zod";

import { requireAgentPermission } from "../../lib/require-agent-permission";
import { safeSqlStateCode } from "../../lib/pg-errors";

export interface DeleteAgentArgs {
  readonly agentId: string;
  readonly orgId: string;
  readonly member: { readonly userId: string; readonly role: string };
}
const agentRows = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    owner: z.string(),
    visibility: z.enum(["public", "private"]),
  }),
);
const orgRows = z.array(z.object({ defaultAgentId: z.string().nullable() }));
const sessionRows = z.array(z.object({ id: z.string(), orgId: z.string() }));
const runRows = z.array(
  z.object({ id: z.string(), orgId: z.string(), status: z.string() }),
);
interface AdmissionStatement {
  readonly sql: SQL;
  readonly rowSchema: z.ZodType;
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
      readonly agentName: string;
      readonly runIds: readonly string[];
    };
type AdmissionPlan<T> = Generator<AdmissionStatement, T, readonly unknown[]>;
function statement(query: SQL, rowSchema: z.ZodType): AdmissionStatement {
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
export function agentInstructionDeletionCondition(
  instructions: readonly { readonly id: string }[],
) {
  return inArray(
    storages.id,
    instructions.map((storage) => {
      return storage.id;
    }),
  );
}
function agentSnapshotSql(args: DeleteAgentArgs, lock = false) {
  const query = new QueryBuilder()
    .select({
      id: agents.id,
      name: agents.name,
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
  agent: z.output<typeof agentRows>[number],
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
): AdmissionPlan<z.output<typeof agentRows>[number] | AdmissionFailure> {
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
  const sessions = sessionRows.parse(
    yield statement(
      new QueryBuilder()
        .select({
          id: agentSessions.id,
          orgId: sql`${agentSessions.orgId}`.as("orgId"),
        })
        .from(agentSessions)
        .where(eq(agentSessions.agentId, args.agentId))
        .orderBy(asc(agentSessions.id))
        .for("update", { noWait: true })
        .getSQL(),
      sessionRows.element,
    ),
  );
  if (
    sessions.some((session) => {
      return session.orgId !== args.orgId;
    })
  ) {
    return { kind: "ownership-conflict" };
  }
  const targetSessions = new QueryBuilder()
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.agentId, args.agentId));
  const runs =
    sessions.length === 0
      ? []
      : runRows.parse(
          yield statement(
            new QueryBuilder()
              .select({
                id: agentRuns.id,
                orgId: sql`${agentRuns.orgId}`.as("orgId"),
                status: agentRuns.status,
              })
              .from(agentRuns)
              .where(inArray(agentRuns.sessionId, targetSessions))
              .orderBy(asc(agentRuns.id))
              .for("update", { noWait: true })
              .getSQL(),
            runRows.element,
          ),
        );
  if (
    runs.some((run) => {
      return run.orgId !== args.orgId;
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
    agentName: agent.name,
    runIds: runs.map((run) => {
      return run.id;
    }),
  };
}

export const deletedInstructionStorageSchema = z.object({
  id: z.string(),
  s3Prefix: z.string(),
});
export function agentInstructionStoragesSql(orgId: string, agentName: string) {
  return new QueryBuilder()
    .select({
      id: storages.id,
      s3Prefix: sql`${storages.s3Prefix}`.as("s3Prefix"),
    })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, getInstructionsStorageName(agentName)),
      ),
    )
    .orderBy(asc(storages.id))
    .for("update")
    .getSQL();
}
export function agentConversationDeletionCondition(runIds: readonly string[]) {
  return eq(conversations.runId, sql`ANY(${sql.param(runIds)}::uuid[])`);
}
export function deletedConversationReferences(
  groups: readonly {
    readonly hash: string | null;
    readonly references: number;
  }[],
) {
  const references = new Map<string, number>();
  let deletedConversations = 0;
  for (const group of groups) {
    deletedConversations += group.references;
    if (group.hash !== null) {
      references.set(
        group.hash,
        (references.get(group.hash) ?? 0) + group.references,
      );
    }
  }
  return { references, deletedConversations };
}
export function conversationReferenceBatches(
  removed: ReturnType<typeof deletedConversationReferences>,
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
      deletedConversations: removed.deletedConversations,
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
