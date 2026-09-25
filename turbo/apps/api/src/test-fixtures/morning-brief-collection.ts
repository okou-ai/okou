import { randomUUID } from "node:crypto";

import { agents } from "@okouai/db/schema/agent";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { db } from "../lib/db";
import { nowDate } from "../lib/time";

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
