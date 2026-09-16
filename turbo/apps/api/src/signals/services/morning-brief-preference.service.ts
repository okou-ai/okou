import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
  type MorningBriefPreferenceErrorCode,
  type MorningBriefPreferenceResponse,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isValidTimeZone } from "@okouai/core/timezone";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { workflowAutomations } from "@okouai/db/schema/workflow";
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
  type MorningBriefMemberIdentity,
} from "./morning-brief-enrollment-data.service";
import {
  loadMorningBriefDefaultAgentId,
  loadMorningBriefMigrationState,
  loadMorningBriefOwnership,
  type MorningBriefMigrationState,
} from "./morning-brief-migration-state.service";
import {
  readMorningBriefPreferenceProjection,
  refreshMorningBriefPreferenceProjection,
} from "./morning-brief-preference-projection.service";
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
    "MORNING_BRIEF_STATE_CONFLICT"
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

function morningBriefOwner(
  args: MorningBriefPreferenceArgs,
): MorningBriefMemberIdentity {
  return { orgId: args.orgId, userId: args.member.userId };
}

async function loadUnavailableReason(
  db: ReadonlyDb,
  args: MorningBriefPreferenceArgs,
  installationAgentId?: string,
): Promise<MorningBriefPreferenceResponse["unavailableReason"]> {
  const owner = morningBriefOwner(args);
  const timezone = await loadOfficialWorkflowUserTimezone(db, owner);
  if (timezone === null || !isValidTimeZone(timezone)) {
    return "missing-timezone";
  }

  const agentId =
    installationAgentId ?? (await loadMorningBriefDefaultAgentId(db, owner));
  if (agentId === null) {
    return "missing-default-agent";
  }
  return null;
}

