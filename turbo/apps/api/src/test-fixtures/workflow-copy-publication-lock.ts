import { storages } from "@okouai/db/schema/storage";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise } from "../signals/utils";

const backendRowSchema = z.object({ pid: z.int() });
const blockedRowSchema = z.object({ blocked: z.boolean() });

/**
 * Hold only the copy's prepared storage row. No product endpoint can suspend a
 * transaction between source validation and publication; this infrastructure
 * fixture schedules that boundary without changing persisted product state.
 */
export async function holdWorkflowCopyPublicationFixture(
  args: { readonly storageKey: string },
  signal: AbortSignal,
): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly copyIsBlocked: () => Promise<boolean>;
  readonly operationIsBlocked: (
    operation: "thread-deletion" | "automation-creation",
  ) => Promise<boolean>;
}> {
  const [orgId, storageId] = args.storageKey.split("/");
  if (!orgId || !storageId) {
    throw new Error("Expected the prepared volume's organization and storage");
  }
  const started = createDeferredPromise<number>(signal);
  const released = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    const [storage] = await tx
      .select({ id: storages.id })
      .from(storages)
      .where(
        and(
          eq(storages.id, storageId),
          eq(storages.orgId, orgId),
          eq(storages.s3Prefix, `${orgId}/${storageId}`),
        ),
      )
      .for("update");
    if (!storage) {
      throw new Error("Expected the copy's prepared volume storage");
    }
    const [backend] = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      backendRowSchema,
    );
    if (!backend) {
      throw new Error("Expected the copy publication lock holder pid");
    }
    started.resolve(backend.pid);
    await released.promise;
  });
  const holderPid = await Promise.race([
    started.promise,
    (async () => {
      await done;
      throw new Error("Copy publication lock ended before becoming ready");
    })(),
  ]);

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve();
      }
    },
    done,
    copyIsBlocked: async () => {
      const [result] = await executeRawRows(
        db(),
        sql`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity AS copy
            WHERE ${holderPid} = ANY(pg_blocking_pids(copy.pid))
              AND copy.wait_event_type = 'Lock'
              AND copy.query ILIKE '%from "storages"%for update%'
          ) AS "blocked"
        `,
        blockedRowSchema,
      );
      if (!result) {
        throw new Error("Expected the copy publication blocking result");
      }
      return result.blocked;
    },
    operationIsBlocked: async (operation) => {
      // Webhook access revalidation can wait on FOR SHARE before thread
      // creation reaches its FOR KEY SHARE or automation insert.
      const operationQuery =
        operation === "thread-deletion"
          ? sql`operation.query ILIKE '%update "workflow_automations"%'`
          : sql`(
              operation.query ILIKE '%insert into "workflow_automations"%'
              OR operation.query ILIKE '%from "workflows"%for share%'
              OR operation.query ILIKE '%from "workflows"%for key share%'
            )`;
      const [result] = await executeRawRows(
        db(),
        sql`
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity AS copy
            JOIN pg_stat_activity AS operation
              ON copy.pid = ANY(pg_blocking_pids(operation.pid))
            WHERE ${holderPid} = ANY(pg_blocking_pids(copy.pid))
              AND copy.wait_event_type = 'Lock'
              AND copy.query ILIKE '%from "storages"%for update%'
              AND operation.wait_event_type = 'Lock'
              AND ${operationQuery}
          ) AS "blocked"
        `,
        blockedRowSchema,
      );
      if (!result) {
        throw new Error("Expected the operation to wait for the copy's source");
      }
      return result.blocked;
    },
  };
}
