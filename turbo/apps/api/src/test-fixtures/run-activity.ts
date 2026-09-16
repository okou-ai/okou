import { runActivitySnapshots } from "@okouai/db/schema/run-activity-snapshot";
import { eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { z } from "zod";
import { closeDbPool, db } from "../lib/db";
import { createDeferredPromise, settleIncludingAbort } from "../signals/utils";

type ActivityCommitStage =
  | "capture"
  | "claim"
  | "completion"
  | "response"
  | "output";

function activityCommitQuery(queryArgs: unknown[], runId: string) {
  const parsed = z
    .union([z.string(), z.object({ text: z.string() })])
    .safeParse(queryArgs[0]);
  const text = parsed.success
    ? (typeof parsed.data === "string"
        ? parsed.data
        : parsed.data.text
      ).toLowerCase()
    : "";
  const values = z.array(z.unknown()).safeParse(queryArgs[1]);
  const owned = values.success && values.data.includes(runId);
  const snapshot = owned && text.includes('"run_activity_snapshots"');
  const update = snapshot && text.startsWith("update");
  const claimParameter = /"claim_id" = \$(\d+)/.exec(text)?.[1];
  const completion =
    update &&
    !text.includes('"entries" =') &&
    claimParameter !== undefined &&
    values.success &&
    values.data[Number(claimParameter) - 1] === null;
  return { text, owned, snapshot, update, completion };
}

function matchesActivityCommit(
  stage: ActivityCommitStage,
  query: ReturnType<typeof activityCommitQuery>,
  completionSeen: boolean,
) {
  const { text, owned, snapshot, update, completion } = query;
  switch (stage) {
    case "output": {
      return (
        owned && text.startsWith("insert") && text.includes('"chat_events"')
      );
    }
    case "capture": {
      return update && text.includes('"entries" =');
    }
    case "claim": {
      return update && text.includes('"claim_id" =') && !completion;
    }
    case "completion": {
      return completion;
    }
    case "response": {
      return snapshot && text.startsWith("insert") && completionSeen;
    }
  }
}

/** Infrastructure-only time passage, scoped to a run created by this test. */
export async function advanceRunActivityClockFixture(
  runId: string,
  milliseconds: number,
): Promise<void> {
  await db()
    .update(runActivitySnapshots)
    .set({
      expiresAt: sql`${runActivitySnapshots.expiresAt} - ${milliseconds} * interval '1 millisecond'`,
      nextAttemptAt: sql`${runActivitySnapshots.nextAttemptAt} - ${milliseconds} * interval '1 millisecond'`,
      claimExpiresAt: sql`${runActivitySnapshots.claimExpiresAt} - ${milliseconds} * interval '1 millisecond'`,
    })
    .where(eq(runActivitySnapshots.runId, runId));
}

/** Infrastructure exception: APIs cannot delay delivery of a real COMMIT or
 * expose its backend PID/settings. Execute every original pg query unchanged;
 * pause only the selected transaction for this test's unique run. This is not
 * an admission mock, and neither SQL results nor errors are substituted.
 */
export async function withActivityCommitBarrierFixture<T>(
  args: {
    readonly runId: string;
    readonly stage: ActivityCommitStage;
    readonly position: "before" | "after";
    readonly work: (barrier: {
      readonly entered: Promise<{
        pid: number;
        lockTimeout: string;
        statementTimeout: string;
      }>;
      readonly release: () => void;
    }) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  await closeDbPool();
  signal.throwIfAborted();
  const entered = createDeferredPromise<{
    pid: number;
    lockTimeout: string;
    statementTimeout: string;
  }>(signal);
  const released = createDeferredPromise<void>(signal);
  const release = () => {
    if (!released.settled()) {
      released.resolve();
    }
  };
  const original = Client.prototype.query;
  let selected: unknown;
  let completionSeen = false;
  let paused = false;
  Client.prototype.query = new Proxy(original, {
    apply(target, receiver: unknown, queryArgs: unknown[]): unknown {
      const query = activityCommitQuery(queryArgs, args.runId);
      const matches = matchesActivityCommit(args.stage, query, completionSeen);
      if (query.completion) {
        completionSeen = true;
      }
      if (matches && !paused) {
        selected = receiver;
      }
      if (query.text !== "commit" || receiver !== selected || paused) {
        return Reflect.apply(target, receiver, queryArgs);
      }
      paused = true;
      return (async () => {
        const settings: unknown = await Reflect.apply(target, receiver, [
          "SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout",
        ]);
        const row = z
          .object({
            rows: z
              .array(
                z.object({
                  pid: z.number(),
                  lock_timeout: z.string(),
                  statement_timeout: z.string(),
                }),
              )
              .length(1),
          })
          .parse(settings).rows[0]!;
        if (args.position === "after") {
          const result: unknown = await Reflect.apply(
            target,
            receiver,
            queryArgs,
          );
          entered.resolve({
            pid: row.pid,
            lockTimeout: row.lock_timeout,
            statementTimeout: row.statement_timeout,
          });
          await released.promise;
          return result;
        }
        entered.resolve({
          pid: row.pid,
          lockTimeout: row.lock_timeout,
          statementTimeout: row.statement_timeout,
        });
        await released.promise;
        return await Reflect.apply(target, receiver, queryArgs);
      })();
    },
  });
  const result = await settleIncludingAbort(
    args.work({ entered: entered.promise, release }),
  );
  release();
  const closed = await settleIncludingAbort(closeDbPool());
  Client.prototype.query = original;
  if (!result.ok) {
    throw result.error;
  }
  if (!closed.ok) {
    throw closed.error;
  }
  return result.value;
}

/** A stalled database writer is not constructible through a production API. */
export async function holdRunActivityFixture(
  runId: string,
  signal: AbortSignal,
) {
  const ready = createDeferredPromise<void>(signal);
  const release = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    await tx
      .select({ runId: runActivitySnapshots.runId })
      .from(runActivitySnapshots)
      .where(eq(runActivitySnapshots.runId, runId))
      .for("update");
    ready.resolve(undefined);
    await release.promise;
  });
  await ready.promise;
  return {
    release: () => {
      if (!release.settled()) {
        release.resolve(undefined);
      }
    },
    done,
  };
}