async function loadPendingPreference(
  db: ReadonlyDb,
  args: MorningBriefPreferenceArgs,
  enrollment: Awaited<ReturnType<typeof loadMorningBriefEnrollment>>,
  installationAgentId?: string,
): Promise<MorningBriefPreferenceResult> {
  const [timezone, unavailableReason] = await Promise.all([
    loadOfficialWorkflowUserTimezone(db, morningBriefOwner(args)),
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

/**
 * Project the member's canonical state onto the Settings response.
 *
 * The migration facts the state also carries — the additional installations it
 * left alone, and the thread the brief delivers into — stay internal.
 */
async function projectInstalledPreference(
  db: ReadonlyDb,
  args: MorningBriefPreferenceArgs,
  state: MorningBriefMigrationState,
): Promise<MorningBriefPreferenceResult & { readonly workflowId?: string }> {
  if (state.kind === "absent") {
    return await loadPendingPreference(db, args, state.enrollment);
  }
  if (state.kind === "pending") {
    return state.enrollment !== undefined
      ? await loadPendingPreference(
          db,
          args,
          state.enrollment,
          state.installation.agentId,
        )
      : conflict(
          "MORNING_BRIEF_STATE_CONFLICT",
          "Morning Brief installation is not ready. Retry after installation completes.",
        );
  }
  if (state.kind === "inconsistent") {
    return conflict(
      "MORNING_BRIEF_STATE_CONFLICT",
      "Morning Brief installation state is inconsistent. Retry after reconciliation completes.",
    );
  }
  return {
    kind: "ok",
    workflowId: state.installation.id,
    preference: {
      enabled: state.automation.enabled,
      status: state.automation.enabled ? "enabled" : "paused",
      nextRunAt: state.automation.nextRunAt?.toISOString() ?? null,
      timezone: state.automation.timezone,
      unavailableReason: null,
    },
  };
}

async function loadInstalledPreference(
  db: ReadonlyDb,
  args: MorningBriefPreferenceArgs,
): Promise<MorningBriefPreferenceResult & { readonly workflowId?: string }> {
  return await projectInstalledPreference(
    db,
    args,
    await loadMorningBriefMigrationState(db, morningBriefOwner(args)),
  );
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

/**
 * Read the member's Morning Brief preference.
 *
 * The live canonical legacy state is loaded and answered from first. While the
 * implementation switch is on, the native projection may hand back its own
 * stored copy instead — but only one that still matches that state in every
 * copied field. Missing, stale or unsupported native data simply keeps the
 * legacy answer, and nothing on this path writes, installs or repairs.
 */
export const morningBriefPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const state = await loadMorningBriefMigrationState(
      db,
      morningBriefOwner(args),
    );
    signal.throwIfAborted();
    const legacy = await projectInstalledPreference(db, args, state);
    signal.throwIfAborted();
    if (state.kind !== "installed" || legacy.kind !== "ok") {
      return legacy;
    }
    const featureSwitchContext = await loadUserFeatureSwitchContext(
      db,
      args.orgId,
      args.member.userId,
    );
    signal.throwIfAborted();
    if (
      !isFeatureEnabled(
        FeatureSwitchKey.SimpleMorningBrief,
        featureSwitchContext,
      )
    ) {
      return legacy;
    }
    const projected = await readMorningBriefPreferenceProjection(db, state);
    signal.throwIfAborted();
    return projected === null ? legacy : { kind: "ok", preference: projected };
  },
);

const qualifyMorningBriefMembership$ = command(
  async (
    { get, set },
    args: MorningBriefPreferenceArgs,
    signal: AbortSignal,
  ): Promise<EnsureMorningBriefDefaultEnabledResult | null> => {
    const db = set(writeDb$);
    const identity = morningBriefOwner(args);
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
    const identity = morningBriefOwner(args);
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
      await completeMorningBriefEnrollment(db, identity, installed.workflowId);
      signal.throwIfAborted();
      await publishMorningBriefChangedSafely(identity);
      signal.throwIfAborted();
      return { outcome: "installed", workflowId: installed.workflowId };
    }

    const raced = await loadMorningBriefOwnership(db, identity);
    signal.throwIfAborted();
    if (raced.installation?.installationState === "installed") {
      await completeMorningBriefEnrollment(db, identity, raced.installation.id);
      signal.throwIfAborted();
      return {
        outcome: "unchanged",
        reason: "existing-installation",
        installationCount: raced.installations.length,
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
    const identity = morningBriefOwner(args);
    const { installation, installations } = await loadMorningBriefOwnership(
      db,
      identity,
    );
    signal.throwIfAborted();
    if (installation?.installationState === "installed") {
      await completeMorningBriefEnrollment(db, identity, installation.id);
      signal.throwIfAborted();
      return {
        outcome: "unchanged",
        reason: "existing-installation",
        installationCount: installations.length,
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
      installation?.agentId,
    );
    signal.throwIfAborted();
    if (unavailableReason !== null) {
      return { outcome: "skipped", reason: unavailableReason };
    }

    const agentId =
      installation?.agentId ??
      (await loadMorningBriefDefaultAgentId(db, identity));
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
    const db = set(writeDb$);
    return await withMorningBriefPreferenceLock(db, args, signal, async () => {
      const outcome = await set(ensureMorningBriefWhileLocked$, args, signal);
      await refreshMorningBriefPreferenceProjection(
        db,
        morningBriefOwner(args),
        signal,
      );
      return outcome;
    });
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
    const identity = morningBriefOwner(args);
    if (!args.enabled) {
      return await loadInstalledPreference(db, args);
    }
    const unavailableReason = await loadUnavailableReason(db, args);
    signal.throwIfAborted();
    if (unavailableReason !== null) {
      return await loadInstalledPreference(db, args);
    }
    const agentId = await loadMorningBriefDefaultAgentId(db, identity);
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
    await completeMorningBriefEnrollment(db, identity, installed.workflowId);
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
    const identity = morningBriefOwner(args);
    const { installation } = await loadMorningBriefOwnership(db, identity);
    signal.throwIfAborted();

    await recordMorningBriefChoice(db, identity, args.enabled);
    signal.throwIfAborted();
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
        await completeMorningBriefEnrollment(db, identity, current.workflowId);
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
      await completeMorningBriefEnrollment(db, identity, current.workflowId);
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
        const outcome = await set(updateMorningBriefWhileLocked$, args, signal);
        // The legacy mutation above runs on the outer `Db` and has already
        // committed; holding the preference advisory lock does not make the
        // two writes atomic. A failed copy is reported operationally and the
        // real legacy outcome is still returned to the caller.
        await refreshMorningBriefPreferenceProjection(
          db,
          morningBriefOwner(args),
          signal,
        );
        return outcome;
      },
    );
    await publishMorningBriefChangedSafely(morningBriefOwner(args));
    signal.throwIfAborted();
    return result;
  },
);

async function synchronizeTimezoneWhileLocked(
  db: Db,
  identity: MorningBriefMemberIdentity,
): Promise<void> {
  const timezone = await loadOfficialWorkflowUserTimezone(db, identity);
  if (!timezone || !isValidTimeZone(timezone)) {
    return;
  }
  const { installation } = await loadMorningBriefOwnership(db, identity);
  if (!installation) {
    return;
  }
  const workflowId = installation.id;
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
}

/** Updating the timezone never enables a paused schedule or schedules over an in-flight run. */
export const synchronizeMorningBriefTimezone$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const identity = morningBriefOwner(args);
    await withMorningBriefPreferenceLock(db, args, signal, async () => {
      await synchronizeTimezoneWhileLocked(db, identity);
      await refreshMorningBriefPreferenceProjection(db, identity, signal);
    });
    await publishMorningBriefChangedSafely(identity);
  },
);
