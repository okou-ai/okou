import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import {
  workflows,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq, inArray } from "drizzle-orm";

import { command } from "ccstate";
import { db$ } from "../external/db";
import {
  morningBriefEnrollmentWhere,
  type MorningBriefMemberIdentity,
} from "./morning-brief-enrollment-data.service";
import { workflowUserAutomationThreadOwnerCondition } from "./workflow-user-automation-thread.service";

/**
 * The canonical read of the Morning Brief state a member actually owns.
 *
 * Settings reads the selected Official installation, its current automation
 * and its canonical thread binding here. This is a read-only functional view.
 */

interface MorningBriefInstallation {
  readonly id: string;
  readonly installationState: "installing" | "installed" | null;
}

type MorningBriefEnrollment = typeof morningBriefEnrollments.$inferSelect;

interface MorningBriefOwnership {
  readonly owner: MorningBriefMemberIdentity;
  /**
   * The one-time installation intent. `completed` records which installation
   * the enrollment owns; it never means the brief is enabled today.
   */
  readonly enrollment: MorningBriefEnrollment | undefined;
  /** The single installation the preference surface manages, if any. */
  readonly installation: MorningBriefInstallation | undefined;
}

/** The scheduled delivery an installed brief owns. Enabled state lives here. */
interface MorningBriefAutomationState {
  readonly id: string;
  readonly enabled: boolean;
  readonly intendedEnabled: boolean;
  readonly consecutiveFailures: number;
  readonly cronExpression: string | null;
  readonly timezone: string;
  readonly nextRunAt: Date | null;
}

/** Why an installed brief cannot be read as a working Morning Brief. */
type MorningBriefInconsistency =
  | "missing-automation"
  | "multiple-automations"
  | "unexpected-schedule"
  | "unreconciled-installation";

interface MorningBriefStateBase {
  readonly owner: MorningBriefMemberIdentity;
  readonly enrollment: MorningBriefEnrollment | undefined;
}

interface MorningBriefInstallationScope {
  readonly installation: MorningBriefInstallation;
  /**
   * The canonical workflow/user thread binding. `null` before the first
   * delivery creates the thread, which is a valid state rather than a failure.
   */
  readonly chatThreadId: string | null;
}

export type MorningBriefState =
  | (MorningBriefStateBase & { readonly kind: "absent" })
  | (MorningBriefStateBase &
      MorningBriefInstallationScope & { readonly kind: "pending" })
  | (MorningBriefStateBase &
      MorningBriefInstallationScope & {
        readonly kind: "installed";
        readonly automation: MorningBriefAutomationState;
      })
  | (MorningBriefStateBase &
      MorningBriefInstallationScope & {
        readonly kind: "inconsistent";
        readonly reason: MorningBriefInconsistency;
      });

const loadMorningBriefInstallation$ = command(
  async (
    { get },
    owner: MorningBriefMemberIdentity,
    signal: AbortSignal,
  ): Promise<MorningBriefInstallation | undefined> => {
    const db = get(db$);
    const [installation] = await db
      .select({
        id: workflows.id,
        installationState: workflows.officialInstallationState,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, owner.orgId),
          eq(workflows.ownerUserId, owner.userId),
          eq(workflows.visibility, "private"),
          inArray(workflows.officialDefinitionName, [
            ...MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES,
          ]),
        ),
      )
      .limit(1);

    signal.throwIfAborted();
    return installation;
  },
);

/** Resolve the member’s recorded installation, falling back to the oldest persisted one. */
export const loadMorningBriefOwnership$ = command(
  async (
    { get, set },
    owner: MorningBriefMemberIdentity,
    signal: AbortSignal,
  ): Promise<MorningBriefOwnership> => {
    const db = get(db$);
    const [enrollment] = await db
      .select()
      .from(morningBriefEnrollments)
      .where(morningBriefEnrollmentWhere(owner))
      .limit(1);
    signal.throwIfAborted();
    const installation = await set(
      loadMorningBriefInstallation$,
      owner,
      signal,
    );
    return { owner, enrollment, installation };
  },
);

const loadMorningBriefAutomationState$ = command(
  async (
    { get },
    owner: MorningBriefMemberIdentity,
    workflowId: string,
    signal: AbortSignal,
  ): Promise<MorningBriefAutomationState | MorningBriefInconsistency> => {
    const db = get(db$);
    const automations = await db
      .select({
        id: workflowAutomations.id,
        enabled: workflowAutomations.enabled,
        intendedEnabled: workflowAutomations.officialIntendedEnabled,
        consecutiveFailures: workflowAutomations.consecutiveFailures,
        nextRunAt: workflowAutomations.nextRunAt,
        timezone: workflowAutomations.timezone,
        cronExpression: workflowAutomations.cronExpression,
        kind: workflowAutomations.kind,
        scheduleType: workflowAutomations.scheduleType,
        blueprintKey: workflowAutomations.officialBlueprintKey,
        reconciliationStatus: workflowAutomations.officialReconciliationStatus,
      })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.orgId, owner.orgId),
          eq(workflowAutomations.ownerUserId, owner.userId),
          eq(workflowAutomations.workflowId, workflowId),
        ),
      );
    signal.throwIfAborted();
    const automation = automations[0];
    if (!automation) {
      return "missing-automation";
    }
    if (automations.length !== 1) {
      return "multiple-automations";
    }
    if (
      automation.kind !== "schedule" ||
      automation.scheduleType !== "cron" ||
      automation.blueprintKey !== MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY
    ) {
      return "unexpected-schedule";
    }
    if (
      automation.reconciliationStatus !== "current" ||
      automation.intendedEnabled === null
    ) {
      return "unreconciled-installation";
    }
    return {
      id: automation.id,
      enabled: automation.enabled,
      intendedEnabled: automation.intendedEnabled,
      consecutiveFailures: automation.consecutiveFailures,
      cronExpression: automation.cronExpression,
      timezone: automation.timezone,
      nextRunAt: automation.nextRunAt,
    };
  },
);

/**
 * Compose the member's authoritative Morning Brief state.
 *
 * This composes current reads, not a transaction snapshot. Re-read after a
 * conditional write when acting on these facts.
 */
export const loadMorningBriefState$ = command(
  async (
    { set },
    owner: MorningBriefMemberIdentity,
    signal: AbortSignal,
  ): Promise<MorningBriefState> => {
    const ownership = await set(loadMorningBriefOwnership$, owner, signal);
    const selected = ownership.installation;
    const base = {
      owner,
      enrollment: ownership.enrollment,
    };
    if (!selected) {
      return { ...base, kind: "absent" };
    }

    const [automation, chatThreadId] = await Promise.all([
      selected.installationState === "installed"
        ? set(loadMorningBriefAutomationState$, owner, selected.id, signal)
        : null,
      set(
        loadWorkflowUserAutomationThreadId$,
        {
          orgId: owner.orgId,
          userId: owner.userId,
          workflowId: selected.id,
        },
        signal,
      ),
    ]);
    signal.throwIfAborted();
    const scope = { ...base, installation: selected, chatThreadId };
    if (automation === null) {
      return { ...scope, kind: "pending" };
    }
    return typeof automation === "string"
      ? { ...scope, kind: "inconsistent", reason: automation }
      : { ...scope, kind: "installed", automation };
  },
);

const loadWorkflowUserAutomationThreadId$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const [binding] = await get(db$)
      .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
      .from(workflowUserAutomationThreads)
      .where(workflowUserAutomationThreadOwnerCondition(args))
      .limit(1);
    signal.throwIfAborted();
    return binding?.chatThreadId ?? null;
  },
);
