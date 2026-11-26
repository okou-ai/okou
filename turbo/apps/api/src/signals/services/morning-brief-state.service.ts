import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq, inArray } from "drizzle-orm";

import { command } from "ccstate";
import { db$ } from "../external/db";
import {
  morningBriefEnrollmentWhere,
  type MorningBriefMemberIdentity,
} from "./morning-brief-enrollment-data.service";
interface MorningBriefInstallation {
  readonly id: string;
}

type MorningBriefEnrollment = typeof morningBriefEnrollments.$inferSelect;

interface MorningBriefOwnership {
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
  readonly nextRunAt: Date | null;
}

export type MorningBriefState =
  | {
      readonly kind: "absent";
      readonly enrollment: MorningBriefEnrollment | undefined;
    }
  | {
      readonly kind: "installed";
      readonly installation: MorningBriefInstallation;
      readonly automation: MorningBriefAutomationState;
    }
  | {
      readonly kind: "inconsistent";
      readonly installation: MorningBriefInstallation;
    };

const loadMorningBriefInstallation$ = command(
  async (
    { get },
    owner: MorningBriefMemberIdentity,
    signal: AbortSignal,
  ): Promise<MorningBriefInstallation | undefined> => {
    const db = get(db$);
    const [installation] = await db
      .select({ id: workflows.id })
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

/** An owner has at most one Morning Brief installation across both definition names. */
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
    return { enrollment, installation };
  },
);

const loadMorningBriefAutomationState$ = command(
  async (
    { get },
    owner: MorningBriefMemberIdentity,
    workflowId: string,
    signal: AbortSignal,
  ): Promise<MorningBriefAutomationState | undefined> => {
    const db = get(db$);
    const automations = await db
      .select({
        id: workflowAutomations.id,
        enabled: workflowAutomations.enabled,
        intendedEnabled: workflowAutomations.officialIntendedEnabled,
        consecutiveFailures: workflowAutomations.consecutiveFailures,
        nextRunAt: workflowAutomations.nextRunAt,
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
    if (
      automations.length !== 1 ||
      !automation ||
      automation.kind !== "schedule" ||
      automation.scheduleType !== "cron" ||
      automation.blueprintKey !== MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY ||
      automation.reconciliationStatus !== "current" ||
      automation.intendedEnabled === null
    ) {
      return undefined;
    }
    return {
      id: automation.id,
      enabled: automation.enabled,
      intendedEnabled: automation.intendedEnabled,
      consecutiveFailures: automation.consecutiveFailures,
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
    const { enrollment, installation } = await set(
      loadMorningBriefOwnership$,
      owner,
      signal,
    );
    if (!installation) {
      return { kind: "absent", enrollment };
    }
    const automation = await set(
      loadMorningBriefAutomationState$,
      owner,
      installation.id,
      signal,
    );
    signal.throwIfAborted();
    return automation
      ? { kind: "installed", installation, automation }
      : { kind: "inconsistent", installation };
  },
);
