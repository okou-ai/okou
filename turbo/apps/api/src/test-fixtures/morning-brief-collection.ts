import { createHash, randomUUID } from "node:crypto";

import { agents } from "@okouai/db/schema/agent";
import { morningBriefCollectionOccurrences } from "@okouai/db/schema/morning-brief-collection-occurrence";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { and, asc, eq, sql } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { db } from "../lib/db";
import { holdDeferredRow } from "./pi-deferred-lock";

/**
 * Infrastructure-only rendezvous for Morning Brief collection ownership.
 *
 * The route decides *what* is claimed; nothing a caller can send suspends one
 * owner's claim between its INSERT and its COMMIT, which is the exact window a
 * concurrent cleanup has to lose. That is a PostgreSQL lock boundary, so the
 * fixture below forces it and the test proves arrival with `pg_blocking_pids`
 * rather than a sleep.
 *
 * The trigger matches exactly one `(org_id, user_id)` pair through a digest
 * carried in its own `TG_NAME`, and its advisory key is namespaced by that same
 * digest, so a concurrently running suite's owners are never suspended.
 */

interface MorningBriefCollectionOwner {
  readonly orgId: string;
  readonly userId: string;
}

export interface InstalledMorningBrief {
  readonly owner: MorningBriefCollectionOwner;
  readonly agentId: string;
  readonly workflowId: string;
  readonly automationId: string;
}

/**
 * Seed the canonical legacy Morning Brief state a member owns.
 *
 * Installing through the Settings surface would require the whole Official
 * Workflow catalog, so this writes the same rows that surface produces — the
 * member's durable preference row carrying the timezone, the Agent, the
 * installation and its reconciled daily schedule. The collector still reads all
 * of it through the canonical state reader, so nothing about its authority is
 * bypassed here.
 */
export async function seedInstalledMorningBrief(options: {
  readonly orgId: string;
  readonly userId: string;
  readonly timezone?: string | null;
  readonly enabled?: boolean;
  readonly agentVisibility?: "public" | "private";
  readonly agentOwner?: string;
}): Promise<InstalledMorningBrief> {
  const owner = { orgId: options.orgId, userId: options.userId };
  const agentId = randomUUID();
  // An explicit `null` seeds a member who never chose a timezone; `undefined`
  // takes the default an enabled brief would already have.
  const timezone =
    options.timezone === undefined ? "Asia/Shanghai" : options.timezone;
  await db()
    .insert(orgMembersCache)
    .values({ ...owner, role: "member" })
    .onConflictDoNothing();
  await db()
    .insert(orgMembersMetadata)
    .values({ ...owner, timezone })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: { timezone },
    });
  await db()
    .insert(agents)
    .values({
      id: agentId,
      orgId: owner.orgId,
      owner: options.agentOwner ?? owner.userId,
      name: `brief-${agentId.slice(0, 8)}`,
      visibility: options.agentVisibility ?? "public",
    });
  const [workflow] = await db()
    .insert(workflows)
    .values({
      orgId: owner.orgId,
      agentId,
      name: "morning-brief",
      visibility: "private",
      ownerUserId: owner.userId,
      officialDefinitionName: "morning-brief",
      officialInstallationState: "installed",
      createdBy: owner.userId,
      updatedBy: owner.userId,
    })
    .returning({ id: workflows.id });
  if (!workflow) {
    throw new Error("Expected a seeded Morning Brief installation");
  }
  const [automation] = await db()
    .insert(workflowAutomations)
    .values({
      orgId: owner.orgId,
      workflowId: workflow.id,
      ownerUserId: owner.userId,
      kind: "schedule",
      scheduleType: "cron",
      cronExpression: "0 7 * * *",
      timezone: timezone ?? "Asia/Shanghai",
      enabled: options.enabled ?? true,
      nextRunAt:
        options.enabled === false ? null : new Date("2026-09-18T23:00:00.000Z"),
      officialBlueprintKey: "daily-delivery",
      officialAppliedFingerprint: "f".repeat(64),
      officialReconciliationStatus: "current",
      officialParameterBindings: [],
      officialIntendedEnabled: options.enabled ?? true,
      officialResultEmailEnabled: true,
    })
    .returning({ id: workflowAutomations.id });
  if (!automation) {
    throw new Error("Expected a seeded Morning Brief schedule");
  }
  onTestFinished(async () => {
    await db().delete(agents).where(eq(agents.id, agentId));
    await db()
      .delete(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, owner.orgId),
          eq(orgMembersMetadata.userId, owner.userId),
        ),
      );
    await db()
      .delete(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, owner.orgId),
          eq(orgMembersCache.userId, owner.userId),
        ),
      );
  });
  return {
    owner,
    agentId,
    workflowId: workflow.id,
    automationId: automation.id,
  };
}

