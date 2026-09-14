import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
  type MorningBriefPreferenceErrorCode,
  type MorningBriefPreferenceResponse,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isValidTimeZone } from "@okouai/core/timezone";
import { agents } from "@okouai/db/schema/agent";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { delay } from "signal-timers";
import { z } from "zod";

import { clerk$ } from "../external/clerk";
import { publishMorningBriefChangedSafely } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { calculateNextRun } from "./time-automation";
import {
  completeMorningBriefEnrollment,
  loadMorningBriefEnrollment,
  morningBriefEnrollmentWhere,
  recordMorningBriefChoice,
  recordMorningBriefMembership,
} from "./morning-brief-enrollment-data.service";
import { executeRawRows } from "../../lib/db-raw-rows";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  installOfficialWorkflow$,
  loadOfficialWorkflowUserTimezone,
} from "./official-workflow-installation.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { reconcileOfficialWorkflowInstallation$ } from "./official-workflow-reconciliation.service";
import {
  disableWorkflowAutomation$,
  enableWorkflowAutomation$,
} from "./workflow-automation.service";
import type { WorkflowMember } from "./workflow-data.service";

const MORNING_BRIEF_LOCK_RETRY_MS = 25;

export type MorningBriefPreferenceFailure = {
  readonly kind: "bad-request" | "conflict";
  readonly code: MorningBriefPreferenceErrorCode;
  readonly message: string;
};

type MorningBriefPreferenceResult =
  | {
      readonly kind: "ok";
      readonly preference: MorningBriefPreferenceResponse;
    }
  | MorningBriefPreferenceFailure;

interface MorningBriefPreferenceArgs {
  readonly orgId: string;
  readonly member: WorkflowMember;
}

interface MorningBriefPreferenceMutationArgs extends MorningBriefPreferenceArgs {
  readonly enabled: boolean;
}

type EnsureMorningBriefDefaultEnabledArgs = MorningBriefPreferenceArgs;

export type EnsureMorningBriefDefaultEnabledResult =
  | {
      readonly outcome: "installed";
      readonly workflowId: string;
    }
  | {
      readonly outcome: "unchanged";
      readonly reason: "existing-installation";
      readonly installationCount: number;
    }
  | {
      readonly outcome: "skipped";
      readonly reason:
        | "not-eligible"
        | "feature-disabled"
        | "missing-timezone"
        | "missing-default-agent"
        | "user-disabled"
        | "membership-unavailable";
    }
  | {
      readonly outcome: "failed";
      readonly reason: "installation-failed";
      readonly failureKind:
        | "bad-request"
        | "not-found"
        | "forbidden"
        | "conflict";
      readonly message: string;
    };

function conflict(
  code: Extract<
    MorningBriefPreferenceErrorCode,
    "MORNING_BRIEF_MULTIPLE_INSTALLATIONS" | "MORNING_BRIEF_STATE_CONFLICT"
  >,
  message: string,
): MorningBriefPreferenceFailure {
  return { kind: "conflict", code, message };
}

function unavailableFailure(
  reason: NonNullable<MorningBriefPreferenceResponse["unavailableReason"]>,
): MorningBriefPreferenceFailure {
  return reason === "missing-timezone"
    ? {
        kind: "bad-request",
        code: "MORNING_BRIEF_MISSING_TIMEZONE",
        message: "Set a valid time zone before enabling Morning Brief.",
      }
    : {
        kind: "bad-request",
        code: "MORNING_BRIEF_MISSING_DEFAULT_AGENT",
        message: "Choose a usable default Agent before enabling Morning Brief.",
      };
}

