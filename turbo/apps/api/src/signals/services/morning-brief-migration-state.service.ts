import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { agents } from "@okouai/db/schema/agent";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { and, asc, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
import {
  loadMorningBriefEnrollment,
  type MorningBriefMemberIdentity,
} from "./morning-brief-enrollment-data.service";
import { loadWorkflowUserAutomationThreadId } from "./workflow-user-automation-thread.service";

/**
 * The canonical read of the Morning Brief state a member actually owns.
 *
 * The Settings surface and the `simple-morning-brief` migration must agree on
 * which installation a member owns and what that installation is really doing,
 * so both read it here. The rules this module encodes are described in
 * [the migration contract](../../../../../../docs/morning-brief-migration-state.md).
 */

/**
 * Any reader of the canonical state, including a transaction.
 *
 * Callers that act on the result read it inside the transaction or lock that
 * guards their mutation, so this deliberately admits more than a pooled `Db`.
 */
export type MorningBriefStateReader = Pick<ReadonlyDb, "select">;

interface MorningBriefInstallation {
  readonly id: string;
  readonly agentId: string;
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
  /** Every Morning Brief installation this member holds, oldest first. */
  readonly installations: readonly MorningBriefInstallation[];
  /** The single installation the preference surface manages, if any. */
  readonly installation: MorningBriefInstallation | undefined;
}

/** The scheduled delivery an installed brief owns. Enabled state lives here. */
interface MorningBriefAutomationState {
  readonly id: string;
  readonly enabled: boolean;
  readonly cronExpression: string | null;
  readonly timezone: string;
  readonly nextRunAt: Date | null;
}

/** Why an installed brief cannot be read as a working Morning Brief. */
type MorningBriefInconsistency =
  | "missing-automation"
  | "multiple-automations"
  | "unexpected-schedule"
  | "unreconciled-installation"
  | "result-email-disabled";

interface MorningBriefStateBase {
  readonly owner: MorningBriefMemberIdentity;
  readonly enrollment: MorningBriefEnrollment | undefined;
  /**
   * Installations this member holds beyond the managed one. Holding several is
   * legitimate: the catalog installs Morning Brief per Agent. They are
   * inventory for the migration and must never be adopted or mutated here.
   */
  readonly additionalInstallations: readonly MorningBriefInstallation[];
}

interface MorningBriefInstallationScope {
  readonly installation: MorningBriefInstallation;
  /**
   * The canonical workflow/user thread binding. `null` before the first
   * delivery creates the thread, which is a valid state rather than a failure.
   */
  readonly chatThreadId: string | null;
}

export type MorningBriefMigrationState =
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

/**
 * The Agent an org-wide Morning Brief action would use today.
 *
 * It backs both the adoption tie-break and the Settings availability check, so
 * a private Agent nobody else may use resolves to no default at all.
 */
export async function loadMorningBriefDefaultAgentId(
  db: MorningBriefStateReader,
  owner: MorningBriefMemberIdentity,
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
    .where(eq(orgMetadata.orgId, owner.orgId))
    .limit(1);
  if (
    !defaultAgent?.id ||
    (defaultAgent.visibility === "private" &&
      defaultAgent.owner !== owner.userId)
  ) {
    return null;
  }
  return defaultAgent.id;
}

/** Oldest first, so the adoption tie-break reads the head of this list. */
async function loadMorningBriefInstallations(
  db: MorningBriefStateReader,
  owner: MorningBriefMemberIdentity,
): Promise<readonly MorningBriefInstallation[]> {
  return await db
    .select({
      id: workflows.id,
      installationState: workflows.officialInstallationState,
      agentId: workflows.agentId,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, owner.orgId),
        eq(workflows.ownerUserId, owner.userId),
        eq(workflows.visibility, "private"),
        eq(
          workflows.officialDefinitionName,
          MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
        ),
      ),
    )
    .orderBy(asc(workflows.createdAt), asc(workflows.id));
}

