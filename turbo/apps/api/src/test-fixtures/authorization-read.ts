import { createHash, randomUUID } from "node:crypto";

import { browserAuthorizationRequests } from "@okouai/db/schema/browser-session";
import { computerUseAuthorizationRequests } from "@okouai/db/schema/computer-use-host";
import { count, eq, sql } from "drizzle-orm";
import { onTestFinished } from "vitest";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import type { Tx } from "../lib/db-types";
import {
  acknowledgeDetachedForTest,
  createDeferredPromise,
  isAbortError,
  onRejection,
  settleIncludingAbort,
} from "../signals/utils";
import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
  type SelectedTransaction,
  type TransactionBarrier,
} from "./account-erasure-subject";

function requestTokenHash(requestToken: string): string {
  return createHash("sha256").update(requestToken).digest("hex");
}

async function browserRequestId(requestToken: string): Promise<string> {
  const [request] = await db()
    .select({ id: browserAuthorizationRequests.id })
    .from(browserAuthorizationRequests)
    .where(
      eq(
        browserAuthorizationRequests.requestTokenHash,
        requestTokenHash(requestToken),
      ),
    )
    .limit(1);
  if (!request) {
    throw new Error("Expected the browser authorization request row");
  }
  return request.id;
}

async function computerUseRequestId(requestToken: string): Promise<string> {
  const [request] = await db()
    .select({ id: computerUseAuthorizationRequests.id })
    .from(computerUseAuthorizationRequests)
    .where(
      eq(
        computerUseAuthorizationRequests.requestTokenHash,
        requestTokenHash(requestToken),
      ),
    )
    .limit(1);
  if (!request) {
    throw new Error("Expected the Computer Use authorization request row");
  }
  return request.id;
}

/**
 * Infrastructure exceptions: authorization request locator labels have no
 * production mutation endpoint. These test-owned changes reproduce a row
 * moving after GET's unlocked token lookup without creating another authority.
 */
export async function mutateBrowserAuthorizationReadRequestFixture(args: {
  readonly requestToken: string;
  readonly mutation:
    | "delete"
    | "hash"
    | "organization"
    | "run"
    | "thread"
    | "user";
  readonly replacementThreadId?: string;
}): Promise<void> {
  const id = await browserRequestId(args.requestToken);
  if (args.mutation === "delete") {
    await db()
      .delete(browserAuthorizationRequests)
      .where(eq(browserAuthorizationRequests.id, id));
    return;
  }
  const values =
    args.mutation === "hash"
      ? {
          requestTokenHash: createHash("sha256")
            .update(randomUUID())
            .digest("hex"),
        }
      : args.mutation === "organization"
        ? { orgId: `org_${randomUUID()}` }
        : args.mutation === "user"
          ? { userId: `user_${randomUUID()}` }
          : args.mutation === "run"
            ? { runId: randomUUID() }
            : { chatThreadId: args.replacementThreadId ?? randomUUID() };
  const updated = await db()
    .update(browserAuthorizationRequests)
    .set(values)
    .where(eq(browserAuthorizationRequests.id, id))
    .returning({ id: browserAuthorizationRequests.id });
  if (updated.length !== 1) {
    throw new Error("Expected one browser authorization locator to move");
  }
}

export async function mutateComputerUseAuthorizationReadRequestFixture(args: {
  readonly requestToken: string;
  readonly mutation:
    | "delete"
    | "hash"
    | "organization"
    | "run"
    | "source"
    | "thread"
    | "user";
  readonly replacementThreadId?: string;
}): Promise<void> {
  const id = await computerUseRequestId(args.requestToken);
  if (args.mutation === "delete") {
    await db()
      .delete(computerUseAuthorizationRequests)
      .where(eq(computerUseAuthorizationRequests.id, id));
    return;
  }
  const values =
    args.mutation === "hash"
      ? {
          requestTokenHash: createHash("sha256")
            .update(randomUUID())
            .digest("hex"),
        }
      : args.mutation === "organization"
        ? { orgId: `org_${randomUUID()}` }
        : args.mutation === "user"
          ? { userId: `user_${randomUUID()}` }
          : args.mutation === "run"
            ? { runId: randomUUID() }
            : args.mutation === "thread"
              ? { chatThreadId: args.replacementThreadId ?? randomUUID() }
              : {
                  source: "teams",
                  chatThreadId: null,
                  teamsConnectionId: randomUUID(),
                  teamsConversationId: `conversation-${randomUUID()}`,
                  teamsThreadId: `thread-${randomUUID()}`,
                };
  const updated = await db()
    .update(computerUseAuthorizationRequests)
    .set(values)
    .where(eq(computerUseAuthorizationRequests.id, id))
    .returning({ id: computerUseAuthorizationRequests.id });
  if (updated.length !== 1) {
    throw new Error("Expected one Computer Use authorization locator to move");
  }
}

