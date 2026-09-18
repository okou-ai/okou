import { createHash, randomUUID } from "node:crypto";

import { computerUseAuthorizationRequests } from "@okouai/db/schema/computer-use-host";
import { count, eq, sql } from "drizzle-orm";
import { onTestFinished } from "vitest";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import {
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

/**
 * Infrastructure exception: locator-race cases intentionally mutate fields
 * that have no production writer, so the original opaque token can no longer
 * address the row through HTTP. This exact test-owned id read verifies only
 * that Apply did not complete or relabel that moved row.
 */
export async function readComputerUseAuthorizationRequestByIdFixture(
  requestId: string,
): Promise<{
  readonly id: string;
  readonly requestTokenHash: string;
  readonly orgId: string;
  readonly userId: string;
  readonly source: string;
  readonly chatThreadId: string | null;
  readonly expiresAt: string;
  readonly completedAt: string | null;
  readonly updatedAt: string;
} | null> {
  const [request] = await db()
    .select({
      id: computerUseAuthorizationRequests.id,
      requestTokenHash: computerUseAuthorizationRequests.requestTokenHash,
      orgId: computerUseAuthorizationRequests.orgId,
      userId: computerUseAuthorizationRequests.userId,
      source: computerUseAuthorizationRequests.source,
      chatThreadId: computerUseAuthorizationRequests.chatThreadId,
      expiresAt: computerUseAuthorizationRequests.expiresAt,
      completedAt: computerUseAuthorizationRequests.completedAt,
      updatedAt: computerUseAuthorizationRequests.updatedAt,
    })
    .from(computerUseAuthorizationRequests)
    .where(eq(computerUseAuthorizationRequests.id, requestId))
    .limit(1);
  return request
    ? {
        ...request,
        expiresAt: request.expiresAt.toISOString(),
        completedAt: request.completedAt?.toISOString() ?? null,
        updatedAt: request.updatedAt.toISOString(),
      }
    : null;
}

async function requestId(requestToken: string): Promise<string> {
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
 * Infrastructure exceptions: canonical creation writes immutable locator
 * fields and there is no request deletion endpoint. These test-owned mutations
 * reproduce a row moving between Apply's unlocked token lookup and its exact
 * retained pin. Each touches only the caller's opaque request.
 */
export async function mutateComputerUseAuthorizationRequestFixture(args: {
  readonly requestToken: string;
  readonly mutation:
    | "delete"
    | "hash"
    | "organization"
    | "source"
    | "thread"
    | "user";
  readonly replacementThreadId?: string;
}): Promise<string> {
  const id = await requestId(args.requestToken);
  if (args.mutation === "delete") {
    const deleted = await db()
      .delete(computerUseAuthorizationRequests)
      .where(eq(computerUseAuthorizationRequests.id, id))
      .returning({ id: computerUseAuthorizationRequests.id });
    if (deleted.length !== 1) {
      throw new Error("Expected one authorization request to be deleted");
    }
    return id;
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
    throw new Error("Expected one authorization request locator to move");
  }
  return id;
}

const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.number() });

