import { createHash, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { expect, onTestFinished } from "vitest";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise, settle } from "../signals/utils";
import { holdDeferredRow } from "./pi-deferred-lock";

/**
 * Infrastructure-only rendezvous for the Morning Brief preference projection.
 *
 * The Settings endpoints decide *what* is written; nothing they accept can
 * suspend one owner's projection write between its legacy commit and its own
 * COMMIT, hold a membership parent uncommitted, or fail that single write.
 * Those are PostgreSQL lock and transaction boundaries, so the fixtures below
 * force them and then prove arrival with `pg_blocking_pids`, never a sleep.
 *
 * Every trigger installed here matches exactly one `(org_id, user_id)` pair
 * through a digest carried in its own `TG_NAME`, and its advisory key is
 * namespaced by that same digest. A concurrently running suite's owners are
 * never suspended or failed, and nothing outside the named owner is touched.
 */

interface MorningBriefProjectionOwner {
  readonly orgId: string;
  readonly userId: string;
}

/** Bounds every wait in this file, matching the deferred-lock precedent. */
const ARRIVAL_TIMEOUT_MS = 10_000;

/** Bounds a blocked cleanup so teardown can never wait on a held gate. */
const CLEANUP_LOCK_TIMEOUT = "15s";

const pidSchema = z.object({ pid: z.number() });
const blockedSchema = z.object({ blocked: z.boolean() });
const statementSchema = z.object({ query: z.string() });

/**
 * The half-digest identifying one owner inside a trigger name.
 *
 * Trigger names are identifiers, so the owner cannot be bound as a parameter
 * and must not be pasted into DDL text. Naming the trigger after the digest
 * keeps the DDL free of caller-supplied text while the trigger body still
 * recognises exactly one row.
 */
function ownerDigest(owner: MorningBriefProjectionOwner): string {
  return createHash("sha256")
    .update(`${owner.orgId}:${owner.userId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function projectionGateKey(digest: string): string {
  return `morning-brief-projection:${digest}`;
}

interface HeldMorningBriefProjectionWrite {
  /**
   * Resolves with the backend process id suspended inside this owner's
   * projection write, proving the writer reached the boundary.
   */
  readonly waitForArrival: () => Promise<number>;
  /** Let the suspended write continue, into its fault when one is installed. */
  readonly release: () => Promise<void>;
  /** Release and remove the fault so later writes complete normally. */
  readonly remove: () => Promise<void>;
}

async function installProjectionTrigger(
  digest: string,
  failAfterGate: boolean,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  const functionName = `test_morning_brief_projection_${randomUUID().replaceAll("-", "")}`;
  // `mb_proj_<digest>_<nonce>`: the body reads field 3 back out of `TG_NAME`,
  // and the nonce keeps two fixtures for one owner from colliding.
  const triggerName = `mb_proj_${digest}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const fault = failAfterGate
    ? sql`
        RAISE EXCEPTION 'Test Morning Brief projection write failed'
          USING ERRCODE = '23514';
      `
    : sql.empty();

  await db().transaction(async (tx) => {
    await tx.execute(sql`
      CREATE FUNCTION ${sql.identifier(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF substring(
             encode(
               sha256(convert_to(NEW.org_id || ':' || NEW.user_id, 'UTF8')),
               'hex'
             ) from 1 for 32
           ) = split_part(TG_NAME, '_', 3) THEN
          PERFORM pg_advisory_xact_lock(
            hashtextextended(
              'morning-brief-projection:' || split_part(TG_NAME, '_', 3), 0
            )
          );${fault}
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    signal.throwIfAborted();
    await tx.execute(sql`
      CREATE TRIGGER ${sql.identifier(triggerName)}
      AFTER INSERT OR UPDATE ON morning_brief_installed_preferences
      FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(functionName)}()
    `);
    signal.throwIfAborted();
  });

  let dropped = false;
  return async () => {
    if (dropped) {
      return;
    }
    dropped = true;
    await db().transaction(async (tx) => {
      await tx.execute(
        sql`DROP TRIGGER ${sql.identifier(triggerName)} ON morning_brief_installed_preferences`,
      );
      await tx.execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
    });
  };
}

/**
 * Suspend this owner's projection row write until the handle is released.
 *
 * The trigger is `AFTER INSERT OR UPDATE`, so a suspended writer has already
 * admitted its erasure subjects, rechecked and locked the membership parent
 * with `FOR KEY SHARE`, and written its copy — none of it committed. The legacy
 * mutation that scheduled the refresh runs on the outer `Db` and has therefore
 * already committed by the time this boundary is reached.
 *
 * With `failAfterGate`, the released write raises a real check-violation error
 * inside that transaction instead of committing, which is what an operational
 * write failure after a committed legacy choice looks like.
 */
export async function holdMorningBriefProjectionWrite(
  owner: MorningBriefProjectionOwner,
  options: { readonly failAfterGate?: boolean },
  signal: AbortSignal,
): Promise<HeldMorningBriefProjectionWrite> {
  const digest = ownerDigest(owner);
  const dropTrigger = await installProjectionTrigger(
    digest,
    options.failAfterGate === true,
    signal,
  );
  const held = await holdDeferredRow(signal, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${projectionGateKey(digest)}, 0))`,
    );
  });

  const remove = async () => {
    await held.release();
    await dropTrigger();
  };
  // Registered after the hold, so this runs first and frees any suspended
  // writer before the trigger's exclusive-lock drop.
  onTestFinished(remove);

  return { waitForArrival: held.waitForBlocked, release: held.release, remove };
}