async function loadUnavailableReason(
  db: ReadonlyDb,
  args: MorningBriefPreferenceArgs,
  installationAgentId?: string,
): Promise<MorningBriefPreferenceResponse["unavailableReason"]> {
  const timezone = await loadOfficialWorkflowUserTimezone(db, {
    orgId: args.orgId,
    userId: args.member.userId,
  });
  if (timezone === null || !isValidTimeZone(timezone)) {
    return "missing-timezone";
  }

  const agentId = installationAgentId ?? (await loadDefaultAgentId(db, args));
  if (agentId === null) {
    return "missing-default-agent";
  }
  return null;
}

async function loadDefaultAgentId(
  db: ReadonlyDb,
  args: MorningBriefPreferenceArgs,
): Promise<string | null> {
  const [defaultAgent] = await db
    .select({
      id: agents.id,
      owner: agents.owner,
      visibility: agents.visibility,
    })
    .from(orgMetadata)
    .leftJoin(
      agents,
      and(
        eq(agents.id, orgMetadata.defaultAgentId),
        eq(agents.orgId, orgMetadata.orgId),
      ),
    )
    .where(eq(orgMetadata.orgId, args.orgId))
    .limit(1);
  if (
    !defaultAgent?.id ||
    (defaultAgent.visibility === "private" &&
      defaultAgent.owner !== args.member.userId)
  ) {
    return null;
  }
  return defaultAgent.id;
}

async function loadMorningBriefWorkflowIds(
  db: ReadonlyDb,
  args: MorningBriefPreferenceArgs,
): Promise<
  readonly {
    readonly id: string;
    readonly agentId: string;
    readonly installationState: "installing" | "installed" | null;
  }[]
> {
  return await db
    .select({
      id: workflows.id,
      installationState: workflows.officialInstallationState,
      agentId: workflows.agentId,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.ownerUserId, args.member.userId),
        eq(workflows.visibility, "private"),
        eq(
          workflows.officialDefinitionName,
          MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
        ),
      ),
    );
}

async function loadPendingPreference(
  db: ReadonlyDb,
  args: MorningBriefPreferenceArgs,
  enrollment: Awaited<ReturnType<typeof loadMorningBriefEnrollment>>,
  installationAgentId?: string,
): Promise<MorningBriefPreferenceResult> {
  const [timezone, unavailableReason] = await Promise.all([
    loadOfficialWorkflowUserTimezone(db, {
      orgId: args.orgId,
      userId: args.member.userId,
    }),
    loadUnavailableReason(db, args, installationAgentId),
  ]);
  return {
    kind: "ok",
    preference: {
      enabled:
        enrollment?.state === "pending" || enrollment?.state === "checking",
      status:
        enrollment?.state === "pending" || enrollment?.state === "checking"
          ? enrollment.lastError
            ? "error"
            : "preparing"
          : "paused",
      nextRunAt: null,
      timezone,
      unavailableReason,
    },
  };
}

async function loadInstalledPreference(
  db: ReadonlyDb,
  args: MorningBriefPreferenceArgs,
): Promise<MorningBriefPreferenceResult & { readonly workflowId?: string }> {
  const installations = await loadMorningBriefWorkflowIds(db, args);
  if (installations.length > 1) {
    return conflict(
      "MORNING_BRIEF_MULTIPLE_INSTALLATIONS",
      "Multiple Morning Brief installations exist. Resolve the conflict before changing this preference.",
    );
  }
  const installation = installations[0];
  const enrollment = await loadMorningBriefEnrollment(db, {
    orgId: args.orgId,
    userId: args.member.userId,
  });
  if (
    !installation ||
    (installation.installationState !== "installed" && enrollment !== undefined)
  ) {
    return await loadPendingPreference(
      db,
      args,
      enrollment,
      installation?.agentId,
    );
  }
  if (installation.installationState !== "installed") {
    return conflict(
      "MORNING_BRIEF_STATE_CONFLICT",
      "Morning Brief installation is not ready. Retry after installation completes.",
    );
  }

  const automations = await db
    .select({
      id: workflowAutomations.id,
      enabled: workflowAutomations.enabled,
      nextRunAt: workflowAutomations.nextRunAt,
      timezone: workflowAutomations.timezone,
      kind: workflowAutomations.kind,
      scheduleType: workflowAutomations.scheduleType,
      blueprintKey: workflowAutomations.officialBlueprintKey,
      reconciliationStatus: workflowAutomations.officialReconciliationStatus,
      resultEmailEnabled: workflowAutomations.officialResultEmailEnabled,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.member.userId),
        eq(workflowAutomations.workflowId, installation.id),
      ),
    );
  const automation = automations[0];
  if (
    automations.length !== 1 ||
    !automation ||
    automation.kind !== "schedule" ||
    automation.scheduleType !== "cron" ||
    automation.blueprintKey !== MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY ||
    automation.reconciliationStatus !== "current" ||
    automation.resultEmailEnabled !== true
  ) {
    return conflict(
      "MORNING_BRIEF_STATE_CONFLICT",
      "Morning Brief installation state is inconsistent. Retry after reconciliation completes.",
    );
  }
  return {
    kind: "ok",
    workflowId: installation.id,
    preference: {
      enabled: automation.enabled,
      status: automation.enabled ? "enabled" : "paused",
      nextRunAt: automation.nextRunAt?.toISOString() ?? null,
      timezone: automation.timezone,
      unavailableReason: null,
    },
  };
}