/** Every occurrence this owner holds, oldest attempt order, for assertions. */
export async function readMorningBriefCollectionOccurrences(
  owner: MorningBriefCollectionOwner,
) {
  return await db()
    .select()
    .from(morningBriefCollectionOccurrences)
    .where(
      and(
        eq(morningBriefCollectionOccurrences.orgId, owner.orgId),
        eq(morningBriefCollectionOccurrences.userId, owner.userId),
      ),
    )
    .orderBy(asc(morningBriefCollectionOccurrences.scheduledFor));
}

/**
 * Delete the Agent an installation runs on.
 *
 * The Agent lifecycle deletion this stands in for is what the occurrence's
 * foreign key is for, so the test exercises the constraint directly rather than
 * asserting that some other service would have removed the row.
 */
export async function deleteMorningBriefAgent(agentId: string): Promise<void> {
  await db().delete(agents).where(eq(agents.id, agentId));
}

/** Pause the seeded schedule the way the Settings surface would. */
export async function pauseMorningBriefAutomation(
  automationId: string,
): Promise<void> {
  await db()
    .update(workflowAutomations)
    .set({ enabled: false, nextRunAt: null })
    .where(eq(workflowAutomations.id, automationId));
}

function ownerDigest(owner: MorningBriefCollectionOwner): string {
  return createHash("sha256")
    .update(`${owner.orgId}:${owner.userId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

async function installClaimTrigger(
  digest: string,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  const functionName = `test_mb_collection_claim_${randomUUID().replaceAll("-", "")}`;
  // `mbc_claim_<digest>_<nonce>`: the body reads field 3 back out of `TG_NAME`,
  // so caller-supplied text never reaches the DDL, and the nonce keeps two
  // fixtures for one owner from colliding.
  const triggerName = `mbc_claim_${digest}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
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
              'morning-brief-collection-claim:' || split_part(TG_NAME, '_', 3), 0
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
      AFTER INSERT ON morning_brief_collection_occurrences
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
        sql`DROP TRIGGER ${sql.identifier(triggerName)} ON morning_brief_collection_occurrences`,
      );
      await tx.execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
    });
  };
}

/**
 * Suspend this owner's first claim after its INSERT and before its COMMIT.
 *
 * A suspended claimant has already admitted its erasure subjects, locked and
 * rechecked its durable member row with `FOR KEY SHARE`, and written the
 * occurrence — none of it committed. That is the window where a concurrent
 * membership cleanup must either wait for the commit and then cascade the row
 * away, or find no parent at all.
 */
export async function holdMorningBriefCollectionClaim(
  owner: MorningBriefCollectionOwner,
  signal: AbortSignal,
): Promise<{
  readonly waitForArrival: () => Promise<number>;
  readonly release: () => Promise<void>;
}> {
  const digest = ownerDigest(owner);
  const dropTrigger = await installClaimTrigger(digest, signal);
  const held = await holdDeferredRow(signal, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`morning-brief-collection-claim:${digest}`}, 0))`,
    );
  });
  // Registered after the hold, so this runs first and frees any suspended
  // claimant before the trigger's exclusive-lock drop.
  onTestFinished(async () => {
    await held.release();
    await dropTrigger();
  });
  return { waitForArrival: held.waitForBlocked, release: held.release };
}
