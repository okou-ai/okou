import { synchronizeMorningBriefTimezone$ } from "./morning-brief-timezone.service";
import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  type MorningBriefPreferenceErrorCode,
  type MorningBriefPreferenceResponse,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import {
  loadMorningBriefEnrollment$,
  recordMorningBriefChoice$,
  type MorningBriefMemberIdentity,
} from "./morning-brief-enrollment-data.service";
import {
  loadMorningBriefState$,
  loadMorningBriefOwnership$,
  type MorningBriefState,
} from "./morning-brief-state.service";
import { completeMorningBriefEnrollment$ } from "./morning-brief-enrollment-completion.service";
import { db$ } from "../external/db";
import {
  installMorningBrief$,
  loadMorningBriefTimezone$,
} from "./morning-brief-installation.service";
import { repairMorningBriefSchedule$ } from "./morning-brief-schedule-repair.service";
import { synchronizeOfficialWorkflowThread$ } from "./official-workflow-thread.service";
import {
  disableWorkflowAutomation$,
  enableWorkflowAutomation$,
} from "./workflow-automation.service";
import type { WorkflowMember } from "./workflow-data.service";

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

function conflict(
  code: Extract<
    MorningBriefPreferenceErrorCode,
    "MORNING_BRIEF_STATE_CONFLICT"
  >,
  message: string,
): MorningBriefPreferenceFailure {
  return { kind: "conflict", code, message };
}

const MORNING_BRIEF_TIMEZONE_CONFLICT_MESSAGE =
  "Morning Brief changed concurrently. Retry the preference update.";

function morningBriefOwner(
  args: MorningBriefPreferenceArgs,
): MorningBriefMemberIdentity {
  return { orgId: args.orgId, userId: args.member.userId };
}

const loadPendingPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs,
    enrollment: typeof morningBriefEnrollments.$inferSelect | undefined,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    const timezone = await set(
      loadMorningBriefTimezone$,
      morningBriefOwner(args),
      signal,
    );
    return {
      kind: "ok",
      preference: {
        // Checking is unknown membership eligibility, not an enable choice.
        // Only a qualified membership or an explicit toggle creates pending intent.
        enabled: enrollment?.state === "pending",
        status:
          enrollment?.state === "pending" || enrollment?.state === "checking"
            ? enrollment.lastError
              ? "error"
              : "preparing"
            : "paused",
        unavailableReason: timezone === null ? "missing-timezone" : null,
      },
    };
  },
);

/**
 * Project the member's canonical state onto the Settings response.
 *
 * Additional installations and the thread the brief delivers into stay internal.
 */
const projectInstalledPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs,
    state: MorningBriefState,
    signal: AbortSignal,
  ): Promise<
    MorningBriefPreferenceResult & { readonly workflowId?: string }
  > => {
    if (state.kind === "absent") {
      return await set(loadPendingPreference$, args, state.enrollment, signal);
    }
    if (state.kind === "pending") {
      return state.enrollment !== undefined
        ? await set(loadPendingPreference$, args, state.enrollment, signal)
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
        enabled: state.automation.intendedEnabled,
        status: !state.automation.intendedEnabled
          ? "paused"
          : state.automation.consecutiveFailures > 0
            ? "error"
            : state.automation.enabled
              ? "enabled"
              : "preparing",
        unavailableReason: null,
      },
    };
  },
);

const loadInstalledPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs,
    signal: AbortSignal,
  ): Promise<
    MorningBriefPreferenceResult & { readonly workflowId?: string }
  > => {
    const owner = morningBriefOwner(args);
    signal.throwIfAborted();
    return await set(
      projectInstalledPreference$,
      args,
      await set(loadMorningBriefState$, owner, signal),
      signal,
    );
  },
);

/** Read the live Official Workflow installation without writing or repairing it. */
export const morningBriefPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    signal.throwIfAborted();
    const owner = morningBriefOwner(args);
    const state = await set(loadMorningBriefState$, owner, signal);
    signal.throwIfAborted();
    const preference = await set(
      projectInstalledPreference$,
      args,
      state,
      signal,
    );
    signal.throwIfAborted();
    return preference;
  },
);

const loadMorningBriefAutomationId$ = command(
  async (
    { get },
    workflowId: string,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = get(db$);
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
    signal.throwIfAborted();
    return automation?.id ?? null;
  },
);