const lockRowSchema = z.object({ acquired: z.boolean() });

async function withMorningBriefPreferenceLock<T>(
  db: Db,
  args: MorningBriefPreferenceArgs,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  while (true) {
    const result = await db.transaction(async (tx) => {
      const rows = await executeRawRows(
        tx,
        sql`SELECT pg_try_advisory_xact_lock(
          hashtextextended(
            ${`morning_brief_preference:${args.orgId}:${args.member.userId}`},
            0
          )
        ) AS acquired`,
        lockRowSchema,
      );
      if (rows[0]?.acquired !== true) {
        return { acquired: false as const };
      }
      signal.throwIfAborted();
      return { acquired: true as const, value: await operation() };
    });
    if (result.acquired) {
      return result.value;
    }
    await delay(MORNING_BRIEF_LOCK_RETRY_MS, { signal });
  }
}

export const morningBriefPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    return await loadInstalledPreference(db, args);
  },
);

const qualifyMorningBriefMembership$ = command(
  async (
    { get, set },
    args: MorningBriefPreferenceArgs,
    signal: AbortSignal,
  ): Promise<EnsureMorningBriefDefaultEnabledResult | null> => {
    const db = set(writeDb$);
    const identity = { orgId: args.orgId, userId: args.member.userId };
    await db
      .insert(morningBriefEnrollments)
      .values({
        ...identity,
        state: "checking",
        availableAt: nowDate(),
        createdAt: nowDate(),
        updatedAt: nowDate(),
      })
      .onConflictDoNothing();
    signal.throwIfAborted();
    let enrollment = await loadMorningBriefEnrollment(db, identity);
    signal.throwIfAborted();
    if (
      enrollment &&
      enrollment.state !== "pending" &&
      enrollment.state !== "checking" &&
      enrollment.state !== "departed"
    ) {
      return {
        outcome: "skipped",
        reason:
          enrollment.state === "cancelled" ? "user-disabled" : "not-eligible",
      };
    }
    const memberships = await get(
      clerk$,
    ).organizations.getOrganizationMembershipList(
      {
        organizationId: args.orgId,
        userId: [args.member.userId],
        limit: 1,
      },
      undefined,
      signal,
    );
    signal.throwIfAborted();
    const membership = memberships.data.find((entry) => {
      return (
        entry.publicUserData?.userId === args.member.userId &&
        entry.organization.id === args.orgId
      );
    });
    if (
      !membership ||
      (enrollment?.state !== "departed" &&
        enrollment?.membershipId &&
        enrollment.membershipId !== membership.id)
    ) {
      if (enrollment) {
        await db
          .update(morningBriefEnrollments)
          .set({ state: "departed", updatedAt: nowDate() })
          .where(morningBriefEnrollmentWhere(identity));
      }
      return { outcome: "skipped", reason: "membership-unavailable" };
    }
    if (enrollment?.state === "checking" || enrollment?.state === "departed") {
      const createdAt = new Date(membership.createdAt);
      if (!Number.isFinite(createdAt.getTime())) {
        throw new Error("Invalid Clerk membership creation time");
      }
      await recordMorningBriefMembership(db, {
        ...identity,
        membershipId: membership.id,
        createdAt,
      });
      signal.throwIfAborted();
      enrollment = await loadMorningBriefEnrollment(db, identity);
      signal.throwIfAborted();
    }
    if (enrollment?.state !== "pending") {
      return { outcome: "skipped", reason: "not-eligible" };
    }
    return null;
  },
);

