import {
  runStatusSchema,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import {
  assertErasureSubjectWritable,
  type ErasureSubject,
} from "@okouai/db/operations/account-erasure";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { storages } from "@okouai/db/schema/storage";
import { asc, eq, inArray, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";
import { settle } from "../utils";
import { lockChatQueueThread } from "./chat-event-queue.service";

interface Owner {
  readonly userId: string;
  readonly orgId: string;
}

export class AgentEventRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is missing during output materialization`);
    this.name = "AgentEventRunNotFoundError";
  }
}

export class RunContentOwnershipChangedError extends Error {
  constructor(message = "Prepared run content ownership no longer matches") {
    super(message);
  }
}

class ContentOwnershipRaceError extends RunContentOwnershipChangedError {
  constructor() {
    super("Run content ownership changed while acquiring locks");
  }
}

type ContentDeadlineProfile = "activity";

async function setContentDeadlines(
  tx: Tx,
  profile?: ContentDeadlineProfile,
): Promise<void> {
  const lockTimeout = profile === "activity" ? "250ms" : "1s";
  const statementTimeout = profile === "activity" ? "3s" : "5s";
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${lockTimeout}, true)`,
  );
  await tx.execute(
    sql`SELECT set_config('statement_timeout', ${statementTimeout}, true)`,
  );
}

async function readOwnership(tx: Tx, runId: string) {
  const [run] = await tx
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      sessionId: agentRuns.sessionId,
      chatThreadId: agentRuns.chatThreadId,
      triggerSource: agentRuns.triggerSource,
      storageMounts: agentRuns.storageMounts,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  if (!run) {
    throw new AgentEventRunNotFoundError(runId);
  }
  const [session] = await tx
    .select({
      userId: agentSessions.userId,
      orgId: agentSessions.orgId,
      agentId: agentSessions.agentId,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, run.sessionId));
  if (!session) {
    throw new Error("Run content session is missing");
  }
  const [thread] = run.chatThreadId
    ? await tx
        .select({
          chatThreadId: chatThreads.id,
          userId: chatThreads.userId,
          agentId: chatThreads.agentId,
        })
        .from(chatThreads)
        .where(eq(chatThreads.id, run.chatThreadId))
    : [];
  if (run.chatThreadId && !thread) {
    throw new ContentOwnershipRaceError();
  }
  const agentIds = [...new Set([session.agentId, thread?.agentId])].filter(
    (id): id is string => {
      return id !== null && id !== undefined;
    },
  );
  const resources = agentIds.length
    ? await tx
        .select({ id: agents.id, userId: agents.owner, orgId: agents.orgId })
        .from(agents)
        .where(inArray(agents.id, agentIds))
        .orderBy(asc(agents.id))
    : [];
  if (resources.length !== agentIds.length) {
    throw new ContentOwnershipRaceError();
  }
  // The run's retained mount survives job completion and lease retirement.
  // Content admission must not require a current compute-maintenance lease.
  const memoryMount =
    session.agentId === null
      ? run.storageMounts?.find((mount) => {
          return mount.name === "memory" && mount.writeback === true;
        })
      : undefined;
  const [storage] = memoryMount
    ? await tx
        .select({
          id: storages.id,
          userId: storages.userId,
          orgId: storages.orgId,
        })
        .from(storages)
        .where(eq(storages.id, memoryMount.storageId))
    : [];
  if (session.agentId === null && (!memoryMount || !storage)) {
    throw new Error(
      "Private run content requires its retained memory resource",
    );
  }
  return Object.freeze({
    runId,
    userId: run.userId,
    orgId: run.orgId,
    sessionId: run.sessionId,
    triggerSource: run.triggerSource,
    thread: thread ? Object.freeze(thread) : null,
    session: Object.freeze(session),
    resources: Object.freeze(
      resources.map((resource) => {
        return Object.freeze(resource);
      }),
    ),
    memory:
      memoryMount && storage
        ? Object.freeze({
            mount: Object.freeze({
              id: memoryMount.storageId,
              userId: memoryMount.userId,
              orgId: memoryMount.orgId,
            }),
            storage: Object.freeze(storage),
          })
        : null,
  });
}

export type RunContentOwnership = Awaited<ReturnType<typeof readOwnership>>;

/** Capture before asynchronous history preparation; this grants no admission. */
export async function readRunContentOwnership(
  db: Db,
  runId: string,
  deadlineProfile?: ContentDeadlineProfile,
): Promise<RunContentOwnership> {
  return await db.transaction(
    async (tx) => {
      await setContentDeadlines(tx, deadlineProfile);
      return await readOwnership(tx, runId);
    },
    { isolationLevel: "read committed" },
  );
}

/** Preserve timeout disposition before potentially remote history preparation.
 * The actual writer rechecks status under the run lock after preparation.
 */
export async function prepareRunOutputOwnership(
  db: Db,
  runId: string,
): Promise<RunContentOwnership | undefined> {
  return await db.transaction(
    async (tx) => {
      await setContentDeadlines(tx);
      const [run] = await tx
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId));
      if (!run) {
        throw new AgentEventRunNotFoundError(runId);
      }
      if (run.status === "timeout") {
        return undefined;
      }
      return await readOwnership(tx, runId);
    },
    { isolationLevel: "read committed" },
  );
}

