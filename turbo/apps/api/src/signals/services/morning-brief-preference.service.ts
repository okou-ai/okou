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
import { settle } from "../utils";
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
  claimMorningBriefEnrollment,
  deferMorningBriefPrerequisite,
  finishMorningBriefEnrollmentAttempt,
  prepareMorningBriefEnrollment,
} from "./morning-brief-enrollment-retry.service";
import { readAcceptedOfficialWorkflowDefinition } from "./official-workflow-catalog-read.service";
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
import {
  applyMorningBriefLogicalChoice,
  materializeMorningBriefNativeSchedule,
  readMorningBriefNativeSchedule,
  type MorningBriefNativeScheduleRow,
} from "./morning-brief-native-schedule.service";
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
  persistNativeMorningBriefPreferenceChoice,
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
        | "retry-deferred"
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

/**
 * Project the durable native choice onto the Settings response.
 *
 * Once a member's execution ownership has left `legacy`, that row is the
 * authority for what Settings shows: the legacy automation's enabled bit and
 * `next_run_at` belong to a scheduler that no longer admits this member's work,
 * and during a rollback drain they are deliberately not the user's choice
 * either. Reading them would let a disabled native brief still look enabled.
 *
 * Nothing here writes, and a member still on `legacy` is not affected at all.
 */
function projectNativePreference(
  row: MorningBriefNativeScheduleRow,
): MorningBriefPreferenceResult & { readonly workflowId?: string } {
  return {
    kind: "ok",
    ...(row.legacyWorkflowId === null
      ? {}
      : { workflowId: row.legacyWorkflowId }),
    preference: {
      enabled: row.enabled,
      status: row.enabled ? "enabled" : "paused",
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      timezone: row.timezone,
      unavailableReason: null,
    },
  };
}

