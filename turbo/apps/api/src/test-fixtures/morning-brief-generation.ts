import { createHash, randomUUID } from "node:crypto";

import { agentRuns } from "@okouai/db/schema/agent-run";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import {
  morningBriefGenerations,
  morningBriefPlatformGenerationReceipts,
} from "@okouai/db/schema/morning-brief-generation";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgUsageAllowanceWindows } from "@okouai/db/schema/org-usage-allowance";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { workflowUserAutomationThreads } from "@okouai/db/schema/workflow";
import { and, eq, sql } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { db } from "../lib/db";
import { holdDeferredRow } from "./pi-deferred-lock";

/**
 * Infrastructure-only rendezvous and readers for Morning Brief generation.
 *
 * The barrier below exists to prove a claim no assertion after the fact can
 * make: that the provider is never contacted before the reservation is durable.
 * Nothing a caller can send suspends a transaction between its INSERT and its
 * COMMIT, so this forces that exact window with a PostgreSQL lock and the test
 * observes arrival with `pg_blocking_pids` rather than a sleep.
 *
 * The trigger matches exactly one `(org_id, user_id)` pair through a digest
 * carried in its own `TG_NAME`, and its advisory key is namespaced by that same
 * digest, so a concurrently running suite's owners are never suspended.
 */

interface MorningBriefGenerationOwner {
  readonly orgId: string;
  readonly userId: string;
}

/** Every generation slot this owner holds, for assertions. */
export async function readMorningBriefGenerations(
  owner: MorningBriefGenerationOwner,
) {
  return await db()
    .select()
    .from(morningBriefGenerations)
    .where(
      and(
        eq(morningBriefGenerations.orgId, owner.orgId),
        eq(morningBriefGenerations.userId, owner.userId),
      ),
    );
}

/** Every platform receipt written for the given opaque attempt ids. */
export async function readPlatformGenerationReceipts(
  attemptIds: readonly string[],
) {
  const rows = await db().select().from(morningBriefPlatformGenerationReceipts);
  return rows.filter((row) => {
    return attemptIds.includes(row.attemptId);
  });
}

/** Write the member's persisted locale the way Settings would. */
export async function setMorningBriefMemberLocale(
  owner: MorningBriefGenerationOwner,
  locale: string,
): Promise<void> {
  await db()
    .update(orgMembersMetadata)
    .set({ locale })
    .where(
      and(
        eq(orgMembersMetadata.orgId, owner.orgId),
        eq(orgMembersMetadata.userId, owner.userId),
      ),
    );
}

/**
 * Remove the member's durable preference row, as membership cleanup does.
 *
 * It is the occurrence's parent, so this is the revocation the generation slot
 * must lose to — including while a provider request is already in flight.
 */
export async function removeMorningBriefMember(
  owner: MorningBriefGenerationOwner,
): Promise<void> {
  await db()
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, owner.orgId),
        eq(orgMembersMetadata.userId, owner.userId),
      ),
    );
}

/**
 * Rebind this member's connected Slack account to a different Slack user.
 *
 * The occurrence freezes the exact native binding it was admitted under, so a
 * new Slack identity in the same workspace is a different authority even though
 * the member and the installation are unchanged.
 */
export async function rebindMorningBriefSlackAccount(
  userId: string,
  slackUserId: string,
): Promise<void> {
  await db()
    .update(slackOrgConnections)
    .set({ slackUserId })
    .where(eq(slackOrgConnections.userId, userId));
}

/**
 * Everything this path must never create, counted in one place.
 *
 * Platform-funded generation is only platform-funded if none of these move, so
 * a test compares this whole footprint rather than one table at a time.
 */
export async function readOwnerBillingFootprint(scope: {
  readonly orgId: string;
  readonly workflowId: string;
  readonly automationId: string;
}) {
  const [usageEvents, allowanceWindows, runs, emails, threads, metadata] =
    await Promise.all([
      db().select().from(usageEvent).where(eq(usageEvent.orgId, scope.orgId)),
      db()
        .select()
        .from(orgUsageAllowanceWindows)
        .where(eq(orgUsageAllowanceWindows.orgId, scope.orgId)),
      db().select().from(agentRuns).where(eq(agentRuns.orgId, scope.orgId)),
      db()
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.sourceWorkflowAutomationId, scope.automationId)),
      db()
        .select()
        .from(workflowUserAutomationThreads)
        .where(eq(workflowUserAutomationThreads.workflowId, scope.workflowId)),
      db()
        .select({ credits: orgMetadata.credits })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, scope.orgId)),
    ]);
  return {
    usageEvents: usageEvents.length,
    allowanceWindows: allowanceWindows.length,
    runs: runs.length,
    emails: emails.length,
    automationThreads: threads.length,
    credits: metadata[0]?.credits ?? null,
  };
}

function ownerRows(owner: MorningBriefGenerationOwner) {
  return and(
    eq(morningBriefGenerations.orgId, owner.orgId),
    eq(morningBriefGenerations.userId, owner.userId),
  );
}