function sameOwner(left: Owner, right: Owner): boolean {
  return left.userId === right.userId && left.orgId === right.orgId;
}

async function admitSubjects(
  tx: Tx,
  snapshot: RunContentOwnership,
): Promise<boolean> {
  const owners: Owner[] = [snapshot, snapshot.session, ...snapshot.resources];
  if (snapshot.memory) {
    owners.push(snapshot.memory.mount, snapshot.memory.storage);
  }
  const subjects: ErasureSubject[] = owners.flatMap((owner) => {
    return [
      { subjectKind: "user" as const, subjectId: owner.userId },
      { subjectKind: "organization" as const, subjectId: owner.orgId },
    ];
  });
  if (snapshot.thread) {
    subjects.push({ subjectKind: "user", subjectId: snapshot.thread.userId });
  }
  const distinct = [
    ...new Map(
      subjects.map((subject) => {
        return [JSON.stringify(subject), subject];
      }),
    ).values(),
  ];
  const result = await settle(assertErasureSubjectWritable(tx, distinct));
  if (result.ok) {
    return true;
  }
  if (
    result.error instanceof Error &&
    result.error.message === "account_erasure:subject_closed"
  ) {
    return false;
  }
  throw result.error;
}

async function lockOwnership(
  tx: Tx,
  snapshot: RunContentOwnership,
): Promise<{
  readonly status: RunStatus;
  readonly modelProvider: string | null;
}> {
  // Resource composite keys include owner/org. KEY SHARE prevents transfer or
  // deletion without serializing unrelated non-identity resource updates.
  for (const resource of snapshot.resources) {
    await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, resource.id))
      .for("key share");
  }
  if (snapshot.memory) {
    await tx
      .select({ id: storages.id })
      .from(storages)
      .where(eq(storages.id, snapshot.memory.storage.id))
      .for("key share");
  }
  const lockKey = `run_output_projection:${snapshot.runId}`;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
  if (snapshot.thread) {
    await lockChatQueueThread(tx, snapshot.thread.chatThreadId);
  }
  const [run] = await tx
    .select({
      status: agentRuns.status,
      modelProvider: agentRuns.modelProvider,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, snapshot.runId))
    .for("update");
  if (!run) {
    throw new AgentEventRunNotFoundError(snapshot.runId);
  }
  await tx
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.id, snapshot.sessionId))
    .for("update");
  const current = await readOwnership(tx, snapshot.runId);
  if (JSON.stringify(current) !== JSON.stringify(snapshot)) {
    // Roll back before discovering/acquiring any additional subject locks.
    throw new ContentOwnershipRaceError();
  }
  return {
    status: runStatusSchema.parse(run.status),
    modelProvider: run.modelProvider,
  };
}

/** Owns the actual transaction: subjects -> resources -> output -> thread ->
 * run -> session, with revalidation and the barrier retained through COMMIT.
 */
export async function withRunContentWrite<T>(
  db: Db,
  args: {
    readonly runId: string;
    readonly runOwner?: Owner;
    readonly destination?: Owner & { readonly threadId: string };
    readonly ownership: RunContentOwnership;
    readonly deadlineProfile?: ContentDeadlineProfile;
  },
  write: (
    tx: Tx,
    ownership: RunContentOwnership,
    status: RunStatus,
    modelProvider: string | null,
  ) => Promise<T>,
  signal: AbortSignal,
): Promise<
  | {
      readonly outcome: "written";
      readonly value: T;
      readonly ownership: RunContentOwnership;
    }
  | { readonly outcome: "closed" }
> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const result = await settle(
      db.transaction(
        async (tx) => {
          await setContentDeadlines(tx, args.deadlineProfile);
          const snapshot = await readOwnership(tx, args.runId);
          if (!(await admitSubjects(tx, snapshot))) {
            return { outcome: "closed" as const };
          }
          const run = await lockOwnership(tx, snapshot);
          signal.throwIfAborted();
          if (
            JSON.stringify(snapshot) !== JSON.stringify(args.ownership) ||
            (args.runOwner && !sameOwner(snapshot, args.runOwner)) ||
            (args.destination &&
              (snapshot.thread?.chatThreadId !== args.destination.threadId ||
                snapshot.thread.userId !== args.destination.userId ||
                snapshot.orgId !== args.destination.orgId)) ||
            (snapshot.memory &&
              (!sameOwner(snapshot, snapshot.memory.mount) ||
                !sameOwner(snapshot, snapshot.memory.storage)))
          ) {
            throw new RunContentOwnershipChangedError();
          }
          const value = await write(
            tx,
            snapshot,
            run.status,
            run.modelProvider,
          );
          signal.throwIfAborted();
          return { outcome: "written" as const, value, ownership: snapshot };
        },
        { isolationLevel: "read committed" },
      ),
    );
    signal.throwIfAborted();
    if (result.ok) {
      return result.value;
    }
    if (!(result.error instanceof ContentOwnershipRaceError) || attempt === 2) {
      throw result.error;
    }
  }
}
