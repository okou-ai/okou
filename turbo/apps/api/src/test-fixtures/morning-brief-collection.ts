import { createHash, randomUUID } from "node:crypto";

import { agents } from "@okouai/db/schema/agent";
import { morningBriefCollectionOccurrences } from "@okouai/db/schema/morning-brief-collection-occurrence";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { and, asc, eq, sql } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { getApiTestMocks } from "../__tests__/mocks";
import { db } from "../lib/db";
import { nowDate } from "../lib/time";
import { createDeferredPromise } from "../signals/utils";
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

interface InstalledMorningBrief {
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
  // The Official Workflow installer stamps these from the application clock,
  // and the Settings surface's own lifecycle guard later matches `updated_at`
  // exactly. A `DEFAULT now()` stamp carries microseconds a JavaScript `Date`
  // cannot represent, so seeding it that way would make a real preference
  // update unrepresentable against this row.
  const stampedAt = nowDate();
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
      createdAt: stampedAt,
      updatedAt: stampedAt,
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

/** The owner's durable member row, including its revocation stamp. */
export async function readMorningBriefCollectionOwnerRow(
  owner: MorningBriefCollectionOwner,
) {
  const [row] = await db()
    .select({
      timezone: orgMembersMetadata.timezone,
      revokedAt: orgMembersMetadata.morningBriefCollectionRevokedAt,
    })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, owner.orgId),
        eq(orgMembersMetadata.userId, owner.userId),
      ),
    )
    .limit(1);
  return row;
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

/**
 * Move the installation's Agent out of this member's reach without deleting it.
 *
 * Deletion cascades the occurrence away, which hides every fence behind a
 * foreign key. An access change does not: the Agent row survives, so only a
 * real re-resolution of the installation's authority can notice that the member
 * may no longer act through it.
 *
 * This is a deliberate external-behavior exception. The Agent only stops
 * resolving when it is private *and* owned by somebody else, and no production
 * endpoint transfers Agent ownership — `agentRequestSchema` and
 * `agentMetadataRequestSchema` expose visibility but never an owner — so the
 * state cannot be constructed through the real API. Turning visibility private
 * alone leaves the member as the owner, which still resolves.
 */
export async function restrictMorningBriefAgent(
  agentId: string,
): Promise<void> {
  await db()
    .update(agents)
    .set({ visibility: "private", owner: `user_${randomUUID()}` })
    .where(eq(agents.id, agentId));
}

/**
 * Move the installation onto a different Agent.
 *
 * The occurrence freezes the Agent its installation ran on, so this is the
 * production change an administrator makes when the brief is rebuilt on another
 * Agent — it must not let an occurrence admitted under the old one be reused.
 */
export async function repointMorningBriefInstallationAgent(installation: {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
}): Promise<string> {
  const agentId = randomUUID();
  await db()
    .insert(agents)
    .values({
      id: agentId,
      orgId: installation.orgId,
      owner: installation.userId,
      name: `brief-${agentId.slice(0, 8)}`,
      visibility: "public",
    });
  await db()
    .update(workflows)
    .set({ agentId })
    .where(eq(workflows.id, installation.workflowId));
  onTestFinished(async () => {
    await db().delete(agents).where(eq(agents.id, agentId));
  });
  return agentId;
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

/**
 * Hold this owner's committed occurrence row.
 *
 * Claiming and finalizing both take that row with `FOR UPDATE` before they
 * decide anything, so this is the real database wait a lease deadline can
 * elapse inside. The suspended transition is observed through
 * `pg_blocking_pids`, never a sleep.
 */
export async function holdMorningBriefCollectionOccurrence(
  owner: MorningBriefCollectionOwner,
  signal: AbortSignal,
): Promise<{
  readonly waitForArrival: () => Promise<number>;
  readonly release: () => Promise<void>;
}> {
  const held = await holdDeferredRow(signal, async (tx) => {
    await tx
      .select({ orgId: morningBriefCollectionOccurrences.orgId })
      .from(morningBriefCollectionOccurrences)
      .where(
        and(
          eq(morningBriefCollectionOccurrences.orgId, owner.orgId),
          eq(morningBriefCollectionOccurrences.userId, owner.userId),
        ),
      )
      .for("update");
  });
  return { waitForArrival: held.waitForBlocked, release: held.release };
}

/**
 * Pause a cleanup after its first revocation transaction has committed.
 *
 * Membership, user and organization cleanup all delete this member's Slack
 * connection after they revoke and well before they remove the durable member
 * row an occurrence hangs from. Holding that row therefore freezes each path in
 * exactly the state the fence has to cover: revocation is already durable while
 * the parent — and everything admission reads — still exists, so nothing
 * observed here can be explained by the foreign-key cascade. A plain read still
 * sees the locked row, so admission itself is unaffected.
 */
export async function holdCleanupAfterRevocation(
  connection: { readonly userId: string; readonly workspaceId: string },
  signal: AbortSignal,
): Promise<{
  readonly waitForArrival: () => Promise<number>;
  readonly release: () => Promise<void>;
}> {
  const held = await holdDeferredRow(signal, async (tx) => {
    await tx
      .select({ id: slackOrgConnections.id })
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.userId, connection.userId),
          eq(slackOrgConnections.slackWorkspaceId, connection.workspaceId),
        ),
      )
      .for("update");
  });
  return { waitForArrival: held.waitForBlocked, release: held.release };
}

function isOwnerMembershipLookup(
  args: readonly unknown[],
  owner: MorningBriefCollectionOwner,
): boolean {
  const [query] = args;
  if (typeof query !== "object" || query === null) {
    return false;
  }
  const organizationId =
    "organizationId" in query ? query.organizationId : undefined;
  const userId = "userId" in query ? query.userId : undefined;
  return (
    organizationId === owner.orgId &&
    Array.isArray(userId) &&
    userId.includes(owner.userId)
  );
}

/**
 * Suspend this owner's next exact-member Clerk lookup after it answered.
 *
 * Admission resolves a fresh membership generation before anything is claimed,
 * so a positive answer can be in hand while revocation commits underneath it.
 * The answer is computed from the seeded memberships first and only then held,
 * which is what makes the resumed claim a genuinely stale one rather than a
 * lookup that observed the revocation.
 */
export function holdMorningBriefMembershipLookup(
  owner: MorningBriefCollectionOwner,
  signal: AbortSignal,
): {
  readonly waitForArrival: () => Promise<void>;
  readonly release: () => void;
} {
  const lookup =
    getApiTestMocks().clerk.organizations.getOrganizationMembershipList;
  const answer = lookup.getMockImplementation();
  if (!answer) {
    throw new Error("Expected seeded Clerk organization membership mocks");
  }
  const arrived = createDeferredPromise<void>(signal);
  const released = createDeferredPromise<void>(signal);
  let suspended = false;
  const release = () => {
    if (!released.settled()) {
      released.resolve();
    }
  };
  lookup.mockImplementation(async (...args: unknown[]) => {
    const membership = await answer(...args);
    if (!suspended && isOwnerMembershipLookup(args, owner)) {
      suspended = true;
      arrived.resolve();
      await released.promise;
    }
    return membership;
  });
  onTestFinished(release);
  return {
    waitForArrival: () => {
      return arrived.promise;
    },
    release,
  };
}