export async function expireComputerUseAuthorizationReadRequestFixture(args: {
  readonly requestToken: string;
  readonly expiresAt: Date;
}): Promise<void> {
  const updated = await db()
    .update(computerUseAuthorizationRequests)
    .set({ expiresAt: args.expiresAt })
    .where(
      eq(
        computerUseAuthorizationRequests.requestTokenHash,
        requestTokenHash(args.requestToken),
      ),
    )
    .returning({ id: computerUseAuthorizationRequests.id });
  if (updated.length !== 1) {
    throw new Error(
      "Expected one Computer Use authorization request to expire",
    );
  }
}

const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.number() });

type AuthorizationReadKind = "browser" | "computer-use";

function requestTableName(kind: AuthorizationReadKind): string {
  return kind === "browser"
    ? "browser_authorization_requests"
    : "computer_use_authorization_requests";
}

async function blockedRequestReadPinCount(
  holderPid: number,
  kind: AuthorizationReadKind,
): Promise<number> {
  const requestFragment = `%${requestTableName(kind)}%`;
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT ${count()}::int AS "waiterCount"
      FROM pg_stat_activity AS activity
      WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
        AND lower(activity.query) LIKE ${requestFragment}
        AND lower(activity.query) LIKE '%for share%'
    `,
    waiterCountRowSchema,
  );
  return rows[0]?.waiterCount ?? 0;
}

async function blockedReadIdentityMutationCount(
  holderPid: number,
  kind: AuthorizationReadKind,
): Promise<number> {
  const requestFragment = `%${requestTableName(kind)}%`;
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT ${count()}::int AS "waiterCount"
      FROM pg_stat_activity AS reading
      JOIN pg_stat_activity AS mutation
        ON reading.pid = ANY(pg_blocking_pids(mutation.pid))
      WHERE ${holderPid} = ANY(pg_blocking_pids(reading.pid))
        AND lower(reading.query) LIKE ${requestFragment}
        AND lower(reading.query) LIKE '%for share%'
        AND (
          lower(mutation.query) LIKE 'update "chat_threads" set "user_id"%'
          OR lower(mutation.query) LIKE 'update "chat_threads" set "agent_id"%'
          OR lower(mutation.query) LIKE 'update "agents" set "owner"%'
          OR lower(mutation.query) LIKE 'update "agents" set "org_id"%'
        )
    `,
    waiterCountRowSchema,
  );
  return rows[0]?.waiterCount ?? 0;
}

interface AuthorizationReadRequestHolder {
  readonly release: () => Promise<void>;
  readonly blockedRequestPinCount: () => Promise<number>;
  readonly blockedIdentityMutationCount: () => Promise<number>;
}

interface HoldAuthorizationReadRequestArgs {
  readonly kind: AuthorizationReadKind;
  readonly requestToken: string;
  readonly signal: AbortSignal;
  readonly mutateBeforeCommit?:
    | "hash"
    | "organization"
    | "source"
    | "thread"
    | "user";
}

async function lockAuthorizationReadRequest(
  tx: Tx,
  args: HoldAuthorizationReadRequestArgs,
): Promise<string> {
  const table =
    args.kind === "browser"
      ? browserAuthorizationRequests
      : computerUseAuthorizationRequests;
  const [request] = await tx
    .select({ id: table.id })
    .from(table)
    .where(eq(table.requestTokenHash, requestTokenHash(args.requestToken)))
    .for("update")
    .limit(1);
  if (!request) {
    throw new Error("Expected the authorization read request row");
  }
  return request.id;
}

