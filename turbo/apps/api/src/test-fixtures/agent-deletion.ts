import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise } from "../signals/utils";

// These fixtures construct transitional and concurrent database states that
// the production API cannot pause or create. Route tests must opt into their
// use explicitly and continue exercising deletion through the real endpoint.

const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.int() });
const lockTimeoutRowSchema = z.object({ lockTimeout: z.string() });

interface HeldDatabaseBoundary {
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}

async function directBlockedWaiterCount(holderPid: number): Promise<number> {
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT ${count()}::int AS "waiterCount"
      FROM pg_stat_activity AS activity
      WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
    `,
    waiterCountRowSchema,
  );
  return rows[0]?.waiterCount ?? 0;
}

async function transactionBackendPid(
  tx: Parameters<typeof executeRawRows>[0],
): Promise<number> {
  const rows = await executeRawRows(
    tx,
    sql`SELECT pg_backend_pid() AS "pid"`,
    databasePidRowSchema,
  );
  const pid = rows[0]?.pid;
  if (!pid) {
    throw new Error("Expected an agent deletion fixture backend pid");
  }
  return pid;
}

function boundaryFromPid(args: {
  readonly pid: number;
  readonly released: ReturnType<typeof createDeferredPromise<void>>;
  readonly done: Promise<void>;
}): HeldDatabaseBoundary {
  return {
    release: () => {
      if (!args.released.settled()) {
        args.released.resolve(undefined);
      }
    },
    done: args.done,
    blockedWaiterCount: async () => {
      return await directBlockedWaiterCount(args.pid);
    },
  };
}

export async function readAgentLifecycleIdsFixture(agentId: string): Promise<{
  readonly sessionIds: readonly string[];
  readonly runIds: readonly string[];
}> {
  const sessions = await db()
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.agentId, agentId))
    .orderBy(asc(agentSessions.id));
  const sessionIds = sessions.map((session) => {
    return session.id;
  });
  const runs =
    sessionIds.length === 0
      ? []
      : await db()
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(inArray(agentRuns.sessionId, sessionIds))
          .orderBy(asc(agentRuns.id));
  return {
    sessionIds,
    runIds: runs.map((run) => {
      return run.id;
    }),
  };
}

export async function readAgentLifecycleCountsFixture(
  agentId: string,
): Promise<{
  readonly agents: number;
  readonly sessions: number;
  readonly runs: number;
}> {
  const [agentCount] = await db()
    .select({ value: count() })
    .from(agents)
    .where(eq(agents.id, agentId));
  const lifecycle = await readAgentLifecycleIdsFixture(agentId);
  return {
    agents: agentCount?.value ?? 0,
    sessions: lifecycle.sessionIds.length,
    runs: lifecycle.runIds.length,
  };
}

export async function setAgentLifecycleOrgFixture(args: {
  readonly kind: "session" | "run";
  readonly id: string;
  readonly orgId: string;
}): Promise<void> {
  const rows =
    args.kind === "session"
      ? await db()
          .update(agentSessions)
          .set({ orgId: args.orgId })
          .where(eq(agentSessions.id, args.id))
          .returning({ id: agentSessions.id })
      : await db()
          .update(agentRuns)
          .set({ orgId: args.orgId })
          .where(eq(agentRuns.id, args.id))
          .returning({ id: agentRuns.id });
  if (rows.length !== 1) {
    throw new Error("Expected one lifecycle org fixture row to change");
  }
}

export async function setAgentRunStatusFixture(
  runId: string,
  status: string,
): Promise<void> {
  const rows = await db()
    .update(agentRuns)
    .set({ status })
    .where(eq(agentRuns.id, runId))
    .returning({ id: agentRuns.id });
  if (rows.length !== 1) {
    throw new Error("Expected one agent Run status to change");
  }
}

export async function holdAgentDeletionRowLockFixture(args: {
  readonly kind: "agent" | "session" | "run";
  readonly id: string;
  readonly signal: AbortSignal;
}): Promise<HeldDatabaseBoundary> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const rows =
      args.kind === "agent"
        ? await tx
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.id, args.id))
            .for("update")
        : args.kind === "session"
          ? await tx
              .select({ id: agentSessions.id })
              .from(agentSessions)
              .where(eq(agentSessions.id, args.id))
              .for("update")
          : await tx
              .select({ id: agentRuns.id })
              .from(agentRuns)
              .where(eq(agentRuns.id, args.id))
              .for("update");
    if (rows.length !== 1) {
      throw new Error(`Expected one ${args.kind} deletion fixture row`);
    }
    started.resolve(await transactionBackendPid(tx));
    await released.promise;
  });
  return boundaryFromPid({
    pid: await started.promise,
    released,
    done,
  });
}

export async function holdAgentRunLocksFixture(args: {
  readonly runIds: readonly string[];
  readonly signal: AbortSignal;
}): Promise<HeldDatabaseBoundary> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    for (const runId of args.runIds) {
      const rows = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .for("update");
      if (rows.length !== 1) {
        throw new Error("Expected a reverse-order Run fixture row");
      }
    }
    started.resolve(await transactionBackendPid(tx));
    await released.promise;
  });
  return boundaryFromPid({
    pid: await started.promise,
    released,
    done,
  });
}

export async function holdAgentSessionInsertFixture(args: {
  readonly agentId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
}): Promise<HeldDatabaseBoundary> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    await tx.insert(agentSessions).values({
      agentId: args.agentId,
      orgId: args.orgId,
      userId: args.userId,
    });
    started.resolve(await transactionBackendPid(tx));
    await released.promise;
  });
  return boundaryFromPid({
    pid: await started.promise,
    released,
    done,
  });
}

export async function holdAgentRunInsertFixture(args: {
  readonly sessionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
}): Promise<HeldDatabaseBoundary> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    await tx.insert(agentRuns).values({
      sessionId: args.sessionId,
      orgId: args.orgId,
      userId: args.userId,
      status: "pending",
      prompt: "held continuation Run insert",
    });
    started.resolve(await transactionBackendPid(tx));
    await released.promise;
  });
  return boundaryFromPid({
    pid: await started.promise,
    released,
    done,
  });
}

export async function holdAgentRunPromotionFixture(args: {
  readonly runId: string;
  readonly signal: AbortSignal;
}): Promise<HeldDatabaseBoundary> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const rows = await tx
      .update(agentRuns)
      .set({ status: "pending" })
      .where(and(eq(agentRuns.id, args.runId), eq(agentRuns.status, "queued")))
      .returning({ id: agentRuns.id });
    if (rows.length !== 1) {
      throw new Error("Expected one queued Run promotion fixture row");
    }
    started.resolve(await transactionBackendPid(tx));
    await released.promise;
  });
  return boundaryFromPid({
    pid: await started.promise,
    released,
    done,
  });
}

export async function holdUsageEventMutationFixture(args: {
  readonly usageEventId: string;
  readonly signal: AbortSignal;
}): Promise<HeldDatabaseBoundary> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const rows = await tx
      .update(usageEvent)
      .set({ billingError: "agent_delete_fixture" })
      .where(eq(usageEvent.id, args.usageEventId))
      .returning({ id: usageEvent.id });
    if (rows.length !== 1) {
      throw new Error("Expected one usage event mutation fixture row");
    }
    started.resolve(await transactionBackendPid(tx));
    await released.promise;
  });
  return boundaryFromPid({
    pid: await started.promise,
    released,
    done,
  });
}

export async function readUsageEventRunIdFixture(
  usageEventId: string,
): Promise<string | null> {
  const [row] = await db()
    .select({ runId: usageEvent.runId })
    .from(usageEvent)
    .where(eq(usageEvent.id, usageEventId))
    .limit(1);
  if (!row) {
    throw new Error("Expected the retained usage event fixture row");
  }
  return row.runId;
}

export async function holdChatThreadThenSessionFixture(args: {
  readonly threadId: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}): Promise<
  {
    readonly startSessionLock: () => void;
    readonly sessionLocked: Promise<void>;
  } & HeldDatabaseBoundary
> {
  const started = createDeferredPromise<number>(args.signal);
  const attemptSession = createDeferredPromise<void>(args.signal);
  const sessionLocked = createDeferredPromise<void>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const threads = await tx
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.id, args.threadId))
      .for("update");
    if (threads.length !== 1) {
      throw new Error("Expected one ChatThread fixture row");
    }
    started.resolve(await transactionBackendPid(tx));
    await attemptSession.promise;
    const sessions = await tx
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(eq(agentSessions.id, args.sessionId))
      .for("update");
    if (sessions.length !== 1) {
      throw new Error("Expected one Session fixture row");
    }
    sessionLocked.resolve(undefined);
    await released.promise;
  });
  const boundary = boundaryFromPid({
    pid: await started.promise,
    released,
    done,
  });
  return {
    ...boundary,
    startSessionLock: () => {
      if (!attemptSession.settled()) {
        attemptSession.resolve(undefined);
      }
    },
    sessionLocked: sessionLocked.promise,
  };
}

export async function readDatabaseLockTimeoutFixture(): Promise<string> {
  const rows = await executeRawRows(
    db(),
    sql`SELECT current_setting('lock_timeout') AS "lockTimeout"`,
    lockTimeoutRowSchema,
  );
  const lockTimeout = rows[0]?.lockTimeout;
  if (lockTimeout === undefined) {
    throw new Error("Expected the current database lock_timeout");
  }
  return lockTimeout;
}
