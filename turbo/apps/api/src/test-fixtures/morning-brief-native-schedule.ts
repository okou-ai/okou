import { createHash, randomUUID } from "node:crypto";

import { chatEvents } from "@okouai/db/schema/chat-event";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief-delivery";
import { morningBriefGenerations } from "@okouai/db/schema/morning-brief-generation";
import {
  morningBriefNativeOccurrences,
  morningBriefNativeSchedules,
} from "@okouai/db/schema/morning-brief-native-schedule";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { userCache } from "@okouai/db/schema/user-cache";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { and, eq, sql } from "drizzle-orm";
import { onTestFinished } from "vitest";

import {
  buildOneClickUnsubscribeUrl,
  buildUnsubscribeHeaders,
} from "../signals/services/email-common.service";
import { db } from "../lib/db";
import { now } from "../lib/time";
import { purgeExpiredMorningBriefGenerations } from "../signals/services/morning-brief-generation-store.service";
import { loadResumableOccurrences } from "../signals/services/morning-brief-native-schedule.service";
import { holdDeferredRow } from "./pi-deferred-lock";

/**
 * Infrastructure the native Morning Brief cron suite needs and no production
 * endpoint exposes.
 *
 * The scheduler's durable state has no HTTP surface by design: the cron is the
 * only caller, and the contract it is asserted against is about rows a crashed
 * worker leaves behind. These helpers therefore read those rows and reconstruct
 * exact interruption states. They never seed a generation or delivery result —
 * every brief the suite observes is produced by the real pipeline through the
 * registered cron route.
 */

interface MorningBriefNativeOwner {
  readonly orgId: string;
  readonly userId: string;
}

export async function readNativeSchedule(owner: MorningBriefNativeOwner) {
  const [row] = await db()
    .select()
    .from(morningBriefNativeSchedules)
    .where(
      and(
        eq(morningBriefNativeSchedules.orgId, owner.orgId),
        eq(morningBriefNativeSchedules.userId, owner.userId),
      ),
    )
    .limit(1);
  return row;
}

export async function deleteLegacyMorningBriefInstallation(
  workflowId: string,
): Promise<void> {
  await db().delete(workflows).where(eq(workflows.id, workflowId));
}

/**
 * Reconstruct a member whose installed legacy brief has no durable row yet.
 *
 * Every current creation route materializes the row as part of enrollment, so
 * no external API can leave an installed member in the pre-migration state the
 * bootstrap scan actually exists for. The installation, its automation and any
 * journaled occurrence stay exactly as the real routes committed them; only the
 * durable row this member was not migrated into yet is removed.
 */
export async function removeMorningBriefNativeScheduleForMigrationFixture(
  owner: MorningBriefNativeOwner,
): Promise<void> {
  const removed = await db()
    .delete(morningBriefNativeSchedules)
    .where(
      and(
        eq(morningBriefNativeSchedules.orgId, owner.orgId),
        eq(morningBriefNativeSchedules.userId, owner.userId),
      ),
    )
    .returning({ userId: morningBriefNativeSchedules.userId });
  if (removed.length !== 1) {
    throw new Error("Expected one materialized Morning Brief row to remove");
  }
}

/**
 * Hold the real bootstrap at the statement that publishes the first row.
 *
 * By this point the production transaction has already taken the owner key and
 * sampled the legacy state it is about to publish, which is the exact instant a
 * selected legacy writer must not be able to slip past. No endpoint can stop a
 * tick here, so an owner-scoped trigger parks the insert on an advisory lock the
 * fixture holds.
 */
