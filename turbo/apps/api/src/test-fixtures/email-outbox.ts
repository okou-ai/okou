import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { db } from "../lib/db";
import { holdDeferredRow, waitForDeferredBlocker } from "./pi-deferred-lock";

/**
 * Infrastructure-only faults for the email outbox drain.
 *
 * The drain has no user-facing entry point, and no product API can suspend or
 * reject one specific write inside its prepare → send → complete sequence: the
 * business inputs that reach the outbox only decide which row is enqueued.
 * Every trigger below matches a single test-owned row id through `TG_NAME`, and
 * its advisory key is namespaced by that same id, so a concurrent suite's rows
 * are never suspended or failed.
 */

interface HeldEmailOutboxWrite {
  /** Resolves with the process id of a session waiting on the held lock. */
  readonly waitForBlocked: () => Promise<number>;
  readonly release: () => Promise<void>;
}

function triggerFunctionName(kind: string): string {
  return `test_email_outbox_${kind}_${randomUUID().replaceAll("-", "")}`;
}

async function installEmailOutboxTrigger(
  itemId: string,
  functionName: string,
  createFunction: SQL,
  signal: AbortSignal,
  timing: "before" | "after" = "before",
): Promise<() => Promise<void>> {
  const event = timing === "after" ? sql`AFTER UPDATE` : sql`BEFORE UPDATE`;
  await db().transaction(async (tx) => {
    await tx.execute(createFunction);
    signal.throwIfAborted();
    await tx.execute(sql`
      CREATE TRIGGER ${sql.identifier(itemId)} ${event} ON email_outbox
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
        sql`DROP TRIGGER ${sql.identifier(itemId)} ON email_outbox`,
      );
      await tx.execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
    });
  };
}

/**
 * Suspend one row's claim update until the returned handle is released. The
 * suspended transaction has already admitted the row against the clock, so a
 * test can cross the row's own deadline while its request is still being
 * prepared and committed.
 */
export async function holdEmailOutboxClaim(
  itemId: string,
  signal: AbortSignal,
  options: { readonly removeBeforeCommit?: boolean } = {},
): Promise<HeldEmailOutboxWrite> {
  const functionName = triggerFunctionName("claim");
  // Delete in the claim's AFTER UPDATE trigger so the prepared row is
  // deterministically absent before completion. A separate queued DELETE can
  // be overtaken when the claim UPDATE creates a new tuple version.
  const removal = options.removeBeforeCommit
    ? sql`DELETE FROM email_outbox WHERE id = NEW.id;`
    : sql.empty();
  const dropTrigger = await installEmailOutboxTrigger(
    itemId,
    functionName,
    sql`
      CREATE FUNCTION ${sql.identifier(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id::text = TG_NAME AND NEW.status = 'sending' THEN
          PERFORM pg_advisory_xact_lock(
            hashtextextended('email-outbox-claim:' || TG_NAME, 0)
          );
          ${removal}
        END IF;
        RETURN NEW;
      END;
      $$
    `,
    signal,
    options.removeBeforeCommit ? "after" : "before",
  );

  const held = await holdDeferredRow(signal, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`email-outbox-claim:${itemId}`}, 0))`,
    );
  });

  // Registered after the hold, so this runs first and frees the suspended drain
  // before the trigger's exclusive-lock drop.
  onTestFinished(async () => {
    await held.release();
    await dropTrigger();
  });

  return held;
}

/**
 * Fail one row's delivery completion after the provider has already accepted
 * its request, leaving the committed request and key behind exactly as a worker
 * that lost its database connection would.
 */
export async function rejectEmailOutboxCompletion(
  itemId: string,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  const functionName = triggerFunctionName("completion");
  return await installEmailOutboxTrigger(
    itemId,
    functionName,
    sql`
      CREATE FUNCTION ${sql.identifier(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id::text = TG_NAME AND NEW.status = 'sent' THEN
          RAISE EXCEPTION 'Test email outbox completion write failed'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$
    `,
    signal,
  );
}

/**
 * Hold one row exactly as a concurrent worker's claim transaction does.
 *
 * The claim selects `FOR UPDATE SKIP LOCKED`, so another drain passes this row
 * over instead of waiting for it. The preflight takes no lock at all and still
 * sees it, which is the divergence this barrier exists to exercise. The hold is
 * established before the helper returns, so the case needs no sleep.
 */
export async function holdEmailOutboxRow(
  itemId: string,
  signal: AbortSignal,
): Promise<HeldEmailOutboxWrite> {
  return await holdDeferredRow(signal, async (tx) => {
    await tx.execute(
      sql`SELECT 1 FROM email_outbox WHERE id = ${itemId}::uuid FOR UPDATE`,
    );
  });
}

/**
 * Take one row away and hold that removal uncommitted, so a drain attempt that
 * still believes it owns the row queues behind it.
 */
export async function holdEmailOutboxRemoval(
  itemId: string,
  signal: AbortSignal,
): Promise<HeldEmailOutboxWrite> {
  return await holdDeferredRow(signal, async (tx) => {
    await tx.execute(sql`DELETE FROM email_outbox WHERE id = ${itemId}::uuid`);
  });
}

/** Resolves once some session is waiting on a lock held by `pid`. */
export async function waitForEmailOutboxBlocked(pid: number): Promise<number> {
  return await waitForDeferredBlocker(pid);
}