const installMorningBriefEnrollment$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs & { readonly agentId: string },
    signal: AbortSignal,
  ): Promise<EnsureMorningBriefDefaultEnabledResult> => {
    const db = set(writeDb$);
    const identity = { orgId: args.orgId, userId: args.member.userId };
    const installed = await set(
      installOfficialWorkflow$,
      {
        orgId: args.orgId,
        member: args.member,
        agentId: args.agentId,
        definitionName: MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
        blueprints: [
          {
            blueprintKey: MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
            bindings: [],
          },
        ],
      },
      signal,
    );
    signal.throwIfAborted();
    if (installed.kind === "ok") {
      const intent = await loadMorningBriefEnrollment(db, identity);
      signal.throwIfAborted();
      if (intent?.state !== "pending") {
        const automationId = await loadMorningBriefAutomationId(
          db,
          installed.workflowId,
        );
        signal.throwIfAborted();
        if (automationId) {
          await set(
            disableWorkflowAutomation$,
            { orgId: args.orgId, member: args.member, automationId },
            signal,
          );
        }
        return { outcome: "skipped", reason: "membership-unavailable" };
      }
      await completeMorningBriefEnrollment(db, identity);
      signal.throwIfAborted();
      await publishMorningBriefChangedSafely(identity);
      signal.throwIfAborted();
      return { outcome: "installed", workflowId: installed.workflowId };
    }

    const racedInstallations = await loadMorningBriefWorkflowIds(db, args);
    signal.throwIfAborted();
    if (
      racedInstallations.length === 1 &&
      racedInstallations[0]?.installationState === "installed"
    ) {
      await completeMorningBriefEnrollment(db, identity);
      signal.throwIfAborted();
      return {
        outcome: "unchanged",
        reason: "existing-installation",
        installationCount: racedInstallations.length,
      };
    }
    return {
      outcome: "failed",
      reason: "installation-failed",
      failureKind: installed.kind,
      message: installed.message,
    };
  },
);

const ensureMorningBriefWhileLocked$ = command(
  async (
    { set },
    args: EnsureMorningBriefDefaultEnabledArgs,
    signal: AbortSignal,
  ): Promise<EnsureMorningBriefDefaultEnabledResult> => {
    const db = set(writeDb$);
    const installations = await loadMorningBriefWorkflowIds(db, args);
    signal.throwIfAborted();
    const identity = { orgId: args.orgId, userId: args.member.userId };
    if (
      installations.length === 1 &&
      installations[0]?.installationState === "installed"
    ) {
      await completeMorningBriefEnrollment(db, identity);
      signal.throwIfAborted();
      return {
        outcome: "unchanged",
        reason: "existing-installation",
        installationCount: installations.length,
      };
    }

    if (installations.length > 1) {
      return {
        outcome: "failed",
        reason: "installation-failed",
        failureKind: "conflict",
        message: "Multiple Morning Brief installations exist",
      };
    }
    const qualification = await set(
      qualifyMorningBriefMembership$,
      args,
      signal,
    );
    signal.throwIfAborted();
    if (qualification !== null) {
      return qualification;
    }
    const featureSwitchContext = await loadUserFeatureSwitchContext(
      db,
      args.orgId,
      args.member.userId,
    );
    signal.throwIfAborted();
    if (
      !isFeatureEnabled(FeatureSwitchKey.MorningBrief, featureSwitchContext)
    ) {
      return { outcome: "skipped", reason: "feature-disabled" };
    }

    const unavailableReason = await loadUnavailableReason(
      db,
      args,
      installations[0]?.agentId,
    );
    signal.throwIfAborted();
    if (unavailableReason !== null) {
      return { outcome: "skipped", reason: unavailableReason };
    }

    const agentId =
      installations[0]?.agentId ?? (await loadDefaultAgentId(db, args));
    signal.throwIfAborted();
    if (agentId === null) {
      return { outcome: "skipped", reason: "missing-default-agent" };
    }

    return await set(
      installMorningBriefEnrollment$,
      { ...args, agentId },
      signal,
    );
  },
);

