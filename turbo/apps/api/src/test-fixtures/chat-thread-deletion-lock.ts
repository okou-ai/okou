import { chatEvents } from "@okouai/db/schema/chat-event";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise } from "../signals/utils";

const databasePidRowSchema = z.object({ pid: z.int() });
const blockedDeleteRowSchema = z.object({ blocked: z.boolean() });

/**
 * Hold one test-owned child row so the public thread deletion pauses in its
 * cascade, after locking the parent. Product APIs cannot expose this database
 * scheduling boundary; assertions still use the public chat routes.
 */
export async function holdChatThreadCascadeDeleteFixture(
  args: {
    readonly threadId: string;
    readonly eventId: string;
  },
  signal: AbortSignal,
): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly deletionIsBlocked: () => Promise<boolean>;
}> {
  const started = createDeferredPromise<number>(signal);
  const released = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    const [event] = await tx
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.chatThreadId, args.threadId),
        ),
      )
      .for("update");
    if (!event) {
      throw new Error("Expected the chat event that blocks cascade deletion");
    }
    const [backend] = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    if (!backend) {
      throw new Error("Expected the cascade deletion lock holder pid");
    }
    started.resolve(backend.pid);
    await released.promise;
  });
  const holderPid = await Promise.race([
    started.promise,
    (async () => {
      await done;
      throw new Error("Cascade deletion lock ended before becoming ready");
    })(),
  ]);

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    deletionIsBlocked: async () => {
      const [result] = await executeRawRows(
        db(),
        sql`
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity AS activity
            WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
              AND activity.wait_event_type = 'Lock'
              AND activity.query ILIKE '%delete from "chat_threads"%'
          ) AS "blocked"
        `,
        blockedDeleteRowSchema,
      );
      if (!result) {
        throw new Error("Expected the cascade deletion blocking result");
      }
      return result.blocked;
    },
  };
}
