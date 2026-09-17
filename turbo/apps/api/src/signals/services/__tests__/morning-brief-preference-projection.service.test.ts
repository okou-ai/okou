import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  projectErasureDecision,
  type ErasureDecision,
} from "@okouai/db/operations/account-erasure";
import { accountErasureJobs } from "@okouai/db/schema/account-erasure";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { morningBriefInstalledPreferences } from "@okouai/db/schema/morning-brief-installed-preference";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import {
  workflowAutomations,
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import {
  holdMorningBriefMembershipRemoval,
  holdMorningBriefProjectionWrite,
  readActiveStatement,
  startMorningBriefMembershipRemoval,
  waitForBlockingPid,
} from "../../../test-fixtures/morning-brief-projection";
import { updateFeatureSwitchesForUser } from "../../routes/__tests__/helpers/feature-switches";
import { loadMorningBriefMigrationState } from "../morning-brief-migration-state.service";
import {
  readMorningBriefPreferenceProjection,
  refreshMorningBriefPreferenceProjection,
} from "../morning-brief-preference-projection.service";

// The Settings routes own every externally constructible case and are covered
// in `routes/__tests__/official-workflows.test.ts`. This suite exists for the
// persisted boundary that has no HTTP ingress: the composite membership fence
// and its two overlapping commit orders, the foreign-key cascades that
// invalidate a copy, erasure admission, whose closure path has no production
// endpoint, and the refresh outcome itself, which no response body exposes.
// Only the outcome distinction — a failed copy is not a healthy skip and not a
// cleared copy — can be checked here, because a projection may serve a read
// only while it still equals the legacy state, so a fresh copy and a missing
// one are deliberately indistinguishable through the API. It asserts real rows
// and real suspended transactions, never helper call counts.
describe("Morning Brief installed preference projection persistence", () => {
  const context = testContext();
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 8 });
  const db = drizzle(pool);
  const jobIds: string[] = [];

  afterAll(async () => {
    if (jobIds.length > 0) {
      await db
        .delete(accountErasureJobs)
        .where(inArray(accountErasureJobs.id, jobIds));
    }
    await pool.end();
  });

  interface InstalledBrief {
    readonly owner: { readonly orgId: string; readonly userId: string };
    readonly agentId: string;
    readonly workflowId: string;
    readonly automationId: string;
  }

  async function seedInstalledBrief(): Promise<InstalledBrief> {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const agentId = randomUUID();
    await db.insert(orgMembersCache).values({ orgId, userId, role: "member" });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      owner: userId,
      name: `brief-${agentId.slice(0, 8)}`,
    });
    const [workflow] = await db
      .insert(workflows)
      .values({
        orgId,
        agentId,
        name: "morning-brief",
        visibility: "private",
        ownerUserId: userId,
        officialDefinitionName: "morning-brief",
        officialInstallationState: "installed",
        createdBy: userId,
        updatedBy: userId,
      })
      .returning({ id: workflows.id });
    if (!workflow) {
      throw new Error("Expected a seeded Morning Brief installation");
    }
    const [automation] = await db
      .insert(workflowAutomations)
      .values({
        orgId,
        workflowId: workflow.id,
        ownerUserId: userId,
        kind: "schedule",
        scheduleType: "cron",
        cronExpression: "0 7 * * *",
        timezone: "Asia/Shanghai",
        enabled: true,
        nextRunAt: new Date("2026-09-17T23:00:00.000Z"),
        officialBlueprintKey: "daily-delivery",
        officialAppliedFingerprint: "f".repeat(64),
        officialReconciliationStatus: "current",
        officialParameterBindings: [],
        officialIntendedEnabled: true,
        officialResultEmailEnabled: true,
      })
      .returning({ id: workflowAutomations.id });
    if (!automation) {
      throw new Error("Expected a seeded Morning Brief schedule");
    }
    onTestFinished(async () => {
      await db.delete(agents).where(eq(agents.id, agentId));
      await db
        .delete(orgMembersCache)
        .where(
          and(
            eq(orgMembersCache.orgId, orgId),
            eq(orgMembersCache.userId, userId),
          ),
        );
    });
    const brief = {
      owner: { orgId, userId },
      agentId,
      workflowId: workflow.id,
      automationId: automation.id,
    };
    await selectSimpleMorningBrief(brief, true);
    return brief;
  }

  async function selectSimpleMorningBrief(
    brief: InstalledBrief,
    enabled: boolean,
  ): Promise<void> {
    await updateFeatureSwitchesForUser(context, brief.owner, {
      [FeatureSwitchKey.SimpleMorningBrief]: enabled,
    });
  }

  async function readProjectionRow(brief: InstalledBrief) {
    const [row] = await db
      .select()
      .from(morningBriefInstalledPreferences)
      .where(
        and(
          eq(morningBriefInstalledPreferences.orgId, brief.owner.orgId),
          eq(morningBriefInstalledPreferences.userId, brief.owner.userId),
        ),
      );
    return row;
  }

  async function refresh(brief: InstalledBrief) {
    return await refreshMorningBriefPreferenceProjection(
      db,
      brief.owner,
      context.signal,
    );
  }

  async function readProjectedPreference(brief: InstalledBrief) {
    const state = await loadMorningBriefMigrationState(db, brief.owner);
    if (state.kind !== "installed") {
      throw new Error(`Expected an installed brief, received ${state.kind}`);
    }
    return await readMorningBriefPreferenceProjection(db, state);
  }

  async function deleteMembershipParent(brief: InstalledBrief) {
    await db
      .delete(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, brief.owner.orgId),
          eq(orgMembersCache.userId, brief.owner.userId),
        ),
      );
  }

  async function readMembershipParent(brief: InstalledBrief) {
    const [parent] = await db
      .select({ orgId: orgMembersCache.orgId })
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, brief.owner.orgId),
          eq(orgMembersCache.userId, brief.owner.userId),
        ),
      );
    return parent;
  }

  function decision(subjectId: string): ErasureDecision {
    return {
      subjectId,
      subjectKind: "user",
      generation: 1,
      authorityId: randomUUID(),
      decisionRef: randomUUID(),
      decisionSequence: 1n,
      confirmationRef: randomUUID(),
      previousDecisionRef: null,
      dispositionVersion: 1,
      requestedAt: nowDate(),
      deadlineAt: new Date("2099-01-01T00:00:00Z"),
    };
  }

  it("serves a copy back only while it still equals its source", async () => {
    const brief = await seedInstalledBrief();
    await expect(refresh(brief)).resolves.toStrictEqual({
      outcome: "refreshed",
    });
    await expect(readProjectionRow(brief)).resolves.toMatchObject({
      projectionVersion: 1,
      workflowId: brief.workflowId,
      automationId: brief.automationId,
      agentId: brief.agentId,
      chatThreadId: null,
      enabled: true,
      cronExpression: "0 7 * * *",
      timezone: "Asia/Shanghai",
    });
    await expect(readProjectedPreference(brief)).resolves.toStrictEqual({
      enabled: true,
      status: "enabled",
      nextRunAt: "2026-09-17T23:00:00.000Z",
      timezone: "Asia/Shanghai",
      unavailableReason: null,
    });

    // The scheduler advances the next run without ever writing this table.
    await db
      .update(workflowAutomations)
      .set({ nextRunAt: new Date("2026-09-18T23:00:00.000Z") })
      .where(eq(workflowAutomations.id, brief.automationId));
    await expect(readProjectedPreference(brief)).resolves.toBeNull();

    // So does an older binary changing the user's choice.
    await refresh(brief);
    await db
      .update(workflowAutomations)
      .set({ enabled: false, nextRunAt: null })
      .where(eq(workflowAutomations.id, brief.automationId));
    await expect(readProjectedPreference(brief)).resolves.toBeNull();
  });

  it("clears the copy when the brief stops being installed", async () => {
    const brief = await seedInstalledBrief();
    await refresh(brief);
    await expect(readProjectionRow(brief)).resolves.toBeDefined();

    await db
      .update(workflows)
      .set({ officialInstallationState: "installing" })
      .where(eq(workflows.id, brief.workflowId));
    await expect(refresh(brief)).resolves.toStrictEqual({ outcome: "cleared" });
    await expect(readProjectionRow(brief)).resolves.toBeUndefined();
  });

  it("writes nothing while the implementation switch is off", async () => {
    const brief = await seedInstalledBrief();
    await refresh(brief);
    const projected = await readProjectionRow(brief);
    if (!projected) {
      throw new Error("Expected a projected row");
    }

    await selectSimpleMorningBrief(brief, false);
    await db
      .update(workflowAutomations)
      .set({ enabled: false, nextRunAt: null })
      .where(eq(workflowAutomations.id, brief.automationId));
    await expect(refresh(brief)).resolves.toStrictEqual({
      outcome: "skipped",
      reason: "feature-disabled",
    });
    // The user's choice lives in the legacy schedule, so switching the
    // implementation off neither rewrites nor discards this stale copy.
    await expect(readProjectionRow(brief)).resolves.toStrictEqual(projected);
  });

  it("never creates or refills a missing membership parent", async () => {
    const brief = await seedInstalledBrief();
    await deleteMembershipParent(brief);

    await expect(refresh(brief)).resolves.toStrictEqual({
      outcome: "skipped",
      reason: "membership-unavailable",
    });
    await expect(readProjectionRow(brief)).resolves.toBeUndefined();
    await expect(readMembershipParent(brief)).resolves.toBeUndefined();
  });

  it("suspends a refresh on the exact parent an uncommitted cleanup holds, then skips it", async () => {
    const cleanupFirst = await seedInstalledBrief();
    const survivor = await seedInstalledBrief();
    await refresh(cleanupFirst);
    await refresh(survivor);

    // The cleanup owns this owner's parent row and has not committed, so the
    // refresh cannot pass its membership recheck.
    const cleanup = await holdMorningBriefMembershipRemoval(
      cleanupFirst.owner,
      context.signal,
    );
    const refreshing = refresh(cleanupFirst);

    // Arrival, not a sleep: PostgreSQL reports a session waiting on the lock
    // this cleanup holds, and that session is running the writer's own
    // `for key share` recheck of `org_members_cache`. The refresh is therefore
    // inside its transaction, past erasure admission, with the copy unwritten.
    const blockedPid = await cleanup.waitForBlocked();
    const blockedStatement = await readActiveStatement(blockedPid);
    expect(blockedStatement).toContain("org_members_cache");
    expect(blockedStatement).toContain("key share");
    await expect(readProjectionRow(cleanupFirst)).resolves.toMatchObject({
      workflowId: cleanupFirst.workflowId,
    });

    await cleanup.release();
    await expect(refreshing).resolves.toStrictEqual({
      outcome: "skipped",
      reason: "membership-unavailable",
    });
    // Neither the parent nor the copy comes back, and the writer never
    // recreates the membership row it just failed to find.
    await expect(readProjectionRow(cleanupFirst)).resolves.toBeUndefined();
    await expect(readMembershipParent(cleanupFirst)).resolves.toBeUndefined();
    await expect(readProjectionRow(survivor)).resolves.toMatchObject({
      workflowId: survivor.workflowId,
      enabled: true,
    });
  });

  it("holds an uncommitted copy while a membership cleanup waits, then loses it to the cascade", async () => {
    const refreshFirst = await seedInstalledBrief();
    const survivor = await seedInstalledBrief();
    await refresh(survivor);

    // Suspend this owner's projection write after the row is written and
    // before COMMIT, while the writer still holds `for key share` on the
    // parent it just rechecked.
    const heldWrite = await holdMorningBriefProjectionWrite(
      refreshFirst.owner,
      {},
      context.signal,
    );
    const refreshing = refresh(refreshFirst);
    const writerPid = await heldWrite.waitForArrival();
    await expect(readProjectionRow(refreshFirst)).resolves.toBeUndefined();

    // The conflicting cleanup really queues behind that transaction: the
    // waiting backend is the suspended writer, not a guess about timing.
    const cleanup = await startMorningBriefMembershipRemoval(
      refreshFirst.owner,
      context.signal,
    );
    await waitForBlockingPid(cleanup.pid, writerPid);

    await heldWrite.release();
    await expect(refreshing).resolves.toStrictEqual({ outcome: "refreshed" });
    await cleanup.committed;

    // The copy committed first and the cleanup then took it away through the
    // membership cascade; nothing refills either row.
    await expect(readProjectionRow(refreshFirst)).resolves.toBeUndefined();
    await expect(readMembershipParent(refreshFirst)).resolves.toBeUndefined();
    await expect(readProjectionRow(survivor)).resolves.toMatchObject({
      workflowId: survivor.workflowId,
      enabled: true,
    });
  });

  it("reports a failed copy when its write fails, and refreshes once the fault is gone", async () => {
    const brief = await seedInstalledBrief();
    await refresh(brief);
    const projected = await readProjectionRow(brief);
    if (!projected) {
      throw new Error("Expected a projected row");
    }

    // A real write failure inside the copy's own transaction, observed at the
    // boundary before it is released into that failure.
    const fault = await holdMorningBriefProjectionWrite(
      brief.owner,
      { failAfterGate: true },
      context.signal,
    );
    await db
      .update(workflowAutomations)
      .set({ enabled: false, nextRunAt: null })
      .where(eq(workflowAutomations.id, brief.automationId));
    const failing = refresh(brief);
    await fault.waitForArrival();
    await fault.release();

    // A failure is neither a healthy skip nor a cleared copy: the outcome is
    // distinct and the stale row is left exactly as the last writer left it.
    await expect(failing).resolves.toStrictEqual({ outcome: "failed" });
    await expect(readProjectionRow(brief)).resolves.toStrictEqual(projected);

    await fault.remove();
    await expect(refresh(brief)).resolves.toStrictEqual({
      outcome: "refreshed",
    });
    await expect(readProjectionRow(brief)).resolves.toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
  });

  it("refuses a new native write once the subject is closed", async () => {
    const brief = await seedInstalledBrief();
    await refresh(brief);
    const projected = await readProjectionRow(brief);
    if (!projected) {
      throw new Error("Expected a projected row");
    }

    const job = await projectErasureDecision(db, decision(brief.owner.userId));
    jobIds.push(job.id);

    // Admission closure is an operational failure, not a healthy projection,
    // and it must never be reported as a fresh copy.
    await expect(refresh(brief)).resolves.toStrictEqual({ outcome: "failed" });
    await expect(readProjectionRow(brief)).resolves.toStrictEqual(projected);
  });

  it("loses the copy with the destination thread and with the owning Agent", async () => {
    const threadBrief = await seedInstalledBrief();
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId: threadBrief.owner.userId,
        agentId: threadBrief.agentId,
        title: "Okou Morning Brief",
      })
      .returning({ id: chatThreads.id });
    if (!thread) {
      throw new Error("Expected a seeded destination thread");
    }
    await db.insert(workflowUserAutomationThreads).values({
      orgId: threadBrief.owner.orgId,
      userId: threadBrief.owner.userId,
      workflowId: threadBrief.workflowId,
      chatThreadId: thread.id,
    });
    await refresh(threadBrief);
    await expect(readProjectionRow(threadBrief)).resolves.toMatchObject({
      chatThreadId: thread.id,
    });

    await db.delete(chatThreads).where(eq(chatThreads.id, thread.id));
    await expect(readProjectionRow(threadBrief)).resolves.toBeUndefined();

    const agentBrief = await seedInstalledBrief();
    await refresh(agentBrief);
    await expect(readProjectionRow(agentBrief)).resolves.toBeDefined();
    await db.delete(agents).where(eq(agents.id, agentBrief.agentId));
    await expect(readProjectionRow(agentBrief)).resolves.toBeUndefined();
  });
});