async function blockedRequestPinCount(holderPid: number): Promise<number> {
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT ${count()}::int AS "waiterCount"
      FROM pg_stat_activity AS activity
      WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
        AND lower(activity.query) LIKE '%computer_use_authorization_requests%'
        AND lower(activity.query) LIKE '%for no key update%'
    `,
    waiterCountRowSchema,
  );
  return rows[0]?.waiterCount ?? 0;
}

/**
 * Holds one request row from a real second session. The release function owns
 * and joins the transaction on every exit, including setup rejection and test
 * cancellation, so no holder can escape shared teardown.
 */
export async function holdComputerUseAuthorizationRequestRowFixture(args: {
  readonly requestToken: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => Promise<void>;
  readonly blockedRequestPinCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const holding = onRejection(
    db().transaction(async (tx) => {
      const [request] = await tx
        .select({ id: computerUseAuthorizationRequests.id })
        .from(computerUseAuthorizationRequests)
        .where(
          eq(
            computerUseAuthorizationRequests.requestTokenHash,
            requestTokenHash(args.requestToken),
          ),
        )
        .for("update")
        .limit(1);
      if (!request) {
        throw new Error("Expected the authorization request row");
      }
      const pids = await executeRawRows(
        tx,
        sql`SELECT pg_backend_pid() AS "pid"`,
        databasePidRowSchema,
      );
      const holderPid = pids[0]?.pid;
      if (!holderPid) {
        throw new Error("Expected the request holder backend pid");
      }
      started.resolve(holderPid);
      await released.promise;
    }),
    (error) => {
      if (!started.settled()) {
        started.reject(error);
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
  onTestFinished(release);
  const holderPid = await started.promise;
  return {
    release,
    blockedRequestPinCount: async () => {
      return await blockedRequestPinCount(holderPid);
    },
  };
}

/**
 * Installs a request-id-scoped failure at the completion UPDATE. The trigger is
 * shared-table infrastructure only in placement: its predicate can fail solely
 * for the caller's test-owned row, so unrelated applies remain executable.
 */
export async function failComputerUseAuthorizationCompletionFixture(
  requestToken: string,
): Promise<{ readonly restore: () => Promise<void> }> {
  const id = await requestId(requestToken);
  const digest = createHash("md5").update(id).digest("hex");
  const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
  const triggerName = `fail_${digest}_${nonce}`;
  const functionName = `test_computer_use_auth_completion_${nonce}`;
  await db().transaction(async (tx) => {
    await tx.execute(sql`
      CREATE FUNCTION ${sql.identifier(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF md5(OLD.id::text) = split_part(TG_NAME, '_', 2)
           AND NEW.completed_at IS NOT NULL THEN
          RAISE EXCEPTION 'test-scoped Computer Use authorization completion failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await tx.execute(sql`
      CREATE TRIGGER ${sql.identifier(triggerName)}
      BEFORE UPDATE OF completed_at ON computer_use_authorization_requests
      FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(functionName)}()
    `);
  });

  let restored = false;
  const restore = async () => {
    if (restored) {
      return;
    }
    restored = true;
    await db().transaction(async (tx) => {
      await tx.execute(
        sql`DROP TRIGGER ${sql.identifier(triggerName)} ON computer_use_authorization_requests`,
      );
      await tx.execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
    });
  };
  onTestFinished(restore);
  return { restore };
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

function isApplyThreadPin(queryArgs: unknown[], chatThreadId: string): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "chat_threads"') &&
    text.includes("for no key update") &&
    barrierQueryBinds(queryArgs, chatThreadId)
  );
}

function isRequestPin(queryArgs: unknown[]): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "computer_use_authorization_requests"') &&
    text.includes("for no key update")
  );
}

function isThreadUpdate(queryArgs: unknown[], chatThreadId: string): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("update") &&
    text.includes('"chat_threads" set "computer_use_host_id"') &&
    barrierQueryBinds(queryArgs, chatThreadId)
  );
}

function isCompletionUpdate(queryArgs: unknown[]): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("update") &&
    text.includes('"computer_use_authorization_requests" set "completed_at"')
  );
}

function tookRequestPin(transaction: SelectedTransaction): boolean {
  return transaction.statements.some((statement) => {
    return (
      statement.includes('from "computer_use_authorization_requests"') &&
      statement.includes("for no key update")
    );
  });
}

type ComputerUseAuthorizationApplyStop =
  | "before-thread-pin"
  | "thread-pin"
  | "request-pin"
  | "thread-update"
  | "completion"
  | "commit";

/** Pauses one canonical chat Apply at a real database boundary. */
export async function withComputerUseAuthorizationApplyBarrierFixture<T>(
  args: {
    readonly chatThreadId: string;
    readonly stopAt: ComputerUseAuthorizationApplyStop;
    readonly work: (barrier: TransactionBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  return await withDatabaseTransactionBarrierFixture(
    {
      select: (queryArgs) => {
        return isContentIdentityRead(queryArgs, args.chatThreadId);
      },
      stopAt: (queryArgs, _selectingStatement, transaction) => {
        if (
          args.stopAt === "before-thread-pin" ||
          args.stopAt === "thread-pin"
        ) {
          return isApplyThreadPin(queryArgs, args.chatThreadId);
        }
        if (args.stopAt === "request-pin") {
          return isRequestPin(queryArgs);
        }
        if (args.stopAt === "thread-update") {
          return isThreadUpdate(queryArgs, args.chatThreadId);
        }
        if (args.stopAt === "completion") {
          return isCompletionUpdate(queryArgs);
        }
        return (
          barrierQueryText(queryArgs) === "commit" &&
          tookRequestPin(transaction)
        );
      },
      pauseAfter:
        args.stopAt !== "before-thread-pin" && args.stopAt !== "commit",
      work: args.work,
    },
    signal,
  );
}