async function mutateAuthorizationReadRequest(
  tx: Tx,
  args: HoldAuthorizationReadRequestArgs,
  id: string,
): Promise<void> {
  if (!args.mutateBeforeCommit) {
    return;
  }
  if (args.kind === "browser") {
    const values =
      args.mutateBeforeCommit === "hash"
        ? {
            requestTokenHash: createHash("sha256")
              .update(randomUUID())
              .digest("hex"),
          }
        : args.mutateBeforeCommit === "organization"
          ? { orgId: `org_${randomUUID()}` }
          : args.mutateBeforeCommit === "user"
            ? { userId: `user_${randomUUID()}` }
            : { chatThreadId: randomUUID() };
    await tx
      .update(browserAuthorizationRequests)
      .set(values)
      .where(eq(browserAuthorizationRequests.id, id));
    return;
  }
  const values =
    args.mutateBeforeCommit === "hash"
      ? {
          requestTokenHash: createHash("sha256")
            .update(randomUUID())
            .digest("hex"),
        }
      : args.mutateBeforeCommit === "organization"
        ? { orgId: `org_${randomUUID()}` }
        : args.mutateBeforeCommit === "user"
          ? { userId: `user_${randomUUID()}` }
          : args.mutateBeforeCommit === "thread"
            ? { chatThreadId: randomUUID() }
            : {
                source: "teams",
                chatThreadId: null,
                teamsConnectionId: randomUUID(),
                teamsConversationId: `conversation-${randomUUID()}`,
                teamsThreadId: `thread-${randomUUID()}`,
              };
  await tx
    .update(computerUseAuthorizationRequests)
    .set(values)
    .where(eq(computerUseAuthorizationRequests.id, id));
}

async function runAuthorizationReadRequestHolder(
  args: HoldAuthorizationReadRequestArgs,
  onStarted: (holderPid: number) => void,
  released: Promise<void>,
): Promise<void> {
  await db().transaction(async (tx) => {
    const id = await lockAuthorizationReadRequest(tx, args);
    const pids = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    const holderPid = pids[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the authorization read holder backend pid");
    }
    onStarted(holderPid);
    await released;
    await mutateAuthorizationReadRequest(tx, args, id);
  });
}

/**
 * Holds one exact request from a real second session. Readiness failures are
 * observed immediately; release owns and joins the holder on every exit.
 */
async function holdAuthorizationReadRequestFixture(
  args: HoldAuthorizationReadRequestArgs,
): Promise<AuthorizationReadRequestHolder> {
  const started = createDeferredPromise<
    | { readonly ok: true; readonly holderPid: number }
    | { readonly ok: false; readonly error: unknown }
  >(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const holding = onRejection(
    runAuthorizationReadRequestHolder(
      args,
      (holderPid) => {
        started.resolve({ ok: true, holderPid });
      },
      released.promise,
    ),
    (error) => {
      if (!started.settled()) {
        started.resolve({ ok: false, error });
      }
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
  );
  const finished = settleIncludingAbort(holding);
  const release = async () => {
    if (!released.settled()) {
      released.resolve(undefined);
    }
    const result = await finished;
    if (!result.ok && !(args.signal.aborted && isAbortError(result.error))) {
      throw result.error;
    }
  };
  const ready = await settleIncludingAbort(started.promise);
  acknowledgeDetachedForTest(started.promise);
  if (!ready.ok) {
    await finished;
    throw ready.error;
  }
  if (!ready.value.ok) {
    await finished;
    throw ready.value.error;
  }
  onTestFinished(release);
  const { holderPid } = ready.value;
  return {
    release,
    blockedRequestPinCount: async () => {
      return await blockedRequestReadPinCount(holderPid, args.kind);
    },
    blockedIdentityMutationCount: async () => {
      return await blockedReadIdentityMutationCount(holderPid, args.kind);
    },
  };
}

export async function holdBrowserAuthorizationReadRequestFixture(args: {
  readonly requestToken: string;
  readonly signal: AbortSignal;
  readonly mutateBeforeCommit?: "hash" | "organization" | "thread" | "user";
}): Promise<AuthorizationReadRequestHolder> {
  return await holdAuthorizationReadRequestFixture({
    kind: "browser",
    ...args,
  });
}

export async function holdComputerUseAuthorizationReadRequestFixture(args: {
  readonly requestToken: string;
  readonly signal: AbortSignal;
  readonly mutateBeforeCommit?:
    | "hash"
    | "organization"
    | "source"
    | "thread"
    | "user";
}): Promise<AuthorizationReadRequestHolder> {
  return await holdAuthorizationReadRequestFixture({
    kind: "computer-use",
    ...args,
  });
}

function isContentIdentityRead(
  queryArgs: unknown[],
  chatThreadId: string,
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "chat_threads" left join "agents"') &&
    text.includes('where "chat_threads"."id" =') &&
    barrierQueryBinds(queryArgs, chatThreadId)
  );
}

function isRequestLocator(
  queryArgs: unknown[],
  kind: AuthorizationReadKind,
  requestToken: string,
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes(`from "${requestTableName(kind)}"`) &&
    !text.includes("for share") &&
    barrierQueryBinds(queryArgs, requestTokenHash(requestToken))
  );
}

