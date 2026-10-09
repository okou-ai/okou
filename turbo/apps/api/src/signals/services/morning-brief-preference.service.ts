import { synchronizeMorningBriefTimezone$ } from "./morning-brief-timezone.service";
import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
  type MorningBriefPreferenceErrorCode,
  type MorningBriefPreferenceResponse,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { isValidTimeZone } from "@okouai/core/timezone";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import {
  loadMorningBriefEnrollment$,
  recordMorningBriefChoice$,
  type MorningBriefMemberIdentity,
} from "./morning-brief-enrollment-data.service";
import {
  loadMorningBriefDefaultAgentId$,
  loadMorningBriefMigrationState$,
  loadMorningBriefOwnership$,
  type MorningBriefMigrationState,
} from "./morning-brief-migration-state.service";
import { completeMorningBriefEnrollment$ } from "./morning-brief-enrollment-completion.service";
import { db$ } from "../external/db";
import {
  installOfficialWorkflow$,
  loadOfficialWorkflowUserTimezone$,
} from "./official-workflow-installation.service";
import { reconcileOfficialWorkflowInstallation$ } from "./official-workflow-reconciliation.service";
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

const loadUnavailableReason$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs,
    installationAgentId: string | undefined,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResponse["unavailableReason"]> => {
    const owner = morningBriefOwner(args);
    const timezone = await set(
      loadOfficialWorkflowUserTimezone$,
      owner,
      signal,
    );
    if (timezone === null || !isValidTimeZone(timezone)) {
      return "missing-timezone";
    }

    const agentId =
      installationAgentId ??
      (await set(loadMorningBriefDefaultAgentId$, owner, signal));
    if (agentId === null) {
      return "missing-default-agent";
    }
    return null;
  },
);

const loadPendingPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs,
    enrollment: typeof morningBriefEnrollments.$inferSelect | undefined,
    installationAgentId: string | undefined,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    const unavailableReason = await set(
      loadUnavailableReason$,
      args,
      installationAgentId,
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
        unavailableReason,
      },
    };
  },
);

/**
 * Project the member's canonical state onto the Settings response.
 *
 * The migration facts the state also carries — the additional installations it
 * left alone, and the thread the brief delivers into — stay internal.
 */
const projectInstalledPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs,
    state: MorningBriefMigrationState,
    signal: AbortSignal,
  ): Promise<
    MorningBriefPreferenceResult & { readonly workflowId?: string }
  > => {
    if (state.kind === "absent") {
      return await set(
        loadPendingPreference$,
        args,
        state.enrollment,
        undefined,
        signal,
      );
    }
    if (state.kind === "pending") {
      return state.enrollment !== undefined
        ? await set(
            loadPendingPreference$,
            args,
            state.enrollment,
            state.installation.agentId,
            signal,
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
      await set(loadMorningBriefMigrationState$, owner, signal),
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
    const state = await set(loadMorningBriefMigrationState$, owner, signal);
    signal.throwIfAborted();
    const legacy = await set(projectInstalledPreference$, args, state, signal);
    signal.throwIfAborted();
    return legacy;
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

const createMorningBriefFromPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceMutationArgs,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    const identity = morningBriefOwner(args);
    if (!args.enabled) {
      return await set(loadInstalledPreference$, args, signal);
    }
    const unavailableReason = await set(
      loadUnavailableReason$,
      args,
      undefined,
      signal,
    );
    signal.throwIfAborted();
    if (unavailableReason !== null) {
      return await set(loadInstalledPreference$, args, signal);
    }
    const agentId = await set(
      loadMorningBriefDefaultAgentId$,
      identity,
      signal,
    );
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
      const state = await set(
        loadMorningBriefMigrationState$,
        identity,
        signal,
      );
      signal.throwIfAborted();
      const raced = await set(projectInstalledPreference$, args, state, signal);
      signal.throwIfAborted();
      // No lock serializes concurrent requests: an installation another
      // request is still committing reports the recorded choice as preparing;
      // that installer completes it from the durable choice.
      return raced.kind === "ok" &&
        (raced.workflowId !== undefined || state.kind === "pending")
        ? raced
        : conflict(
            "MORNING_BRIEF_STATE_CONFLICT",
            "Morning Brief could not be installed. Retry the preference update.",
          );
    }
    await set(
      completeMorningBriefEnrollment$,
      identity,
      installed.workflowId,
      signal,
    );
    signal.throwIfAborted();
    const synchronized = await set(
      synchronizeMorningBriefTimezone$,
      args,
      signal,
    );
    signal.throwIfAborted();
    if (synchronized === "conflict") {
      return conflict(
        "MORNING_BRIEF_STATE_CONFLICT",
        MORNING_BRIEF_TIMEZONE_CONFLICT_MESSAGE,
      );
    }
    return await set(loadInstalledPreference$, args, signal);
  },
);

/**
 * Re-read after recording a choice made while no installation was ready.
 *
 * No lock spans the preference operation. Another explicit enable request may
 * have committed its installation after this request read ownership. Whichever of the
 * two commits second observes the other: here, an installed brief whose
 * automation disagrees with the still-current choice is toggled through the
 * conditional automation writer.
 */
const convergeRacedMorningBriefInstallation$ = command(
  async (
    { set },
    args: MorningBriefPreferenceMutationArgs,
    recorded: MorningBriefPreferenceResult & { readonly workflowId?: string },
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    const current = await set(loadInstalledPreference$, args, signal);
    signal.throwIfAborted();
    if (
      current.kind !== "ok" ||
      current.workflowId === undefined ||
      current.preference.enabled === args.enabled
    ) {
      return recorded;
    }
    const enrollment = await set(
      loadMorningBriefEnrollment$,
      morningBriefOwner(args),
      signal,
    );
    signal.throwIfAborted();
    // Converge only toward the durable choice this request recorded; a later
    // choice or membership change owns convergence toward itself.
    const stillChosen = args.enabled
      ? enrollment?.state === "pending" || enrollment?.state === "completed"
      : enrollment?.state === "cancelled";
    if (!stillChosen) {
      return recorded;
    }
    const automationId = await set(
      loadMorningBriefAutomationId$,
      current.workflowId,
      signal,
    );
    signal.throwIfAborted();
    if (automationId === null) {
      return current;
    }
    await set(
      args.enabled ? enableWorkflowAutomation$ : disableWorkflowAutomation$,
      { orgId: args.orgId, member: args.member, automationId },
      signal,
    );
    signal.throwIfAborted();
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

    if (!installation) {
      await set(recordMorningBriefChoice$, identity, args.enabled, signal);
      signal.throwIfAborted();
      const created = await set(
        createMorningBriefFromPreference$,
        args,
        signal,
      );
      signal.throwIfAborted();
      return await set(
        convergeRacedMorningBriefInstallation$,
        args,
        created,
        signal,
      );
    }

    if (installation.installationState !== "installed") {
      await set(recordMorningBriefChoice$, identity, args.enabled, signal);
      signal.throwIfAborted();
      return await set(
        convergeRacedMorningBriefInstallation$,
        args,
        await set(loadInstalledPreference$, args, signal),
        signal,
      );
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
    // transaction, so the last toggle to commit leaves both consistent.
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