/**
 * Resolve the one installation the enrollment owns.
 *
 * The catalog installs Morning Brief per Agent, so a member may legally hold
 * several installations. The enrollment records which one the preference
 * surface manages. That record can be absent — rows written before the column
 * existed, or a member who never enrolled — and it can be stale once its
 * installation is uninstalled, so fall back to the adoption rule: the
 * installation on the org's current default Agent, otherwise the oldest.
 * Installations that are not adopted keep running untouched.
 */
export async function loadMorningBriefOwnership(
  db: MorningBriefStateReader,
  owner: MorningBriefMemberIdentity,
): Promise<MorningBriefOwnership> {
  const enrollment = await loadMorningBriefEnrollment(db, owner);
  const installations = await loadMorningBriefInstallations(db, owner);
  if (installations.length <= 1) {
    return { owner, enrollment, installations, installation: installations[0] };
  }
  const owned = installations.find(({ id }) => {
    return id === enrollment?.workflowId;
  });
  if (owned) {
    return { owner, enrollment, installations, installation: owned };
  }
  const defaultAgentId = await loadMorningBriefDefaultAgentId(db, owner);
  const adopted =
    installations.find(({ agentId }) => {
      return agentId === defaultAgentId;
    }) ?? installations[0];
  return { owner, enrollment, installations, installation: adopted };
}

async function loadMorningBriefAutomationState(
  db: MorningBriefStateReader,
  owner: MorningBriefMemberIdentity,
  workflowId: string,
): Promise<MorningBriefAutomationState | MorningBriefInconsistency> {
  const automations = await db
    .select({
      id: workflowAutomations.id,
      enabled: workflowAutomations.enabled,
      nextRunAt: workflowAutomations.nextRunAt,
      timezone: workflowAutomations.timezone,
      cronExpression: workflowAutomations.cronExpression,
      kind: workflowAutomations.kind,
      scheduleType: workflowAutomations.scheduleType,
      blueprintKey: workflowAutomations.officialBlueprintKey,
      reconciliationStatus: workflowAutomations.officialReconciliationStatus,
      resultEmailEnabled: workflowAutomations.officialResultEmailEnabled,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, owner.orgId),
        eq(workflowAutomations.ownerUserId, owner.userId),
        eq(workflowAutomations.workflowId, workflowId),
      ),
    );
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
  if (automation.reconciliationStatus !== "current") {
    return "unreconciled-installation";
  }
  if (automation.resultEmailEnabled !== true) {
    return "result-email-disabled";
  }
  return {
    id: automation.id,
    enabled: automation.enabled,
    cronExpression: automation.cronExpression,
    timezone: automation.timezone,
    nextRunAt: automation.nextRunAt,
  };
}

/**
 * Compose the member's authoritative Morning Brief state.
 *
 * This is a read, not a snapshot: call it inside the caller's transaction or
 * preference lock when the result has to stay true while acting on it.
 */
export async function loadMorningBriefMigrationState(
  db: MorningBriefStateReader,
  owner: MorningBriefMemberIdentity,
): Promise<MorningBriefMigrationState> {
  const ownership = await loadMorningBriefOwnership(db, owner);
  const selected = ownership.installation;
  const additionalInstallations = ownership.installations.filter(({ id }) => {
    return id !== selected?.id;
  });
  const base = {
    owner,
    enrollment: ownership.enrollment,
    additionalInstallations,
  };
  if (!selected) {
    return { ...base, kind: "absent" };
  }

  const [automation, chatThreadId] = await Promise.all([
    selected.installationState === "installed"
      ? loadMorningBriefAutomationState(db, owner, selected.id)
      : null,
    loadWorkflowUserAutomationThreadId(db, {
      orgId: owner.orgId,
      userId: owner.userId,
      workflowId: selected.id,
    }),
  ]);
  const scope = { ...base, installation: selected, chatThreadId };
  if (automation === null) {
    return { ...scope, kind: "pending" };
  }
  return typeof automation === "string"
    ? { ...scope, kind: "inconsistent", reason: automation }
    : { ...scope, kind: "installed", automation };
}