/**
 * Move one slot's reservation deadline into the past, as a lapse would.
 *
 * The whole instant triple moves together because the row's own constraints
 * require a reservation and a retention deadline strictly after the instant it
 * was reserved at; rewriting one field alone would describe a row the schema
 * never permits.
 */
export async function expireMorningBriefGenerationReservation(
  owner: MorningBriefGenerationOwner,
  at: Date,
): Promise<void> {
  await db()
    .update(morningBriefGenerations)
    .set({
      reservedAt: new Date(at.getTime() - 60_000),
      reservationExpiresAt: at,
    })
    .where(ownerRows(owner));
}

/** Move one slot's retention deadline into the past, as elapsed time would. */
export async function expireMorningBriefGenerationRetention(
  owner: MorningBriefGenerationOwner,
  at: Date,
): Promise<void> {
  await db()
    .update(morningBriefGenerations)
    .set({
      reservedAt: new Date(at.getTime() - 60_000),
      reservationExpiresAt: new Date(at.getTime() - 30_000),
      expiresAt: at,
    })
    .where(ownerRows(owner));
}

/**
 * Make every owner-state update for this owner fail, as a real fault would.
 *
 * The reservation INSERT still succeeds, so this reproduces the exact ordering
 * the contract cares about: the provider was reached and its receipt was
 * written, and only the owner-scoped commit failed. Returns the restore that
 * removes the fault.
 */
export async function failMorningBriefGenerationUpdates(
  owner: MorningBriefGenerationOwner,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  const digest = ownerDigest(owner);
  const functionName = `test_mb_generation_fault_${randomUUID().replaceAll("-", "")}`;
  const triggerName = `mbg_fault_${digest}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
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
          RAISE EXCEPTION 'injected morning brief generation update fault';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    signal.throwIfAborted();
    await tx.execute(sql`
      CREATE TRIGGER ${sql.identifier(triggerName)}
      BEFORE UPDATE ON morning_brief_generations
      FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(functionName)}()
    `);
    signal.throwIfAborted();
  });

  let restored = false;
  const restore = async () => {
    if (restored) {
      return;
    }
    restored = true;
    await db().transaction(async (tx) => {
      await tx.execute(
        sql`DROP TRIGGER ${sql.identifier(triggerName)} ON morning_brief_generations`,
      );
      await tx.execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
    });
  };
  onTestFinished(restore);
  return restore;
}

/**
 * Hold this owner's durable member row exclusively.
 *
 * Every guarded generation write takes `FOR KEY SHARE` on that row first, so
 * this suspends a persistence attempt at exactly the lock it really waits on.
 * It is the production wait, not a sleep, which is what makes "the reservation
 * expired while persistence was blocked" a reproducible ordering rather than a
 * timing hope.
 */
export async function holdMorningBriefOwnerRow(
  owner: MorningBriefGenerationOwner,
  signal: AbortSignal,
): Promise<{
  readonly waitForArrival: () => Promise<number>;
  readonly release: () => Promise<void>;
}> {
  const held = await holdDeferredRow(signal, async (tx) => {
    await tx.execute(
      sql`SELECT 1 FROM org_members_metadata
          WHERE org_id = ${owner.orgId} AND user_id = ${owner.userId}
          FOR UPDATE`,
    );
  });
  onTestFinished(held.release);
  return { waitForArrival: held.waitForBlocked, release: held.release };
}

function ownerDigest(owner: MorningBriefGenerationOwner): string {
  return createHash("sha256")
    .update(`${owner.orgId}:${owner.userId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function generationDigest(generationId: string): string {
  return createHash("sha256")
    .update(generationId, "utf8")
    .digest("hex")
    .slice(0, 32);
}

interface ReceiptWriteBarrier {
  readonly waitForArrival: () => Promise<number>;
  readonly release: () => Promise<void>;
}

/**
 * Make receipt writes for one invocation fail, wait, or both.
 *
 * The receipt table carries no owner identity by design, so this scopes itself
 * to the provider generation id the test scripted: the trigger hashes
 * `NEW.provider_generation_id` and compares it to a digest carried in its own
 * `TG_NAME`, exactly as the owner-scoped fixtures above do, so no caller text
 * reaches the DDL and a concurrent suite's receipts are untouched.
 *
 * `failures` is how many matching writes fail before storage recovers. The
 * counter is a sequence, so it keeps counting across the aborted transactions
 * the failures produce — which is what makes "the second attempt succeeds" a
 * fact rather than a hope.
 *
 * `suspend` blocks each matching write inside the trigger on an advisory lock
 * this fixture holds. That is a real PostgreSQL wait on a real write, so a test
 * can cancel a request while its receipt INSERT is genuinely in progress and
 * observe arrival through `pg_blocking_pids` rather than a sleep.
 */
export async function interceptPlatformGenerationReceiptWrites(
  options: {
    readonly generationId: string;
    readonly failures?: number;
    readonly suspend?: boolean;
  },
  signal: AbortSignal,
): Promise<{
  readonly barrier: ReceiptWriteBarrier | null;
  readonly restore: () => Promise<void>;
}> {
  const failures = options.failures ?? 0;
  if (!Number.isInteger(failures) || failures < 0 || failures > 99) {
    throw new Error(`Invalid receipt failure count: ${String(failures)}`);
  }
  const digest = generationDigest(options.generationId);
  const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
  // `mbr_fault_<digest>_<nonce>_<failures>`, 58 characters at most so
  // PostgreSQL never truncates it. Fields 3, 4 and 5 are read back out of
  // `TG_NAME` by the body, so nothing is interpolated into a function body that
  // cannot carry driver parameters, exactly as the fixtures above do.
  const triggerName = `mbr_fault_${digest}_${nonce}_${String(failures)}`;
  const functionName = `test_mb_receipt_fault_${nonce}`;
  const sequenceName = `test_mb_receipt_seq_${nonce}`;
  await db().transaction(async (tx) => {
    await tx.execute(
      sql`CREATE SEQUENCE ${sql.identifier(sequenceName)} START WITH 1`,
    );
    signal.throwIfAborted();
    await tx.execute(sql`
      CREATE FUNCTION ${sql.identifier(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF substring(
             encode(
               sha256(
                 convert_to(coalesce(NEW.provider_generation_id, ''), 'UTF8')
               ),
               'hex'
             ) from 1 for 32
           ) = split_part(TG_NAME, '_', 3) THEN
          PERFORM pg_advisory_xact_lock(
            hashtextextended(
              'morning-brief-receipt-write:' || split_part(TG_NAME, '_', 3), 0
            )
          );
          IF nextval(
               ('test_mb_receipt_seq_' || split_part(TG_NAME, '_', 4))::regclass
             ) <= split_part(TG_NAME, '_', 5)::bigint THEN
            RAISE EXCEPTION 'injected morning brief receipt write fault';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    signal.throwIfAborted();
    await tx.execute(sql`
      CREATE TRIGGER ${sql.identifier(triggerName)}
      BEFORE INSERT ON morning_brief_platform_generation_receipts
      FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(functionName)}()
    `);
    signal.throwIfAborted();
  });

  let restored = false;
  const restore = async () => {
    if (restored) {
      return;
    }
    restored = true;
    await db().transaction(async (tx) => {
      await tx.execute(
        sql`DROP TRIGGER ${sql.identifier(triggerName)} ON morning_brief_platform_generation_receipts`,
      );
      await tx.execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
      await tx.execute(sql`DROP SEQUENCE ${sql.identifier(sequenceName)}`);
    });
  };

  if (!options.suspend) {
    onTestFinished(restore);
    return { barrier: null, restore };
  }
  const held = await holdDeferredRow(signal, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`morning-brief-receipt-write:${digest}`}, 0))`,
    );
  });
  // Registered after the hold, so this runs first and frees any suspended
  // write before the trigger's exclusive-lock drop.
  onTestFinished(async () => {
    await held.release();
    await restore();
  });
  return {
    barrier: { waitForArrival: held.waitForBlocked, release: held.release },
    restore,
  };
}

