import { loadProactivePreferences$ } from "./proactive-workflows-eligibility.service";
import { proactiveDispatchPhase$ } from "./proactive-dispatch-ownership.service";
import {
  standalonePreference$,
  setStandalonePreferences$,
} from "./proactive-dispatch-state.service";
import { synchronizeMorningBriefTimezone$ } from "./morning-brief-timezone.service";
import type {
  MorningBriefPreferenceErrorCode,
  MorningBriefPreferenceResponse,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { command } from "ccstate";

import {
  recordMorningBriefChoice$,
  type MorningBriefMemberIdentity,
} from "./morning-brief-enrollment-data.service";
import {
  loadMorningBriefState$,
  type MorningBriefState,
} from "./morning-brief-state.service";
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

/** Settings reports the user's intent separately from the schedule's running state. */
const projectInstalledPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs,
    state: MorningBriefState,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    if (state.kind === "absent") {
      return await set(loadPendingPreference$, args, state.enrollment, signal);
    }
    if (state.kind === "inconsistent") {
      return conflict(
        "MORNING_BRIEF_STATE_CONFLICT",
        "Morning Brief installation state is inconsistent. Retry after reconciliation completes.",
      );
    }
    return {
      kind: "ok",
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

/** Read the live Official Workflow installation without writing or repairing it. */
export const morningBriefPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    signal.throwIfAborted();
    const owner = morningBriefOwner(args);
    if ((await set(proactiveDispatchPhase$, signal)) !== "automation") {
      return {
        kind: "ok",
        preference: await set(
          standalonePreference$,
          owner,
          "morning-brief",
          signal,
        ),
      };
    }
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

/** An installer that claimed the enrollment concurrently owns the schedule for this choice. */
const setFirstMorningBriefChoice$ = command(
  async (
    { set },
    args: MorningBriefPreferenceMutationArgs,
    observedWorkflowId: string | null,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult | undefined> => {
    const identity = morningBriefOwner(args);
    const recorded = await set(
      recordMorningBriefChoice$,
      identity,
      args.enabled,
      observedWorkflowId,
      signal,
    );
    signal.throwIfAborted();
    if (!recorded) {
      return undefined;
    }
    if (args.enabled && (await set(installMorningBrief$, identity, signal))) {
      const timezone = await set(
        synchronizeMorningBriefTimezone$,
        args,
        signal,
      );
      if (timezone === "conflict") {
        return conflict(
          "MORNING_BRIEF_STATE_CONFLICT",
          MORNING_BRIEF_TIMEZONE_CONFLICT_MESSAGE,
        );
      }
    }
    const state = await set(loadMorningBriefState$, identity, signal);
    const result = await set(projectInstalledPreference$, args, state, signal);
    if (
      state.kind === "absent" &&
      args.enabled &&
      result.kind === "ok" &&
      result.preference.enabled &&
      result.preference.unavailableReason === null
    ) {
      // The member acquired a timezone between the install and the preference read.
      return conflict(
        "MORNING_BRIEF_STATE_CONFLICT",
        MORNING_BRIEF_TIMEZONE_CONFLICT_MESSAGE,
      );
    }
    return result;
  },
);

export const updateMorningBriefPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceMutationArgs,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    const identity = morningBriefOwner(args);
    if ((await set(proactiveDispatchPhase$, signal)) !== "automation") {
      const { timezone } = await set(
        loadProactivePreferences$,
        identity,
        signal,
      );
      const saved = await set(
        setStandalonePreferences$,
        {
          owner: identity,
          tasks: ["morning-brief"],
          enabled: args.enabled,
          timezone,
        },
        signal,
      );
      if (!saved) {
        return conflict(
          "MORNING_BRIEF_STATE_CONFLICT",
          MORNING_BRIEF_TIMEZONE_CONFLICT_MESSAGE,
        );
      }
      return {
        kind: "ok",
        preference: await set(
          standalonePreference$,
          identity,
          "morning-brief",
          signal,
        ),
      };
    }
    let state = await set(loadMorningBriefState$, identity, signal);
    signal.throwIfAborted();

    if (state.kind === "absent") {
      const result = await set(
        setFirstMorningBriefChoice$,
        args,
        state.enrollment?.workflowId ?? null,
        signal,
      );
      if (result) {
        return result;
      }
      state = await set(loadMorningBriefState$, identity, signal);
      if (state.kind === "absent") {
        return conflict(
          "MORNING_BRIEF_STATE_CONFLICT",
          MORNING_BRIEF_TIMEZONE_CONFLICT_MESSAGE,
        );
      }
    }

    if (args.enabled) {
      const owner = { ...identity, workflowId: state.installation.id };
      await set(synchronizeOfficialWorkflowThread$, owner, signal);
      if (state.kind === "installed" && state.automation.intendedEnabled) {
        // Repeating an opt-in must preserve an execution pause and its retry time.
        return await set(projectInstalledPreference$, args, state, signal);
      }
      const repaired = await set(repairMorningBriefSchedule$, owner, signal);
      signal.throwIfAborted();
      if (!repaired) {
        return conflict(
          "MORNING_BRIEF_STATE_CONFLICT",
          "Morning Brief could not be reconciled. Retry the preference update.",
        );
      }
      state = await set(loadMorningBriefState$, identity, signal);
    }
    signal.throwIfAborted();
    if (
      state.kind !== "installed" ||
      state.automation.intendedEnabled === args.enabled
    ) {
      return await set(projectInstalledPreference$, args, state, signal);
    }
    const changed = await set(
      args.enabled ? enableWorkflowAutomation$ : disableWorkflowAutomation$,
      {
        orgId: args.orgId,
        member: args.member,
        automationId: state.automation.id,
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
    return await set(morningBriefPreference$, args, signal);
  },
);
