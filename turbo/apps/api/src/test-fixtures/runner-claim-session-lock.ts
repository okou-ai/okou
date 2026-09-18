import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise, settleIncludingAbort } from "../signals/utils";

/**
 * Infrastructure exception: no production API can retain a Session row lock
 * while a competing request runs. Hold only the test-owned inherited Session;
 * the fixture changes no data and all product assertions remain API reads.
 */
export async function holdRunnerClaimSessionFixture(args: {
  readonly runId: string;
  readonly signal: AbortSignal;
}) {
  const entered = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = settleIncludingAbort(
    db().transaction(async (tx) => {
      const [session] = await tx
        .select({ id: agentSessions.id })
        .from(agentRuns)
        .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
        .where(eq(agentRuns.id, args.runId))
        .for("update", { of: agentSessions });
      if (!session) {
        throw new Error("Expected the inherited Session to exist");
      }
      const [backend] = await executeRawRows(
        tx,
        sql`SELECT pg_backend_pid() AS pid`,
        z.object({ pid: z.number() }),
      );
      if (!backend) {
        throw new Error("Expected the inherited Session lock holder PID");
      }
      entered.resolve(backend.pid);
      await released.promise;
    }),
  );
  const holderPid = await Promise.race([
    entered.promise,
    (async () => {
      const result = await done;
      if (!result.ok) {
        throw result.error;
      }
      throw new Error("Session lock ended before becoming ready");
    })(),
  ]);

  return {
    release: async () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
      const result = await done;
      if (!result.ok && result.error !== args.signal.reason) {
        throw result.error;
      }
    },
    claimIsBlocked: async () => {
      const [row] = await executeRawRows(
        db(),
        sql`
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity AS activity
            WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
          ) AS blocked
        `,
        z.object({ blocked: z.boolean() }),
      );
      if (!row) {
        throw new Error("Expected the Session lock blocking observation");
      }
      return row.blocked;
    },
  };
}