function isAgentIdentityLock(queryArgs: unknown[]): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "agents"') &&
    text.includes("for key share")
  );
}

function isReadIdentityThreadLock(
  queryArgs: unknown[],
  chatThreadId: string,
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('select "id" from "chat_threads"') &&
    text.includes("for update") &&
    barrierQueryBinds(queryArgs, chatThreadId)
  );
}

function isReadThreadPin(
  queryArgs: unknown[],
  kind: AuthorizationReadKind,
  chatThreadId: string,
): boolean {
  const text = barrierQueryText(queryArgs);
  const projectionColumn =
    kind === "browser" ? '"cloud_browser_enabled"' : '"computer_use_host_id"';
  return (
    text.startsWith("select") &&
    text.includes('from "chat_threads"') &&
    text.includes(projectionColumn) &&
    text.includes("for update") &&
    barrierQueryBinds(queryArgs, chatThreadId)
  );
}

function isReadRequestPin(
  queryArgs: unknown[],
  kind: AuthorizationReadKind,
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes(`from "${requestTableName(kind)}"`) &&
    text.includes("for share")
  );
}

function isHostProjection(queryArgs: unknown[]): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "computer_use_hosts"') &&
    text.includes('order by "computer_use_hosts"."last_seen_at" desc')
  );
}

function tookReadRequestPin(
  transaction: SelectedTransaction,
  kind: AuthorizationReadKind,
): boolean {
  return transaction.statements.some((statement) => {
    return (
      statement.includes(`from "${requestTableName(kind)}"`) &&
      statement.includes("for share")
    );
  });
}

type AuthorizationReadStop =
  | "before-agent-lock"
  | "before-identity-thread-lock"
  | "before-thread-pin"
  | "commit"
  | "hosts"
  | "locator"
  | "request-pin"
  | "thread-pin";

async function withAuthorizationReadBarrierFixture<T>(
  args: {
    readonly kind: AuthorizationReadKind;
    readonly chatThreadId: string;
    readonly requestToken: string;
    readonly stopAt: AuthorizationReadStop;
    readonly work: (barrier: TransactionBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  return await withDatabaseTransactionBarrierFixture(
    {
      select: (queryArgs) => {
        return args.stopAt === "locator"
          ? isRequestLocator(queryArgs, args.kind, args.requestToken)
          : isContentIdentityRead(queryArgs, args.chatThreadId);
      },
      stopAt: (queryArgs, selectingStatement, transaction) => {
        if (args.stopAt === "locator") {
          return selectingStatement;
        }
        if (args.stopAt === "before-agent-lock") {
          return isAgentIdentityLock(queryArgs);
        }
        if (args.stopAt === "before-identity-thread-lock") {
          return isReadIdentityThreadLock(queryArgs, args.chatThreadId);
        }
        if (
          args.stopAt === "before-thread-pin" ||
          args.stopAt === "thread-pin"
        ) {
          return isReadThreadPin(queryArgs, args.kind, args.chatThreadId);
        }
        if (args.stopAt === "request-pin") {
          return isReadRequestPin(queryArgs, args.kind);
        }
        if (args.stopAt === "hosts") {
          return isHostProjection(queryArgs);
        }
        return (
          barrierQueryText(queryArgs) === "commit" &&
          tookReadRequestPin(transaction, args.kind)
        );
      },
      pauseAfter:
        args.stopAt === "locator" ||
        args.stopAt === "thread-pin" ||
        args.stopAt === "request-pin" ||
        args.stopAt === "hosts",
      work: args.work,
    },
    signal,
  );
}

export async function withBrowserAuthorizationReadBarrierFixture<T>(
  args: {
    readonly chatThreadId: string;
    readonly requestToken: string;
    readonly stopAt: Exclude<AuthorizationReadStop, "hosts">;
    readonly work: (barrier: TransactionBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  return await withAuthorizationReadBarrierFixture(
    { kind: "browser", ...args },
    signal,
  );
}

export async function withComputerUseAuthorizationReadBarrierFixture<T>(
  args: {
    readonly chatThreadId: string;
    readonly requestToken: string;
    readonly stopAt: AuthorizationReadStop;
    readonly work: (barrier: TransactionBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  return await withAuthorizationReadBarrierFixture(
    { kind: "computer-use", ...args },
    signal,
  );
}