export async function holdMorningBriefFirstMaterialization(
  owner: MorningBriefNativeOwner,
  signal: AbortSignal,
): Promise<{
  readonly waitForBlocked: (minimum?: number) => Promise<number>;
  readonly release: () => Promise<void>;
}> {
  const digest = nativeOwnerDigest(owner);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  const functionName = `test_mb_first_materialization_${suffix}`;
  const triggerName = `mbm_hold_${digest}_${suffix}`;
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
              'morning-brief-first-materialization:' || split_part(TG_NAME, '_', 3),
              0
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
      BEFORE INSERT ON morning_brief_native_schedules
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
        sql`DROP TRIGGER ${sql.identifier(triggerName)} ON morning_brief_native_schedules`,
      );
      await tx.execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
    });
  };
  const held = await holdDeferredRow(signal, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`morning-brief-first-materialization:${digest}`}, 0))`,
    );
  });
  onTestFinished(async () => {
    await held.release();
    await restore();
  });
  return { waitForBlocked: held.waitForBlocked, release: held.release };
}

/**
 * Hold the selected legacy automation row so a writer stops with durable
 * authority already decided.
 *
 * Every selected legacy writer takes durable authority — the owner key while no
 * row exists — before this row, so a transaction parked here has finished the
 * classification under test and nothing else. The returned pid is the waiter,
 * which lets a caller chain the next observation onto it.
 */
export async function holdSelectedMorningBriefAutomationRow(
  automationId: string,
  signal: AbortSignal,
): Promise<{
  readonly waitForBlocked: (minimum?: number) => Promise<number>;
  readonly release: () => Promise<void>;
}> {
  const held = await holdDeferredRow(signal, async (tx) => {
    const rows = await tx
      .select({ id: workflowAutomations.id })
      .from(workflowAutomations)
      .where(eq(workflowAutomations.id, automationId))
      .for("update");
    if (rows.length !== 1) {
      throw new Error("Expected one selected Morning Brief automation row");
    }
  });
  return { waitForBlocked: held.waitForBlocked, release: held.release };
}

export async function readNativeOccurrences(owner: MorningBriefNativeOwner) {
  return await db()
    .select()
    .from(morningBriefNativeOccurrences)
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
      ),
    );
}

export async function readNativeGenerations(owner: MorningBriefNativeOwner) {
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

export async function readNativeDeliveries(owner: MorningBriefNativeOwner) {
  return await db()
    .select()
    .from(morningBriefDeliveries)
    .where(
      and(
        eq(morningBriefDeliveries.orgId, owner.orgId),
        eq(morningBriefDeliveries.userId, owner.userId),
      ),
    );
}

export async function readLegacyAutomation(automationId: string) {
  const [row] = await db()
    .select()
    .from(workflowAutomations)
    .where(eq(workflowAutomations.id, automationId))
    .limit(1);
  return row;
}

/**
 * Reproduce the durable pause/restore states written by Official reconciliation.
 * The cron remains the public boundary under test; no endpoint exposes a way to
 * stop between those two production transactions.
 */
export async function setLegacyReconciliationState(
  automationId: string,
  state: "paused" | "current",
): Promise<void> {
  await db()
    .update(workflowAutomations)
    .set(
      state === "paused"
        ? {
            enabled: false,
            nextRunAt: null,
            officialReconciliationStatus: "needs_reconfiguration",
          }
        : {
            enabled: true,
            nextRunAt: null,
            officialReconciliationStatus: "current",
          },
    )
    .where(eq(workflowAutomations.id, automationId));
}

export async function readThreadEventTypes(
  chatThreadId: string,
): Promise<readonly string[]> {
  const rows = await db()
    .select({ eventType: chatEvents.eventType })
    .from(chatEvents)
    .where(eq(chatEvents.chatThreadId, chatThreadId));
  return rows.map((row) => {
    return row.eventType;
  });
}

export async function countEmailOutboxRows(outboxId: string): Promise<number> {
  const rows = await db()
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(eq(emailOutbox.id, outboxId));
  return rows.length;
}

/** Zero agent Runs is part of the product contract, so the suite asserts it. */
export async function countOrgAgentRuns(orgId: string): Promise<number> {
  const rows = await db()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.orgId, orgId));
  return rows.length;
}

export async function seedRecipientAddress(
  userId: string,
  email: string,
): Promise<void> {
  await db()
    .insert(userCache)
    .values({ userId, email, name: "Test Member", cachedAt: new Date(now()) })
    .onConflictDoNothing();
}

/** Make the member's native obligation due right now. */
export async function makeNativeOccurrenceDue(
  owner: MorningBriefNativeOwner,
): Promise<Date> {
  const due = new Date(now() - 60 * 1000);
  await db()
    .update(morningBriefNativeSchedules)
    .set({ nextRunAt: due, scheduleOwner: "native" })
    .where(
      and(
        eq(morningBriefNativeSchedules.orgId, owner.orgId),
        eq(morningBriefNativeSchedules.userId, owner.userId),
      ),
    );
  return due;
}

function nativeOwnerDigest(owner: MorningBriefNativeOwner): string {
  return createHash("sha256")
    .update(`${owner.orgId}:${owner.userId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

async function installNativeOccurrenceInterruption(
  owner: MorningBriefNativeOwner,
  mode: "settlement" | "delivery-clear",
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  const digest = nativeOwnerDigest(owner);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  const functionName = `test_mb_native_${mode.replace("-", "_")}_${suffix}`;
  const triggerName = `mbn_${mode === "settlement" ? "settle" : "clear"}_${digest}_${suffix}`;
  const interrupted =
    mode === "settlement"
      ? sql`OLD.delivery_pending = true
            AND OLD.generation_attempt_id IS NOT NULL
            AND OLD.settled_at IS NULL
            AND NEW.settled_at IS NOT NULL`
      : sql`OLD.delivery_pending = true
            AND OLD.settled_at IS NOT NULL
            AND NEW.delivery_pending = false`;

  await db().transaction(async (tx) => {
    await tx.execute(sql`
      CREATE FUNCTION ${sql.identifier(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF substring(
             encode(
               sha256(convert_to(OLD.org_id || ':' || OLD.user_id, 'UTF8')),
               'hex'
             ) from 1 for 32
           ) = split_part(TG_NAME, '_', 3)
           AND ${interrupted} THEN
          RETURN NULL;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    signal.throwIfAborted();
    await tx.execute(sql`
      CREATE TRIGGER ${sql.identifier(triggerName)}
      BEFORE UPDATE ON morning_brief_native_occurrences
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
        sql`DROP TRIGGER ${sql.identifier(triggerName)} ON morning_brief_native_occurrences`,
      );
      await tx.execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
    });
  };
  onTestFinished(restore);
  return restore;
}