export const ensureMorningBriefDefaultEnabled$ = command(
  async (
    { set },
    args: EnsureMorningBriefDefaultEnabledArgs,
    signal: AbortSignal,
  ): Promise<EnsureMorningBriefDefaultEnabledResult> => {
    return await withMorningBriefPreferenceLock(
      set(writeDb$),
      args,
      signal,
      async () => {
        return await set(ensureMorningBriefWhileLocked$, args, signal);
      },
    );
  },
);

async function loadMorningBriefAutomationId(
  db: ReadonlyDb,
  workflowId: string,
): Promise<string | null> {
  const [automation] = await db
    .select({ id: workflowAutomations.id })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.workflowId, workflowId),
        eq(
          workflowAutomations.officialBlueprintKey,
          MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
        ),
      ),
    )
    .limit(1);
  return automation?.id ?? null;
}

const createMorningBriefFromPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceMutationArgs,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    const db = set(writeDb$);
    const identity = { orgId: args.orgId, userId: args.member.userId };
    if (!args.enabled) {
      return await loadInstalledPreference(db, args);
    }
    const unavailableReason = await loadUnavailableReason(db, args);
    signal.throwIfAborted();
    if (unavailableReason !== null) {
      return await loadInstalledPreference(db, args);
    }
    const agentId = await loadDefaultAgentId(db, args);
    signal.throwIfAborted();
    if (agentId === null) {
      return unavailableFailure("missing-default-agent");
    }
    const installed = await set(
      installOfficialWorkflow$,
      {
        orgId: args.orgId,
        member: args.member,
        agentId,
        definitionName: MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
        blueprints: [
          {
            blueprintKey: MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
            bindings: [],
          },
        ],
      },
      signal,
    );
    signal.throwIfAborted();
    if (installed.kind !== "ok") {
      const raced = await loadInstalledPreference(db, args);
      signal.throwIfAborted();
      return raced.kind === "ok" && raced.workflowId
        ? raced
        : conflict(
            "MORNING_BRIEF_STATE_CONFLICT",
            "Morning Brief could not be installed. Retry the preference update.",
          );
    }
    await completeMorningBriefEnrollment(db, identity);
    signal.throwIfAborted();
    return await loadInstalledPreference(db, args);
  },
);