/** Apply a choice recorded before the first installation became visible. */
const settleMorningBriefChoice$ = command(
  async (
    { set },
    args: MorningBriefPreferenceMutationArgs,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    const owner = morningBriefOwner(args);
    const state = await set(loadMorningBriefState$, owner, signal);
    signal.throwIfAborted();
    if (state.kind !== "installed") {
      const current = await set(
        projectInstalledPreference$,
        args,
        state,
        signal,
      );
      if (
        args.enabled &&
        state.kind === "absent" &&
        current.kind === "ok" &&
        current.preference.enabled &&
        current.preference.unavailableReason === null
      ) {
        // A timezone was saved between the installation attempt and this read.
        return conflict(
          "MORNING_BRIEF_STATE_CONFLICT",
          MORNING_BRIEF_TIMEZONE_CONFLICT_MESSAGE,
        );
      }
      return current;
    }
    if (state.automation.intendedEnabled === args.enabled) {
      if (args.enabled && state.enrollment?.state === "pending") {
        await set(
          completeMorningBriefEnrollment$,
          owner,
          state.installation.id,
          signal,
        );
      }
      return await set(projectInstalledPreference$, args, state, signal);
    }
    // A later opt-in, cancellation or membership change owns its own update.
    const enrollment = await set(loadMorningBriefEnrollment$, owner, signal);
    signal.throwIfAborted();
    const stillChosen = args.enabled
      ? enrollment?.state === "pending" || enrollment?.state === "completed"
      : enrollment?.state === "cancelled";
    if (stillChosen) {
      await set(
        args.enabled ? enableWorkflowAutomation$ : disableWorkflowAutomation$,
        {
          orgId: args.orgId,
          member: args.member,
          automationId: state.automation.id,
        },
        signal,
      );
      signal.throwIfAborted();
    }
    return await set(loadInstalledPreference$, args, signal);
  },
);

const applyMorningBriefPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceMutationArgs,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    const identity = morningBriefOwner(args);
    const { installation } = await set(
      loadMorningBriefOwnership$,
      identity,
      signal,
    );
    signal.throwIfAborted();

    if (installation?.installationState !== "installed") {
      await set(recordMorningBriefChoice$, identity, args.enabled, signal);
      signal.throwIfAborted();
      if (
        !installation &&
        args.enabled &&
        (await set(installMorningBrief$, identity, signal))
      ) {
        const timezone = await set(
          synchronizeMorningBriefTimezone$,
          args,
          signal,
        );
        signal.throwIfAborted();
        if (timezone === "conflict") {
          return conflict(
            "MORNING_BRIEF_STATE_CONFLICT",
            MORNING_BRIEF_TIMEZONE_CONFLICT_MESSAGE,
          );
        }
      }
      return await set(settleMorningBriefChoice$, args, signal);
    }

    if (args.enabled) {
      const owner = { ...identity, workflowId: installation.id };
      await set(synchronizeOfficialWorkflowThread$, owner, signal);
      const repaired = await set(repairMorningBriefSchedule$, owner, signal);
      signal.throwIfAborted();
      if (!repaired) {
        return conflict(
          "MORNING_BRIEF_STATE_CONFLICT",
          "Morning Brief could not be reconciled. Retry the preference update.",
        );
      }
    }

    await set(recordMorningBriefChoice$, identity, args.enabled, signal);
    signal.throwIfAborted();
    const current = await set(loadInstalledPreference$, args, signal);
    signal.throwIfAborted();
    if (current.kind !== "ok" || current.workflowId === undefined) {
      return current;
    }
    if (current.preference.enabled === args.enabled) {
      if (args.enabled) {
        await set(
          completeMorningBriefEnrollment$,
          identity,
          current.workflowId,
          signal,
        );
        signal.throwIfAborted();
      }
      return current;
    }

    const automationId = await set(
      loadMorningBriefAutomationId$,
      current.workflowId,
      signal,
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
      await set(
        completeMorningBriefEnrollment$,
        identity,
        current.workflowId,
        signal,
      );
      signal.throwIfAborted();
    }
    // The generic automation writer recognizes the selected Morning Brief and
    // commits the Official enabled bit and enrollment choice in one conditional
    // statement, so the last toggle to commit leaves both consistent.
    return await set(loadInstalledPreference$, args, signal);
  },
);

export const updateMorningBriefPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceMutationArgs,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    signal.throwIfAborted();
    return await set(applyMorningBriefPreference$, args, signal);
  },
);
