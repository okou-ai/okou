import { randomUUID } from "node:crypto";

import { agents } from "@okouai/db/schema/agent";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { db } from "../lib/db";

/**
 * Canonical legacy Morning Brief state, seeded the way Settings writes it.
 *
 * Installing through the Settings surface would require the whole Official
 * Workflow catalog, so this writes the same rows that surface produces: the
 * member's durable timezone, the Agent, the installation and its reconciled
 * daily schedule. The collector still reads every one of them through the
 * canonical state reader, so none of its authority is bypassed here.
 *
 * Shared with the other Morning Brief source slices once one of them lands on
 * `main`; whichever merges first owns the shared fixture and the later one
 * converges onto it.
 */

interface MorningBriefOwner {
  readonly orgId: string;
  readonly userId: string;
}

interface InstalledMorningBrief {
  readonly owner: MorningBriefOwner;
  readonly agentId: string;
  readonly workflowId: string;
  readonly automationId: string;
}

export async function seedInstalledMorningBrief(options: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId?: string;
  readonly timezone?: string | null;
  readonly enabled?: boolean;
  readonly agentVisibility?: "public" | "private";
  readonly agentOwner?: string;
}): Promise<InstalledMorningBrief> {
  const owner = { orgId: options.orgId, userId: options.userId };
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
  let agentId = options.agentId;
  if (agentId === undefined) {
    agentId = randomUUID();
    await db()
      .insert(agents)
      .values({
        id: agentId,
        orgId: owner.orgId,
        owner: options.agentOwner ?? owner.userId,
        name: `brief-${agentId.slice(0, 8)}`,
        visibility: options.agentVisibility ?? "public",
      });
    const created = agentId;
    onTestFinished(async () => {
      await db().delete(agents).where(eq(agents.id, created));
    });
  }
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

/** Pause the seeded schedule the way the Settings surface would. */
export async function pauseMorningBriefAutomation(
  automationId: string,
): Promise<void> {
  await db()
    .update(workflowAutomations)
    .set({ enabled: false, nextRunAt: null })
    .where(eq(workflowAutomations.id, automationId));
}