/**
 * Delete this owner's membership parent and hold that removal uncommitted.
 *
 * The open transaction owns the exact `org_members_cache` row the projection
 * hangs from, so a refresh that reaches its `FOR KEY SHARE` recheck queues
 * behind it instead of racing it.
 */
export async function holdMorningBriefMembershipRemoval(
  owner: MorningBriefProjectionOwner,
  signal: AbortSignal,
) {
  return await holdDeferredRow(signal, async (tx) => {
    await tx.execute(sql`
      DELETE FROM org_members_cache
      WHERE org_id = ${owner.orgId} AND user_id = ${owner.userId}
    `);
  });
}

interface StartedMorningBriefMembershipRemoval {
  /** The backend running the cleanup, so the test can prove who blocks it. */
  readonly pid: number;
  /** Resolves when the cleanup commits. */
  readonly committed: Promise<void>;
}

/**
 * Start a membership cleanup that commits on its own, and report the backend
 * running it so a test can prove which transaction it is waiting for.
 *
 * `lock_timeout` bounds the wait: teardown can never hang behind a gate that a
 * failed assertion left held.
 */
export async function startMorningBriefMembershipRemoval(
  owner: MorningBriefProjectionOwner,
  signal: AbortSignal,
): Promise<StartedMorningBriefMembershipRemoval> {
  const entered = createDeferredPromise<number>(signal);
  const transaction = db().transaction(async (tx) => {
    const [row] = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS pid`,
      pidSchema,
    );
    if (!row) {
      throw new Error("Missing cleanup backend identity");
    }
    await tx.execute(
      sql`SELECT set_config('lock_timeout', ${CLEANUP_LOCK_TIMEOUT}, true)`,
    );
    entered.resolve(row.pid);
    await tx.execute(sql`
      DELETE FROM org_members_cache
      WHERE org_id = ${owner.orgId} AND user_id = ${owner.userId}
    `);
  });
  onTestFinished(async () => {
    await settle(transaction);
  });
  return { pid: await entered.promise, committed: transaction };
}

/** Resolves once `waiterPid` is waiting for a lock held by `blockerPid`. */
export async function waitForBlockingPid(
  waiterPid: number,
  blockerPid: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const rows = await executeRawRows(
          db(),
          sql`SELECT ${blockerPid}::int = ANY(pg_blocking_pids(${waiterPid}::int)) AS blocked`,
          blockedSchema,
        );
        return rows[0]?.blocked === true;
      },
      { timeout: ARRIVAL_TIMEOUT_MS },
    )
    .toBe(true);
}

/**
 * The statement a backend is currently running.
 *
 * Read while a session is proven blocked, this names the exact boundary the
 * fixture holds instead of leaving it to a comment.
 */
export async function readActiveStatement(pid: number): Promise<string> {
  const rows = await executeRawRows(
    db(),
    sql`SELECT query FROM pg_stat_activity WHERE pid = ${pid}::int`,
    statementSchema,
  );
  const [row] = rows;
  if (!row) {
    throw new Error("Missing blocked backend statement");
  }
  return row.query.toLowerCase();
}