async function loadInstalledPreference(
  db: ReadonlyDb,
  args: MorningBriefPreferenceArgs,
): Promise<MorningBriefPreferenceResult & { readonly workflowId?: string }> {
  const owner = morningBriefOwner(args);
  const native = await readMorningBriefNativeSchedule(db, owner);
  if (native !== undefined && native.phase !== "legacy") {
    return projectNativePreference(native);
  }
  return await projectInstalledPreference(
    db,
    args,
    await loadMorningBriefMigrationState(db, owner),
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
 * Once execution ownership has left `legacy`, the durable native choice is the
 * Settings authority even if the implementation switch rolls back or the old
 * installation/catalog disappears. A legacy-phase member still reads the live
 * legacy state (with the disposable projection only as a compatibility check).
 * This path never writes, installs or repairs.
 */
export const morningBriefPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const owner = morningBriefOwner(args);
    const native = await readMorningBriefNativeSchedule(db, owner);
    signal.throwIfAborted();
    if (native !== undefined && native.phase !== "legacy") {
      return projectNativePreference(native);
    }
    const state = await loadMorningBriefMigrationState(db, owner);
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
        preserveRetrySchedule: true,
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
      await completeAndMaterializeMorningBriefEnrollment(
        db,
        identity,
        installed.workflowId,
      );
      signal.throwIfAborted();
      await publishMorningBriefChangedSafely(identity);
      signal.throwIfAborted();
      return { outcome: "installed", workflowId: installed.workflowId };
    }

    const raced = await loadMorningBriefOwnership(db, identity);
    signal.throwIfAborted();
    if (raced.installation?.installationState === "installed") {
      await completeAndMaterializeMorningBriefEnrollment(
        db,
        identity,
        raced.installation.id,
      );
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

const preflightMorningBriefEnrollment$ = command(
  async (
    { set },
    args: EnsureMorningBriefDefaultEnabledArgs & {
      readonly installationAgentId?: string;
    },
    signal: AbortSignal,
  ): Promise<
    | EnsureMorningBriefDefaultEnabledResult
    | { readonly outcome: "ready"; readonly agentId: string }
  > => {
    const db = set(writeDb$);
    const identity = morningBriefOwner(args);
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
      args.installationAgentId,
    );
    signal.throwIfAborted();
    if (unavailableReason !== null) {
      return { outcome: "skipped", reason: unavailableReason };
    }

    const agentId =
      args.installationAgentId ??
      (await loadMorningBriefDefaultAgentId(db, identity));
    signal.throwIfAborted();
    if (agentId === null) {
      return { outcome: "skipped", reason: "missing-default-agent" };
    }

    const definition = await readAcceptedOfficialWorkflowDefinition(
      db,
      MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
      signal,
    );
    signal.throwIfAborted();
    if (!definition || definition.lifecycle !== "active") {
      return {
        outcome: "failed",
        reason: "installation-failed",
        failureKind: definition ? "conflict" : "not-found",
        message: definition
          ? `Official Workflow is retired: ${MORNING_BRIEF_OFFICIAL_DEFINITION_NAME}`
          : `Official Workflow not found: ${MORNING_BRIEF_OFFICIAL_DEFINITION_NAME}`,
      };
    }
    return { outcome: "ready", agentId };
  },
);

const attemptMorningBriefEnrollment$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs & {
      readonly agentId?: string;
      readonly installationAgentId?: string;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly result: EnsureMorningBriefDefaultEnabledResult;
    readonly localDeferral: boolean;
  }> => {
    const qualification = await set(
      qualifyMorningBriefMembership$,
      args,
      signal,
    );
    signal.throwIfAborted();
    if (qualification !== null) {
      return { result: qualification, localDeferral: false };
    }
    // Unknown eligibility is resolved once even without local prerequisites,
    // so historical members retain their ineligible preference state.
    const preflight =
      args.agentId === undefined
        ? await set(preflightMorningBriefEnrollment$, args, signal)
        : { outcome: "ready" as const, agentId: args.agentId };
    signal.throwIfAborted();
    if (preflight.outcome !== "ready") {
      return { result: preflight, localDeferral: true };
    }
    return {
      result: await set(
        installMorningBriefEnrollment$,
        { ...args, agentId: preflight.agentId },
        signal,
      ),
      localDeferral: false,
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
      await completeAndMaterializeMorningBriefEnrollment(
        db,
        identity,
        installation.id,
      );
      signal.throwIfAborted();
      return {
        outcome: "unchanged",
        reason: "existing-installation",
        installationCount: installations.length,
      };
    }
    await prepareMorningBriefEnrollment(db, identity);
    signal.throwIfAborted();
    const enrollment = await loadMorningBriefEnrollment(db, identity);
    signal.throwIfAborted();
    if (!enrollment) {
      throw new Error("Morning Brief enrollment intent is missing");
    }
    if (
      enrollment.state !== "checking" &&
      enrollment.state !== "pending" &&
      enrollment.state !== "departed"
    ) {
      return {
        outcome: "skipped",
        reason:
          enrollment.state === "cancelled" ? "user-disabled" : "not-eligible",
      };
    }
    const preflight =
      enrollment.state === "checking"
        ? null
        : await set(
            preflightMorningBriefEnrollment$,
            { ...args, installationAgentId: installation?.agentId },
            signal,
          );
    signal.throwIfAborted();
    if (preflight !== null && preflight.outcome !== "ready") {
      await deferMorningBriefPrerequisite(
        db,
        enrollment,
        preflight.outcome === "failed" ? preflight.message : null,
      );
      signal.throwIfAborted();
      return preflight;
    }
    const claim = await claimMorningBriefEnrollment(db, enrollment);
    signal.throwIfAborted();
    if (!claim) {
      return { outcome: "skipped", reason: "retry-deferred" };
    }
    const result = await settle(
      set(
        attemptMorningBriefEnrollment$,
        {
          ...args,
          agentId: preflight?.agentId,
          installationAgentId: installation?.agentId,
        },
        signal,
      ),
      signal,
    );
    const lastError = !result.ok
      ? String(result.error)
      : result.value.result.outcome === "failed"
        ? result.value.result.message
        : null;
    await finishMorningBriefEnrollmentAttempt(
      db,
      claim,
      lastError,
      result.ok && result.value.localDeferral,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      throw result.error;
    }
    return result.value.result;
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

async function completeAndMaterializeMorningBriefEnrollment(
  db: Db,
  identity: MorningBriefMemberIdentity,
  workflowId: string,
): Promise<void> {
  await completeMorningBriefEnrollment(db, identity, workflowId);
  const enrollment = await loadMorningBriefEnrollment(db, identity);
  if (
    enrollment?.state !== "completed" ||
    enrollment.membershipId === null ||
    enrollment.workflowId !== workflowId
  ) {
    return;
  }
  const membershipId = enrollment.membershipId;
  await db.transaction(async (tx) => {
    await materializeMorningBriefNativeSchedule(tx, identity, {
      membershipId,
      at: nowDate(),
    });
  });
}

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
    await completeAndMaterializeMorningBriefEnrollment(
      db,
      identity,
      installed.workflowId,
    );
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

    if (!installation) {
      await recordMorningBriefChoice(db, identity, args.enabled);
      signal.throwIfAborted();
      return await set(createMorningBriefFromPreference$, args, signal);
    }

    if (installation.installationState !== "installed") {
      await recordMorningBriefChoice(db, identity, args.enabled);
      signal.throwIfAborted();
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

    // A member whose execution ownership has left `legacy` is decided by the
    // durable row alone. Its legacy automation no longer admits work, so the
    // toggle commits once, in one transaction, and never depends on a second
    // commit landing afterwards. This is what removes the window where a
    // failure between the two left Settings disabled while native execution
    // stayed enabled.
    const nativeRow = await readMorningBriefNativeSchedule(db, identity);
    signal.throwIfAborted();
    if (nativeRow !== undefined && nativeRow.phase !== "legacy") {
      const applied = await persistNativeMorningBriefPreferenceChoice(db, {
        ...identity,
        automationId: nativeRow.legacyAutomationId,
        enabled: args.enabled,
        expectedEpoch: nativeRow.ownerEpoch,
        at: nowDate(),
      });
      signal.throwIfAborted();
      if (applied.kind === "stale") {
        return conflict(
          "MORNING_BRIEF_STATE_CONFLICT",
          "Morning Brief ownership changed during this update. Retry the preference update.",
        );
      }
      if (args.enabled && nativeRow.legacyWorkflowId !== null) {
        await completeAndMaterializeMorningBriefEnrollment(
          db,
          identity,
          nativeRow.legacyWorkflowId,
        );
        signal.throwIfAborted();
      }
      return await loadInstalledPreference(db, args);
    }

    await recordMorningBriefChoice(db, identity, args.enabled);
    signal.throwIfAborted();
    const current = await loadInstalledPreference(db, args);
    signal.throwIfAborted();
    if (current.kind !== "ok" || current.workflowId === undefined) {
      return current;
    }
    if (current.preference.enabled === args.enabled) {
      if (args.enabled) {
        await completeAndMaterializeMorningBriefEnrollment(
          db,
          identity,
          current.workflowId,
        );
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
      await completeAndMaterializeMorningBriefEnrollment(
        db,
        identity,
        current.workflowId,
      );
      signal.throwIfAborted();
    }
    // The generic automation writer recognizes the selected Morning Brief and
    // commits the legacy bit and durable choice in one transaction. The
    // preference advisory lock held by this caller is the first lock in that
    // writer's documented schedule → automation → occurrence order.
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
    // A timezone-only edit is deliberately **not** a revocation: the durable
    // native row keeps its epoch, and an occurrence that already holds the
    // obligation keeps its frozen anchor and window. Its one settlement then
    // computes the next occurrence from the schedule as edited here.
    await applyMorningBriefLogicalChoice(tx, identity, { timezone }, nowDate());
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