async function installReservationTrigger(
  digest: string,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  const functionName = `test_mb_generation_reserve_${randomUUID().replaceAll("-", "")}`;
  // `mbg_reserve_<digest>_<nonce>`: the body reads field 3 back out of
  // `TG_NAME`, so caller-supplied text never reaches the DDL, and the nonce
  // keeps two fixtures for one owner from colliding.
  const triggerName = `mbg_reserve_${digest}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
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
              'morning-brief-generation-reserve:' || split_part(TG_NAME, '_', 3), 0
            )
          );
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    signal.throwIfAborted();
    await tx.execute(sql`
      CREATE TRIGGER ${sql.identifier(triggerName)}
      AFTER INSERT ON morning_brief_generations
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
        sql`DROP TRIGGER ${sql.identifier(triggerName)} ON morning_brief_generations`,
      );
      await tx.execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
    });
  };
}

/**
 * Suspend this owner's reservation after its INSERT and before its COMMIT.
 *
 * A suspended attempt has collected Slack, finalized its occurrence and written
 * its generation slot — none of it committed. Whether the provider has been
 * contacted while the transaction is held is exactly the barrier this fixture
 * makes observable.
 */
export async function holdMorningBriefGenerationReservation(
  owner: MorningBriefGenerationOwner,
  signal: AbortSignal,
): Promise<{
  readonly waitForArrival: () => Promise<number>;
  readonly release: () => Promise<void>;
}> {
  const digest = ownerDigest(owner);
  const dropTrigger = await installReservationTrigger(digest, signal);
  const held = await holdDeferredRow(signal, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`morning-brief-generation-reserve:${digest}`}, 0))`,
    );
  });
  // Registered after the hold, so this runs first and frees any suspended
  // attempt before the trigger's exclusive-lock drop.
  onTestFinished(async () => {
    await held.release();
    await dropTrigger();
  });
  return { waitForArrival: held.waitForBlocked, release: held.release };
}