/**
 * Interrupt only the native settlement statement after a bound S5 attempt.
 *
 * Returning `NULL` from this owner-scoped PostgreSQL trigger makes the real CAS
 * affect zero rows. S5 and any S6 receipt have already committed in earlier
 * transactions, while the native occurrence remains claimed and pending — the
 * exact restart state this suite needs without seeding a generation outcome.
 */
export async function interruptNativeSettlementAfterGeneration(
  owner: MorningBriefNativeOwner,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  return await installNativeOccurrenceInterruption(owner, "settlement", signal);
}

/** Keep settled delivery obligations pending while a test builds a full batch. */
export async function suppressNativeDeliveryRecovery(
  owner: MorningBriefNativeOwner,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  return await installNativeOccurrenceInterruption(
    owner,
    "delivery-clear",
    signal,
  );
}

/**
 * Hold S6 at its final delivery-receipt insert.
 *
 * Every content and retention check has passed by this statement, and the S6
 * transaction already holds the native schedule row. A competing recovery can
 * therefore read the pre-commit absence and then be observed waiting on the
 * exact lock whose release makes that receipt durable.
 */
export async function holdNativeDeliveryReceiptCommit(
  owner: MorningBriefNativeOwner,
  signal: AbortSignal,
): Promise<{
  readonly waitForBlocked: () => Promise<number>;
  readonly release: () => Promise<void>;
}> {
  const digest = nativeOwnerDigest(owner);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  const functionName = `test_mb_delivery_hold_${suffix}`;
  const triggerName = `mbd_hold_${digest}_${suffix}`;
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
              'morning-brief-delivery-commit:' || split_part(TG_NAME, '_', 3),
              0
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
      BEFORE INSERT ON morning_brief_deliveries
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
        sql`DROP TRIGGER ${sql.identifier(triggerName)} ON morning_brief_deliveries`,
      );
      await tx.execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
    });
  };
  const held = await holdDeferredRow(signal, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`morning-brief-delivery-commit:${digest}`}, 0))`,
    );
  });
  onTestFinished(async () => {
    await held.release();
    await restore();
  });
  return { waitForBlocked: held.waitForBlocked, release: held.release };
}

/** Hold the real schedule parent row so competing recovery ticks both arrive. */
export async function holdNativeScheduleRow(
  owner: MorningBriefNativeOwner,
  signal: AbortSignal,
): Promise<{
  readonly waitForBlocked: (minimum?: number) => Promise<number>;
  readonly release: () => Promise<void>;
}> {
  const held = await holdDeferredRow(signal, async (tx) => {
    await tx
      .select({ userId: morningBriefNativeSchedules.userId })
      .from(morningBriefNativeSchedules)
      .where(
        and(
          eq(morningBriefNativeSchedules.orgId, owner.orgId),
          eq(morningBriefNativeSchedules.userId, owner.userId),
        ),
      )
      .for("update");
  });
  return { waitForBlocked: held.waitForBlocked, release: held.release };
}

/** Install a newer epoch with its own future obligation, as replacement does. */
export async function replaceNativeEpochWithFutureObligation(
  owner: MorningBriefNativeOwner,
): Promise<{ readonly ownerEpoch: number; readonly nextRunAt: Date }> {
  const nextRunAt = new Date(now() + 24 * 60 * 60 * 1000);
  const [row] = await db()
    .update(morningBriefNativeSchedules)
    .set({
      ownerEpoch: sql`${morningBriefNativeSchedules.ownerEpoch} + 1`,
      nextRunAt,
      scheduleOwner: "native",
      updatedAt: new Date(now()),
    })
    .where(
      and(
        eq(morningBriefNativeSchedules.orgId, owner.orgId),
        eq(morningBriefNativeSchedules.userId, owner.userId),
      ),
    )
    .returning({ ownerEpoch: morningBriefNativeSchedules.ownerEpoch });
  if (row === undefined) {
    throw new Error("Expected a native schedule to replace");
  }
  return { ownerEpoch: row.ownerEpoch, nextRunAt };
}

/** Run the real bounded retention purge for this test owner only. */
export async function purgeExpiredNativeGenerations(
  owner: MorningBriefNativeOwner,
): Promise<number> {
  return await purgeExpiredMorningBriefGenerations(db(), new Date(now()), 25, [
    owner,
  ]);
}

/**
 * Reconstruct the exact state a worker leaves behind when it dies after the
 * Chat receipt COMMIT and before its own native settlement.
 *
 * The obligation is still held by the occurrence, the claimant's lease is still
 * recorded, and the settlement never ran. No delivered content is fabricated:
 * the Chat event, its receipt and the email intent are the ones the real
 * pipeline already committed.
 */
export async function interruptNativeSettlement(
  owner: MorningBriefNativeOwner,
  args: { readonly scheduledFor: Date; readonly leaseToken: string },
): Promise<void> {
  await db()
    .update(morningBriefNativeSchedules)
    .set({ nextRunAt: null, scheduleOwner: null })
    .where(
      and(
        eq(morningBriefNativeSchedules.orgId, owner.orgId),
        eq(morningBriefNativeSchedules.userId, owner.userId),
      ),
    );
  await db()
    .update(morningBriefNativeOccurrences)
    .set({
      settledAt: null,
      settledNextRunAt: null,
      outcome: null,
      state: "claimed",
      deliveryPending: true,
      leaseToken: args.leaseToken,
      leaseExpiresAt: new Date(now() - 60 * 1000),
    })
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
        eq(morningBriefNativeOccurrences.scheduledFor, args.scheduledFor),
      ),
    );
}

/**
 * What the resume scan would pick up right now.
 *
 * The receipt-first invariant is a statement about which rows are resumable at
 * all, which no HTTP response exposes; the suite asserts it directly so the
 * property holds independently of how many rows one recovery batch fits. The
 * scan itself is global, so the result is narrowed to the owner under test —
 * other suites share this database.
 */
export async function resumableOccurrenceAnchors(
  owner: MorningBriefNativeOwner,
): Promise<readonly Date[]> {
  const rows = await loadResumableOccurrences(db(), {
    now: new Date(now()),
    limit: 200,
  });
  return rows
    .filter((row) => {
      return row.orgId === owner.orgId && row.userId === owner.userId;
    })
    .map((row) => {
      return row.scheduledFor;
    });
}

/**
 * Revoke the member's native authority the way a Settings disable does.
 *
 * Bumping the epoch is exactly what `applyMorningBriefLogicalChoice` commits
 * for a disable, so a test can land that revocation at an observed barrier —
 * mid-collection, before the reservation — without sleeping or reaching into
 * the scheduler.
 */
export async function revokeNativeAuthorityForTest(
  owner: MorningBriefNativeOwner,
): Promise<void> {
  await db()
    .update(morningBriefNativeSchedules)
    .set({ ownerEpoch: sql`${morningBriefNativeSchedules.ownerEpoch} + 1` })
    .where(
      and(
        eq(morningBriefNativeSchedules.orgId, owner.orgId),
        eq(morningBriefNativeSchedules.userId, owner.userId),
      ),
    );
}

/**
 * Leave a claimed slot abandoned, the way a worker that died before reaching
 * the provider does: still unsettled, no attempt bound, lease long expired.
 *
 * Unlike {@link interruptNativeSettlement} nothing was delivered here, so this
 * is the work a rollback drain has to reconcile before it can hand the member
 * back to legacy.
 */
export async function abandonClaimedOccurrence(
  owner: MorningBriefNativeOwner,
  scheduledFor: Date,
): Promise<void> {
  await db()
    .update(morningBriefNativeOccurrences)
    .set({
      settledAt: null,
      settledNextRunAt: null,
      outcome: null,
      state: "claimed",
      deliveryPending: false,
      generationAttemptId: null,
      leaseExpiresAt: new Date(now() - 60 * 60 * 1000),
    })
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
        eq(morningBriefNativeOccurrences.scheduledFor, scheduledFor),
      ),
    );
}

/**
 * Every usage row this organization has, which for a Morning Brief must be
 * none.
 *
 * The product contract is that the platform pays: no user or organization
 * credit is admitted, reserved or debited, and no agent Run is created. A Run
 * count alone does not show that, because usage accounting is a separate
 * writer, so the suite snapshots both.
 */
export async function countOrgUsageEvents(orgId: string): Promise<number> {
  const rows = await db()
    .select({ id: usageEvent.id })
    .from(usageEvent)
    .where(eq(usageEvent.orgId, orgId));
  return rows.length;
}

/**
 * Enqueue an unsent legacy result email for this automation.
 *
 * It is the shape the old Run-result callback leaves behind: a real outbox row
 * whose producer identity is the legacy automation, still owed a provider
 * request. The cutover has to treat that as reachable mail work.
 */
export async function enqueueUnsentLegacyEmail(
  automationId: string,
  recipient: string,
  userId: string,
): Promise<string> {
  // The outbox requires a complete producer identity, which is exactly what
  // the legacy Run-result callback supplies.
  const sourceRunId = randomUUID();
  const [row] = await db()
    .insert(emailOutbox)
    .values({
      fromAddress: "briefs@mail.okou.test",
      toAddresses: [recipient],
      subject: "Yesterday's Morning Brief",
      template: {
        template: "official-automation-result",
        props: {
          title: "Yesterday's Morning Brief",
          resultText: "The legacy run already produced this.",
          runUrl: "https://app.okou.test/runs/legacy",
          manageUrl: "https://app.okou.test/settings/morning-brief",
        },
      },
      headers: buildUnsubscribeHeaders(buildOneClickUnsubscribeUrl(userId)),
      sourceRunId,
      sourceWorkflowAutomationId: automationId,
      status: "pending",
    })
    .returning({ id: emailOutbox.id });
  if (row === undefined) {
    throw new Error("Expected an enqueued legacy email");
  }
  return row.id;
}