const updateMorningBriefWhileLocked$ = command(
  async (
    { set },
    args: MorningBriefPreferenceMutationArgs,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    const db = set(writeDb$);
    const installations = await loadMorningBriefWorkflowIds(db, args);
    signal.throwIfAborted();
    if (installations.length > 1) {
      return conflict(
        "MORNING_BRIEF_MULTIPLE_INSTALLATIONS",
        "Multiple Morning Brief installations exist. Resolve the conflict before changing this preference.",
      );
    }

    const identity = { orgId: args.orgId, userId: args.member.userId };
    await recordMorningBriefChoice(db, identity, args.enabled);
    signal.throwIfAborted();
    const installation = installations[0];
    if (!installation) {
      return await set(createMorningBriefFromPreference$, args, signal);
    }

    if (installation.installationState !== "installed") {
      return await loadInstalledPreference(db, args);
    }

    if (args.enabled) {
      const reconciliation = await set(
        reconcileOfficialWorkflowInstallation$,
        {
          orgId: args.orgId,
          member: args.member,
          workflowId: installation.id,
        },
        signal,
      );
      signal.throwIfAborted();
      if (reconciliation.kind !== "current") {
        return conflict(
          "MORNING_BRIEF_STATE_CONFLICT",
          "Morning Brief could not be reconciled. Retry the preference update.",
        );
      }
    }

    const current = await loadInstalledPreference(db, args);
    signal.throwIfAborted();
    if (current.kind !== "ok" || current.workflowId === undefined) {
      return current;
    }
    if (current.preference.enabled === args.enabled) {
      if (args.enabled) {
        await completeMorningBriefEnrollment(db, identity);
        signal.throwIfAborted();
      }
      return current;
    }

    const automationId = await loadMorningBriefAutomationId(
      db,
      current.workflowId,
    );
    signal.throwIfAborted();
    if (automationId === null) {
      return conflict(
        "MORNING_BRIEF_STATE_CONFLICT",
        "Morning Brief automation is unavailable. Retry after reconciliation completes.",
      );
    }
    const changed = await set(
      args.enabled ? enableWorkflowAutomation$ : disableWorkflowAutomation$,
      {
        orgId: args.orgId,
        member: args.member,
        automationId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (changed.kind !== "ok") {
      return conflict(
        "MORNING_BRIEF_STATE_CONFLICT",
        "Morning Brief automation could not be updated. Retry the preference update.",
      );
    }
    if (args.enabled) {
      await completeMorningBriefEnrollment(db, identity);
      signal.throwIfAborted();
    }
    return await loadInstalledPreference(db, args);
  },
);

export const updateMorningBriefPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceMutationArgs,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    const db = set(writeDb$);
    const result = await withMorningBriefPreferenceLock(
      db,
      args,
      signal,
      async () => {
        return await set(updateMorningBriefWhileLocked$, args, signal);
      },
    );
    await publishMorningBriefChangedSafely({
      orgId: args.orgId,
      userId: args.member.userId,
    });
    signal.throwIfAborted();
    return result;
  },
);

/** Updating the timezone never enables a paused schedule or schedules over an in-flight run. */
export const synchronizeMorningBriefTimezone$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await withMorningBriefPreferenceLock(db, args, signal, async () => {
      const timezone = await loadOfficialWorkflowUserTimezone(db, {
        orgId: args.orgId,
        userId: args.member.userId,
      });
      if (!timezone || !isValidTimeZone(timezone)) {
        return;
      }
      const installations = await loadMorningBriefWorkflowIds(db, args);
      if (installations.length !== 1 || !installations[0]) {
        return;
      }
      const workflowId = installations[0].id;
      await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(workflowAutomations)
          .where(
            and(
              eq(workflowAutomations.workflowId, workflowId),
              eq(
                workflowAutomations.officialBlueprintKey,
                MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
              ),
            ),
          )
          .for("update");
        for (const row of rows) {
          if (
            row.scheduleType !== "cron" ||
            !row.cronExpression ||
            row.timezone === timezone
          ) {
            continue;
          }
          const currentTime = nowDate();
          await tx
            .update(workflowAutomations)
            .set({
              timezone,
              nextRunAt:
                row.enabled && row.nextRunAt
                  ? calculateNextRun(row.cronExpression, timezone, currentTime)
                  : null,
              updatedAt: currentTime,
            })
            .where(eq(workflowAutomations.id, row.id));
        }
      });
    });
    await publishMorningBriefChangedSafely({
      orgId: args.orgId,
      userId: args.member.userId,
    });
  },
);
