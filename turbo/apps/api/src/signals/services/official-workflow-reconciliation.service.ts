import { isDeepStrictEqual } from "node:util";

import type {
  OfficialWorkflowAcceptedBlueprint,
  OfficialWorkflowAcceptedDefinition,
  OfficialWorkflowParameterBinding,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import {
  googleFormsResponseSubmittedEventConfigSchema,
  stripeInvoicePaidEventConfigSchema,
} from "@okouai/api-contracts/contracts/workflows";

import { connectors } from "@okouai/db/schema/connector";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { variables } from "@okouai/db/schema/variable";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import {
  officialWorkflowAutomationIdentities,
  workflowAutomations,
  workflows,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";

import {
  webhookTierLockStatement,
  webhookTierFromRows,
  webhookTierRowSchema,
  activeAutomationIdentityUpsertStatement,
  installationUpdatedStatement,
  deleteGoogleFormsCursorStatement,
  acceptedBlueprintDefinitionFromRows,
  acceptedRevisionBlueprintRowsMatch,
  matchingAcceptedBlueprintDefinition,
  acceptedRevisionBlueprintMatches,
  type AcceptedBlueprintIdentity,
  installedWorkflowLockStatement,
  activeAutomationIdentityLockStatement,
  automationWebhookReadStatement,
  acceptedCatalogRowSchema,
  acceptedCatalogReadStatement,
  acceptedCatalogLockStatement,
  acceptedRevisionRowSchema,
  acceptedRevisionReadStatement,
  officialWebhookSubtypeMutation,
} from "./official-workflow-reconciliation-sql";
import { parseRawRows } from "../../lib/db-raw-rows";
import {
  officialAccountProjectionReadPlan,
  officialAccountProjectionFromRow,
  type OfficialAutomationAccountProjection,
} from "./official-workflow-account-projection";

import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  ensureAutomationEventWatchReconfiguration$,
  reconcileAutomationEventWatchInventoryForOwner$,
  reconcileAutomationEventWatches$,
  reconcileAutomationEventWatchReconfiguration$,
} from "./automation-event-watch-lifecycle.service";
import {
  googleFormsCursorMustReset,
  googleFormsCursorPublicationStatement,
} from "./google-forms-cursor-lifecycle";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { reconcileOfficialGoogleFormsConfiguration$ } from "./official-google-forms-reconfiguration.service";
import { observedWorkflowAutomationCondition } from "./workflow-automation-snapshot";
import { notionConfigWithConnectorId } from "./notion-automation-account.service";
import {
  acceptedCatalogFromRow,
  type AcceptedOfficialWorkflowCatalog,
  readAcceptedOfficialWorkflowCatalog$,
  readAcceptedOfficialWorkflowRevision$,
} from "./official-workflow-catalog-read.service";
import type {
  OfficialWorkflowReconciliationArgs,
  OfficialWorkflowReconciliationResult,
} from "./official-workflow-reconciliation.types";
import {
  buildOfficialAutomationPatch,
  officialAutomationRestorePatch,
  refreshOfficialAutomationPatch,
  resolveOfficialWorkflowBlueprintForReconciliation,
  type OfficialAutomationPatch,
  type OfficialAutomationRow,
  type ResolvedBlueprint,
} from "./official-workflow-installation.service";
import {
  createWorkflowAutomation$,
  enableWorkflowAutomation$,
  prepareOfficialAutomationReconfiguration$,
  type AutomationResult,
  type CreateAutomationInput,
  type OfficialAutomationEventPreparation,
} from "./workflow-automation.service";
import type { WorkflowMember } from "./workflow-data.service";

import { workflowAutomationAccountConnectorSlug } from "./workflow-automation-account-classification.service";

const DORMANT_CREATION_LEASE_MS = 5 * 60 * 1000;

export type ReconcileOfficialWorkflowInstallationArgs =
  OfficialWorkflowReconciliationArgs;

export type { OfficialWorkflowReconciliationResult };

interface ReconciliationContext {
  readonly definition: OfficialWorkflowAcceptedDefinition;
  readonly blueprints: readonly OfficialWorkflowAcceptedBlueprint[];
  readonly automations: readonly OfficialAutomationRow[];
  readonly identities: readonly (typeof officialWorkflowAutomationIdentities.$inferSelect)[];
}

interface PersistedReconfiguration {
  readonly previous: OfficialAutomationRow;
  readonly current: OfficialAutomationRow;
}

/** Reconfiguration must leave the current Official claim's empty slot for its completion callback. */
function reconciledScheduleAnchor(
  automation: OfficialAutomationRow,
  nextRunAt: Date | null,
) {
  if (
    automation.officialBlueprintKey !== MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY ||
    nextRunAt === null
  ) {
    return nextRunAt;
  }
  return sql`CASE WHEN (SELECT settlement FROM morning_brief_schedule_claims WHERE automation_id = ${automation.id}::uuid ORDER BY claim_sequence DESC LIMIT 1) = 'unsettled' THEN NULL ELSE ${nextRunAt}::timestamp END`;
}

function isMorningBriefReconciliation(args: {
  readonly definitionName: string;
  readonly blueprintKey: string | null;
}): boolean {
  return (
    args.definitionName === MORNING_BRIEF_OFFICIAL_DEFINITION_NAME &&
    args.blueprintKey === MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY
  );
}

function failureMessage(result: AutomationResult) {
  return "message" in result
    ? result.message
    : "Official Workflow automation lifecycle failed";
}

function eventWatchFailureMessage(result: {
  readonly kind: "ok" | "bad-request";
  readonly message?: string;
}): string {
  return result.kind === "bad-request" && result.message
    ? result.message
    : "Official Workflow event-watch reconciliation failed";
}

function accountProjectionMatchesPatch(
  projection: OfficialAutomationAccountProjection,
  patch: OfficialAutomationPatch,
): boolean {
  if (projection.kind === "not-required") {
    return true;
  }
  if (projection.eventConnectorId !== patch.eventConnectorId) {
    return false;
  }
  if (projection.connectorSlug === "google-forms") {
    const config = googleFormsResponseSubmittedEventConfigSchema.safeParse(
      patch.eventConfig,
    );
    return (
      config.success && config.data.connectorId === projection.eventConnectorId
    );
  }
  if (projection.connectorSlug !== "stripe") {
    return true;
  }
  if (projection.stripeBinding === null) {
    return false;
  }
  const config = stripeInvoicePaidEventConfigSchema.safeParse(
    patch.eventConfig,
  );
  return (
    config.success &&
    config.data.connectorId === projection.stripeBinding.connectorId &&
    config.data.stripeAccountId === projection.stripeBinding.stripeAccountId &&
    config.data.mode === projection.stripeBinding.mode
  );
}

function blueprintAuthorityIdentity(args: {
  readonly definitionName: string;
  readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  readonly activeDefinitionOnly: boolean;
}): AcceptedBlueprintIdentity {
  return {
    definitionName: args.definitionName,
    blueprintKey: args.blueprint.key,
    fingerprint: args.blueprint.fingerprint,
    activeDefinitionOnly: args.activeDefinitionOnly,
  };
}

function installedWorkflowCondition(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly definitionName: string;
  },
  workflowId: string,
) {
  return sql`${workflows.id} = ${workflowId}::uuid
    AND ${workflows.orgId} = ${args.orgId}
    AND ${workflows.ownerUserId} = ${args.userId}
    AND ${workflows.officialDefinitionName} = ${args.definitionName}
    AND ${workflows.officialInstallationState} = 'installed'`;
}

function activeIdentityValues(
  automation: OfficialAutomationRow,
  currentTime: Date,
) {
  if (!automation.officialBlueprintKey) {
    throw new Error("Official Workflow automation identity is incomplete");
  }
  return {
    id: automation.id,
    workflowId: automation.workflowId,
    automationId: automation.id,
    blueprintKey: automation.officialBlueprintKey,
    state: "active" as const,
    retainedParameterBindings: null,
    retainedIntendedEnabled: null,
    retainedAppliedFingerprint: null,
    createdAt: currentTime,
    updatedAt: currentTime,
  };
}

function activeIdentityUpdate(
  automation: OfficialAutomationRow,
  currentTime: Date,
) {
  return {
    automationId: automation.id,
    state: "active" as const,
    retainedParameterBindings: null,
    retainedIntendedEnabled: null,
    retainedAppliedFingerprint: null,
    updatedAt: currentTime,
  };
}

function activeIdentityConflict(
  automation: OfficialAutomationRow,
  currentTime: Date,
) {
  return {
    target: [
      officialWorkflowAutomationIdentities.workflowId,
      officialWorkflowAutomationIdentities.blueprintKey,
    ],
    set: activeIdentityUpdate(automation, currentTime),
  };
}

function activeIdentityOwnershipCondition(automation: OfficialAutomationRow) {
  if (!automation.officialBlueprintKey) {
    throw new Error("Official Workflow automation identity is incomplete");
  }
  return sql`${officialWorkflowAutomationIdentities.id} = ${automation.id}::uuid
    AND ${officialWorkflowAutomationIdentities.workflowId} = ${automation.workflowId}::uuid
    AND ${officialWorkflowAutomationIdentities.automationId} = ${automation.id}::uuid
    AND ${officialWorkflowAutomationIdentities.blueprintKey} = ${automation.officialBlueprintKey}
    AND ${officialWorkflowAutomationIdentities.state} = 'active'`;
}

function structureTransitionSourceIsCurrent(
  current: OfficialAutomationRow | undefined,
  expected: OfficialAutomationRow,
): current is OfficialAutomationRow {
  return (
    current !== undefined &&
    current.updatedAt.getTime() === expected.updatedAt.getTime() &&
    current.officialReconciliationStatus === "reconciling" &&
    Boolean(current.officialBlueprintKey)
  );
}

function assertStructureCursorPublished(rowCount: number | null) {
  if (rowCount !== 1) {
    throw new Error(
      "Google Forms structure watch disappeared before publication",
    );
  }
}

const loadReconciliationContext$ = command(
  async (
    { get, set },
    args: ReconcileOfficialWorkflowInstallationArgs,
    signal: AbortSignal,
  ): Promise<ReconciliationContext | null> => {
    const db = get(db$);
    const [workflow] = await db
      .select({ definitionName: workflows.officialDefinitionName })
      .from(workflows)
      .where(
        and(
          eq(workflows.id, args.workflowId),
          eq(workflows.orgId, args.orgId),
          eq(workflows.ownerUserId, args.member.userId),
          eq(workflows.officialInstallationState, "installed"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!workflow?.definitionName) {
      return null;
    }
    const catalog = await set(readAcceptedOfficialWorkflowCatalog$, signal);
    const definition = catalog?.payload.definitions.find((candidate) => {
      return candidate.name === workflow.definitionName;
    });
    if (!definition) {
      return null;
    }
    if (
      args.activeDefinitionOnly === true &&
      definition.lifecycle !== "active"
    ) {
      return null;
    }
    const revision = await set(
      readAcceptedOfficialWorkflowRevision$,
      { name: definition.name, revision: definition.revision },
      signal,
    );
    if (!revision) {
      throw new Error("Accepted Official Workflow revision is unavailable");
    }
    const [automations, identities] = await Promise.all([
      db
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(eq(workflowAutomations.workflowId, args.workflowId))
        .orderBy(asc(workflowAutomations.officialBlueprintKey)),
      db
        .select()
        .from(officialWorkflowAutomationIdentities)
        .where(
          eq(officialWorkflowAutomationIdentities.workflowId, args.workflowId),
        )
        .orderBy(asc(officialWorkflowAutomationIdentities.blueprintKey)),
    ]);
    signal.throwIfAborted();
    return {
      definition,
      blueprints: revision.definition.blueprints,
      automations,
      identities,
    };
  },
);

function sameAutomationBaseline(
  expected: OfficialAutomationRow,
  current: OfficialAutomationRow,
): boolean {
  return (
    expected.id === current.id &&
    expected.updatedAt.getTime() === current.updatedAt.getTime() &&
    expected.officialBlueprintKey === current.officialBlueprintKey &&
    expected.officialAppliedFingerprint ===
      current.officialAppliedFingerprint &&
    expected.officialReconciliationStatus ===
      current.officialReconciliationStatus &&
    expected.enabled === current.enabled &&
    expected.officialIntendedEnabled === current.officialIntendedEnabled &&
    expected.officialResultEmailEnabled === current.officialResultEmailEnabled
  );
}

function sameAutomationConfigurationBaseline(
  expected: OfficialAutomationRow,
  current: OfficialAutomationRow,
): boolean {
  return (
    expected.id === current.id &&
    expected.workflowId === current.workflowId &&
    expected.kind === current.kind &&
    expected.eventType === current.eventType &&
    isDeepStrictEqual(expected.eventConfig, current.eventConfig) &&
    expected.scheduleType === current.scheduleType &&
    expected.cronExpression === current.cronExpression &&
    expected.intervalSeconds === current.intervalSeconds &&
    (expected.atTime === null || current.atTime === null
      ? expected.atTime === current.atTime
      : expected.atTime.getTime() === current.atTime.getTime()) &&
    expected.timezone === current.timezone &&
    expected.autonomyBudget === current.autonomyBudget &&
    expected.officialBlueprintKey === current.officialBlueprintKey &&
    expected.officialAppliedFingerprint ===
      current.officialAppliedFingerprint &&
    expected.officialReconciliationStatus ===
      current.officialReconciliationStatus &&
    isDeepStrictEqual(
      expected.officialParameterBindings,
      current.officialParameterBindings,
    ) &&
    expected.officialResultEmailEnabled === current.officialResultEmailEnabled
  );
}

function reconfigurationSourceCondition(expected: OfficialAutomationRow) {
  // Forms preparation belongs to one exact consumption interval. Other
  // configuration preparation may overlap an independent user pause: reread
  // that intent under ownership, validate the configuration below and retain
  // the current enabled/intended-enabled values when applying the patch.
  return expected.eventType === "google-forms-response-submitted"
    ? observedWorkflowAutomationCondition(expected)
    : eq(workflowAutomations.id, expected.id);
}

const persistReconfigurationPatch$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly definitionName: string;
      readonly blueprint: OfficialWorkflowAcceptedBlueprint;
      readonly activeDefinitionOnly: boolean;
      readonly expected: OfficialAutomationRow;
      readonly patch: OfficialAutomationPatch;
      readonly preparation: OfficialAutomationEventPreparation | undefined;
    },
    signal: AbortSignal,
  ): Promise<PersistedReconfiguration | null> => {
    const db = set(writeDb$);

    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0197; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // SHARE fences the accepted pointer against the publisher's non-key UPDATE.
      await tx.execute(acceptedCatalogLockStatement());
      const [catalogRow] = parseRawRows(
        acceptedCatalogRowSchema,
        await tx.execute(acceptedCatalogReadStatement()),
      );
      signal.throwIfAborted();
      const catalogIdentity = blueprintAuthorityIdentity(args);
      const acceptedDefinition = matchingAcceptedBlueprintDefinition(
        acceptedCatalogFromRow(catalogRow),
        catalogIdentity,
      );
      if (!acceptedDefinition) {
        return null;
      }
      const [revisionRow] = parseRawRows(
        acceptedRevisionRowSchema,
        await tx.execute(acceptedRevisionReadStatement(acceptedDefinition)),
      );
      signal.throwIfAborted();
      if (!acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)) {
        return null;
      }
      const projectionArgs = {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.expected.workflowId,
        currentEventType: args.expected.eventType,
        nextEventType: args.patch.eventType,
      };
      const accountPlan = officialAccountProjectionReadPlan(projectionArgs);
      const accountRows = accountPlan.required
        ? await tx
            .select(accountPlan.columns)
            .from(accountPlan.source)
            .leftJoin(connectorCatalog, accountPlan.catalogJoin)
            .leftJoin(connectorCatalogEntries, accountPlan.entryJoin)
            .leftJoin(connectors, accountPlan.connectionJoin)
            .leftJoin(variables, accountPlan.variableJoin)
        : [];
      if (accountPlan.required) {
        signal.throwIfAborted();
      }
      const accountProjection = officialAccountProjectionFromRow(
        accountPlan,
        accountRows[0],
      );
      const [installedWorkflow] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(installedWorkflowCondition(args, args.expected.workflowId))
        .for("update")
        .limit(1);
      if (!installedWorkflow) {
        return null;
      }
      const [current] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(reconfigurationSourceCondition(args.expected))
        .for("update")
        .limit(1);
      if (
        !current ||
        !sameAutomationConfigurationBaseline(args.expected, current)
      ) {
        return null;
      }
      if (!accountProjectionMatchesPatch(accountProjection, args.patch)) {
        return null;
      }
      const currentTime = nowDate();
      const enabled =
        current.officialIntendedEnabled === true || current.enabled;
      const refreshed = refreshOfficialAutomationPatch(
        current,
        { ...args.patch, enabled },
        currentTime,
      );
      const [updated] = await tx
        .update(workflowAutomations)
        .set({
          ...refreshed,
          nextRunAt: reconciledScheduleAnchor(current, refreshed.nextRunAt),
        })
        .where(eq(workflowAutomations.id, current.id))
        .returning(workflowAutomationColumns());
      if (!updated) {
        throw new Error("Official Workflow automation disappeared");
      }
      if (googleFormsCursorMustReset(current, updated)) {
        await tx
          .delete(googleFormsAutomationCursors)
          .where(eq(googleFormsAutomationCursors.automationId, current.id));
      }
      await tx
        .insert(officialWorkflowAutomationIdentities)
        .values(activeIdentityValues(updated, currentTime))
        .onConflictDoUpdate(activeIdentityConflict(updated, currentTime));
      return {
        previous: current,
        current: updated,
      };
    });
  },
);

function restoredNotionEventConfig(
  projection: OfficialAutomationAccountProjection,
  previous: OfficialAutomationRow,
) {
  return projection.kind === "projected" &&
    projection.eventConnectorId !== null &&
    workflowAutomationAccountConnectorSlug(previous.eventType) === "notion"
    ? notionConfigWithConnectorId(
        previous.eventType,
        previous.eventConfig,
        projection.eventConnectorId,
      )
    : null;
}
const reconcileRestoredAutomationWatch$ = command(
  async (
    { set },
    persisted: PersistedReconfiguration,
    restored: OfficialAutomationRow,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      reconcileAutomationEventWatchReconfiguration$,
      {
        previous: [persisted.current],
        current: [restored],
        googleForms: [],
      },
      signal,
    );
  },
);
function restoredStripeEventConfig(
  projection: OfficialAutomationAccountProjection,
  eventConfig: unknown,
) {
  const binding =
    projection.kind === "projected" ? projection.stripeBinding : null;
  return binding === null
    ? {}
    : {
        eventConfig: {
          ...stripeInvoicePaidEventConfigSchema.parse(eventConfig),
          ...binding,
        },
      };
}

function restoredAutomationAccountFields(
  projection: OfficialAutomationAccountProjection,
  previous: OfficialAutomationRow,
  eventConfig: OfficialAutomationRow["eventConfig"],
) {
  const notion = restoredNotionEventConfig(projection, previous);
  return {
    ...(projection.kind === "projected"
      ? {
          eventConnectorId: projection.eventConnectorId,
          ...(notion === null ? {} : { eventConfig: notion }),
        }
      : {}),
    ...restoredStripeEventConfig(projection, eventConfig),
  };
}

const restoreFailedReconfiguration$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly definitionName: string;
      readonly persisted: PersistedReconfiguration;
    },
  ): Promise<void> => {
    const db = set(writeDb$);
    const cleanupSignal = new AbortController().signal;
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0198; new non-billing transactions are prohibited.
    const restored = await db.transaction(async (tx) => {
      // SHARE fences the accepted pointer against the publisher's non-key UPDATE.
      await tx.execute(acceptedCatalogLockStatement());
      const projectionArgs = {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.persisted.previous.workflowId,
        currentEventType: args.persisted.current.eventType,
        nextEventType: args.persisted.previous.eventType,
      };
      const accountPlan = officialAccountProjectionReadPlan(projectionArgs);
      const accountRows = accountPlan.required
        ? await tx
            .select(accountPlan.columns)
            .from(accountPlan.source)
            .leftJoin(connectorCatalog, accountPlan.catalogJoin)
            .leftJoin(connectorCatalogEntries, accountPlan.entryJoin)
            .leftJoin(connectors, accountPlan.connectionJoin)
            .leftJoin(variables, accountPlan.variableJoin)
        : [];
      if (accountPlan.required) {
        cleanupSignal.throwIfAborted();
      }
      const accountProjection = officialAccountProjectionFromRow(
        accountPlan,
        accountRows[0],
      );
      const [installationLockedRow] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          installedWorkflowCondition(args, args.persisted.previous.workflowId),
        )
        .for("update")
        .limit(1);
      const installationLocked = installationLockedRow !== undefined;
      if (!installationLocked) {
        return null;
      }
      const [current] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(observedWorkflowAutomationCondition(args.persisted.current))
        .for("update")
        .limit(1);
      if (
        !current ||
        current.updatedAt.getTime() !==
          args.persisted.current.updatedAt.getTime()
      ) {
        return null;
      }
      const currentTime = nowDate();
      const restorePatch = officialAutomationRestorePatch(
        args.persisted.previous,
        args.persisted.previous.nextRunAt,
        currentTime,
      );
      const [row] = await tx
        .update(workflowAutomations)
        .set({
          ...restorePatch,
          nextRunAt: reconciledScheduleAnchor(current, restorePatch.nextRunAt),
          ...restoredAutomationAccountFields(
            accountProjection,
            args.persisted.previous,
            restorePatch.eventConfig,
          ),
          enabled: args.persisted.previous.enabled,
          officialIntendedEnabled:
            args.persisted.previous.officialIntendedEnabled,
          officialReconciliationStatus: "failed",
        })
        .where(eq(workflowAutomations.id, current.id))
        .returning(workflowAutomationColumns());
      if (!row) {
        return null;
      }
      if (googleFormsCursorMustReset(current, row)) {
        await tx
          .delete(googleFormsAutomationCursors)
          .where(eq(googleFormsAutomationCursors.automationId, current.id));
      }
      await tx
        .insert(officialWorkflowAutomationIdentities)
        .values(activeIdentityValues(row, currentTime))
        .onConflictDoUpdate(activeIdentityConflict(row, currentTime));
      return row;
    });
    if (restored) {
      await set(
        reconcileRestoredAutomationWatch$,
        args.persisted,
        restored,
        cleanupSignal,
      );
    }
  },
);

const finalizeReconfiguration$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly definitionName: string;
      readonly blueprint: OfficialWorkflowAcceptedBlueprint;
      readonly activeDefinitionOnly: boolean;
      readonly persisted: PersistedReconfiguration;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);

    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0199; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // SHARE fences the accepted pointer against the publisher's non-key UPDATE.
      await tx.execute(acceptedCatalogLockStatement());
      const [catalogRow] = parseRawRows(
        acceptedCatalogRowSchema,
        await tx.execute(acceptedCatalogReadStatement()),
      );
      signal.throwIfAborted();
      const catalogIdentity = blueprintAuthorityIdentity(args);
      const acceptedDefinition = matchingAcceptedBlueprintDefinition(
        acceptedCatalogFromRow(catalogRow),
        catalogIdentity,
      );
      if (!acceptedDefinition) {
        return false;
      }
      const [revisionRow] = parseRawRows(
        acceptedRevisionRowSchema,
        await tx.execute(acceptedRevisionReadStatement(acceptedDefinition)),
      );
      signal.throwIfAborted();
      if (!acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)) {
        return false;
      }
      const [installationLockedRow] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          installedWorkflowCondition(args, args.persisted.current.workflowId),
        )
        .for("update")
        .limit(1);
      const installationLocked = installationLockedRow !== undefined;
      if (!installationLocked) {
        return false;
      }
      const [current] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(observedWorkflowAutomationCondition(args.persisted.current))
        .for("update")
        .limit(1);
      if (
        !current ||
        current.updatedAt.getTime() !==
          args.persisted.current.updatedAt.getTime() ||
        current.officialReconciliationStatus !== "reconciling" ||
        current.officialAppliedFingerprint !== args.blueprint.fingerprint
      ) {
        return false;
      }
      const currentTime = nowDate();
      const [finalized] = await tx
        .update(workflowAutomations)
        .set({
          officialReconciliationStatus: "current",
          updatedAt: currentTime,
        })
        .where(eq(workflowAutomations.id, current.id))
        .returning(workflowAutomationColumns());
      if (!finalized) {
        return false;
      }
      await tx
        .insert(officialWorkflowAutomationIdentities)
        .values(activeIdentityValues(finalized, currentTime))
        .onConflictDoUpdate(activeIdentityConflict(finalized, currentTime));
      await tx
        .update(workflows)
        .set({ updatedBy: args.userId, updatedAt: currentTime })
        .where(eq(workflows.id, finalized.workflowId));
      return true;
    });
  },
);

function needsReconfigurationResult(
  workflowId: string,
  blueprintKey: string,
): OfficialWorkflowReconciliationResult {
  return {
    kind: "needs-reconfiguration",
    workflowId,
    message: `Official Workflow Blueprint requires configuration: ${blueprintKey}`,
  };
}
function retryReconciliation(
  workflowId: string,
  message = "Official Workflow reconciliation was superseded",
): OfficialWorkflowReconciliationResult {
  return { kind: "retry", workflowId, message };
}

interface PauseForReconfigurationArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly definitionName: string;
  readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  readonly activeDefinitionOnly: boolean;
  readonly automation: OfficialAutomationRow;
  readonly bindings: readonly OfficialWorkflowParameterBinding[];
}
const persistPausedReconfiguration$ = command(
  async ({ set }, args: PauseForReconfigurationArgs, signal: AbortSignal) => {
    const db = set(writeDb$);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0200; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // SHARE fences the accepted pointer against the publisher's non-key UPDATE.
      await tx.execute(acceptedCatalogLockStatement());
      const [catalogRow] = parseRawRows(
        acceptedCatalogRowSchema,
        await tx.execute(acceptedCatalogReadStatement()),
      );
      signal.throwIfAborted();
      const catalogIdentity = blueprintAuthorityIdentity(args);
      const acceptedDefinition = matchingAcceptedBlueprintDefinition(
        acceptedCatalogFromRow(catalogRow),
        catalogIdentity,
      );
      if (!acceptedDefinition) {
        return null;
      }
      const [revisionRow] = parseRawRows(
        acceptedRevisionRowSchema,
        await tx.execute(acceptedRevisionReadStatement(acceptedDefinition)),
      );
      signal.throwIfAborted();
      if (!acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)) {
        return null;
      }
      const [installationLockedRow] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(installedWorkflowCondition(args, args.automation.workflowId))
        .for("update")
        .limit(1);
      const installationLocked = installationLockedRow !== undefined;
      if (!installationLocked) {
        return null;
      }
      const [current] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(observedWorkflowAutomationCondition(args.automation))
        .for("update")
        .limit(1);
      if (!current || !sameAutomationBaseline(args.automation, current)) {
        return null;
      }
      const currentTime = nowDate();
      const [paused] = await tx
        .update(workflowAutomations)
        .set({
          enabled: false,
          nextRunAt: null,
          officialParameterBindings: [...args.bindings],
          officialReconciliationStatus: "needs_reconfiguration",
          updatedAt: currentTime,
        })
        .where(eq(workflowAutomations.id, current.id))
        .returning(workflowAutomationColumns());
      if (!paused) {
        return null;
      }
      await tx
        .insert(officialWorkflowAutomationIdentities)
        .values(activeIdentityValues(paused, currentTime))
        .onConflictDoUpdate(activeIdentityConflict(paused, currentTime));
      return {
        previous: current,
        current: paused,
      };
    });
  },
);
const pauseForReconfiguration$ = command(
  async (
    { set },
    args: PauseForReconfigurationArgs,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult> => {
    const persisted = await set(persistPausedReconfiguration$, args, signal);
    if (!persisted) {
      return retryReconciliation(args.automation.workflowId);
    }
    const lifecycle = await settle(
      set(
        reconcileAutomationEventWatchReconfiguration$,
        {
          previous: [persisted.previous],
          current: [persisted.current],
          googleForms: [],
        },
        signal,
      ),
      signal,
    );
    if (!lifecycle.ok || lifecycle.value.kind !== "ok") {
      await set(restoreFailedReconfiguration$, {
        orgId: args.orgId,
        userId: args.userId,
        definitionName: args.definitionName,
        persisted,
      });
      signal.throwIfAborted();
      return retryReconciliation(
        args.automation.workflowId,
        lifecycle.ok
          ? eventWatchFailureMessage(lifecycle.value)
          : "Official Workflow event-watch reconciliation failed",
      );
    }
    return needsReconfigurationResult(
      args.automation.workflowId,
      args.blueprint.key,
    );
  },
);

interface ExistingAutomationReconciliationArgs {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly definitionName: string;
  readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  readonly activeDefinitionOnly: boolean;
  readonly automation: OfficialAutomationRow;
  readonly overrides: readonly OfficialWorkflowParameterBinding[];
  readonly userTimezone: string | null;
}

type PreparedExistingAutomationReconfiguration =
  | {
      readonly kind: "ready";
      readonly patch: OfficialAutomationPatch;
      readonly preparation: OfficialAutomationEventPreparation | undefined;
    }
  | {
      readonly kind: "result";
      readonly result: OfficialWorkflowReconciliationResult;
    };
const prepareExistingAutomationReconfiguration$ = command(
  async (
    { set },
    args: ExistingAutomationReconciliationArgs,
    signal: AbortSignal,
  ): Promise<PreparedExistingAutomationReconfiguration> => {
    const resolution = resolveOfficialWorkflowBlueprintForReconciliation(
      args.blueprint,
      args.automation.officialParameterBindings ?? [],
      args.overrides,
      args.userTimezone,
    );
    if (!resolution.ok) {
      return {
        kind: "result",
        result: await set(
          pauseForReconfiguration$,
          {
            orgId: args.orgId,
            userId: args.member.userId,
            definitionName: args.definitionName,
            blueprint: args.blueprint,
            activeDefinitionOnly: args.activeDefinitionOnly,
            automation: args.automation,
            bindings: resolution.bindings,
          },
          signal,
        ),
      };
    }
    let preparation: OfficialAutomationEventPreparation | undefined;
    if (!("schedule" in resolution.resolved.createRequest)) {
      const prepared = await set(
        prepareOfficialAutomationReconfiguration$,
        {
          automationId: args.automation.id,
          input: createInput(
            {
              orgId: args.orgId,
              member: args.member,
              workflowId: args.automation.workflowId,
              definitionName: args.definitionName,
            },
            resolution.resolved,
            { enabled: args.automation.enabled },
          ),
        },
        signal,
      );
      signal.throwIfAborted();
      if (prepared.kind !== "ok") {
        await set(
          markActiveAutomationFailed$,
          {
            orgId: args.orgId,
            userId: args.member.userId,
            workflowId: args.automation.workflowId,
            definitionName: args.definitionName,
            blueprint: args.blueprint,
            activeDefinitionOnly: args.activeDefinitionOnly,
            automationId: args.automation.id,
            expected: args.automation,
          },
          signal,
        );
        return {
          kind: "result",
          result: {
            kind: "retry",
            workflowId: args.automation.workflowId,
            message:
              "message" in prepared
                ? prepared.message
                : "Official Workflow event preparation failed",
          },
        };
      }
      preparation = prepared.preparation;
    }
    const patch = buildOfficialAutomationPatch(
      args.automation,
      resolution.resolved,
      preparation,
      nowDate(),
    );
    if (!patch.ok) {
      return {
        kind: "result",
        result: await set(
          pauseForReconfiguration$,
          {
            orgId: args.orgId,
            userId: args.member.userId,
            definitionName: args.definitionName,
            blueprint: args.blueprint,
            activeDefinitionOnly: args.activeDefinitionOnly,
            automation: args.automation,
            bindings: resolution.resolved.bindings,
          },
          signal,
        ),
      };
    }
    return { kind: "ready", patch: patch.patch, preparation };
  },
);

function automationStructureChanged(
  automation: OfficialAutomationRow,
  patch: OfficialAutomationPatch,
): boolean {
  return (
    automation.kind !== patch.kind ||
    (patch.kind === "event" && automation.eventType !== patch.eventType)
  );
}

const stageAutomationStructureTransition$ = command(
  async (
    { set },
    args: ExistingAutomationReconciliationArgs,
    signal: AbortSignal,
  ): Promise<PersistedReconfiguration | null> => {
    const db = set(writeDb$);

    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0201; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // SHARE fences the accepted pointer against the publisher's non-key UPDATE.
      await tx.execute(acceptedCatalogLockStatement());
      const [catalogRow] = parseRawRows(
        acceptedCatalogRowSchema,
        await tx.execute(acceptedCatalogReadStatement()),
      );
      signal.throwIfAborted();
      const catalogIdentity = blueprintAuthorityIdentity(args);
      const acceptedDefinition = matchingAcceptedBlueprintDefinition(
        acceptedCatalogFromRow(catalogRow),
        catalogIdentity,
      );
      if (!acceptedDefinition) {
        return null;
      }
      const [revisionRow] = parseRawRows(
        acceptedRevisionRowSchema,
        await tx.execute(acceptedRevisionReadStatement(acceptedDefinition)),
      );
      signal.throwIfAborted();
      if (!acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)) {
        return null;
      }
      const [installedWorkflow] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          installedWorkflowCondition(
            {
              orgId: args.orgId,
              userId: args.member.userId,
              definitionName: args.definitionName,
            },
            args.automation.workflowId,
          ),
        )
        .for("update")
        .limit(1);
      if (!installedWorkflow) {
        return null;
      }
      const [current] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(reconfigurationSourceCondition(args.automation))
        .for("update")
        .limit(1);
      if (
        !current ||
        !sameAutomationConfigurationBaseline(args.automation, current)
      ) {
        return null;
      }
      const currentTime = nowDate();
      const [staged] = await tx
        .update(workflowAutomations)
        .set({
          enabled: false,
          nextRunAt: null,
          officialReconciliationStatus: "reconciling",
          updatedAt: currentTime,
        })
        .where(eq(workflowAutomations.id, current.id))
        .returning(workflowAutomationColumns());
      if (!staged) {
        throw new Error("Official Workflow automation disappeared");
      }
      await tx
        .insert(officialWorkflowAutomationIdentities)
        .values(activeIdentityValues(staged, currentTime))
        .onConflictDoUpdate(activeIdentityConflict(staged, currentTime));
      return {
        previous: current,
        current: staged,
      };
    });
  },
);

function structureTransitionWatchAutomation(
  staged: OfficialAutomationRow,
  patch: OfficialAutomationPatch,
): OfficialAutomationRow {
  return { ...staged, ...patch };
}

function structureTransitionGoogleFormsPreparation(
  automationId: string,
  preparation: OfficialAutomationEventPreparation | undefined,
) {
  return preparation?.googleFormsSeedCursor === undefined
    ? []
    : [
        {
          automationId,
          seedCursor: preparation.googleFormsSeedCursor,
        },
      ];
}
const compensateAutomationStructureTransition$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly definitionName: string;
      readonly persisted: PersistedReconfiguration;
      readonly desired: OfficialAutomationRow;
    },
  ): Promise<void> => {
    const cleanupSignal = new AbortController().signal;
    await settle(
      set(
        reconcileAutomationEventWatchReconfiguration$,
        {
          previous: [args.desired],
          current: [args.persisted.current],
          googleForms: [],
        },
        cleanupSignal,
      ),
      cleanupSignal,
    );
    await settle(
      set(
        reconcileAutomationEventWatchInventoryForOwner$,
        { orgId: args.orgId, userId: args.userId },
        cleanupSignal,
      ),
      cleanupSignal,
    );
    await set(restoreFailedReconfiguration$, {
      orgId: args.orgId,
      userId: args.userId,
      definitionName: args.definitionName,
      persisted: args.persisted,
    });
  },
);
const prepareAutomationStructureTransitionWatch$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly persisted: PersistedReconfiguration;
      readonly desired: OfficialAutomationRow;
      readonly preparation: OfficialAutomationEventPreparation | undefined;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const oldWatch = await settle(
      set(
        reconcileAutomationEventWatchReconfiguration$,
        {
          previous: [args.persisted.previous],
          current: [args.persisted.current],
          googleForms: [],
        },
        signal,
      ),
      signal,
    );
    if (!oldWatch.ok || oldWatch.value.kind !== "ok") {
      return oldWatch.ok
        ? eventWatchFailureMessage(oldWatch.value)
        : "Official Workflow event-watch transition failed";
    }
    const inventory = await settle(
      set(
        reconcileAutomationEventWatchInventoryForOwner$,
        { orgId: args.orgId, userId: args.userId },
        signal,
      ),
      signal,
    );
    if (!inventory.ok || !inventory.value) {
      return "Official Workflow event-watch inventory reconciliation failed";
    }
    const newWatch = await settle(
      set(
        ensureAutomationEventWatchReconfiguration$,
        {
          current: [args.desired],
          googleForms: structureTransitionGoogleFormsPreparation(
            args.desired.id,
            args.preparation,
          ),
          allowStagedOfficialTargets: true,
        },
        signal,
      ),
      signal,
    );
    if (!newWatch.ok || newWatch.value.kind !== "ok") {
      return newWatch.ok
        ? eventWatchFailureMessage(newWatch.value)
        : "Official Workflow event-watch transition failed";
    }
    return null;
  },
);
type FinalizeAutomationStructureTransitionResult =
  | {
      readonly kind: "current";
    }
  | {
      readonly kind: "superseded";
    }
  | {
      readonly kind: "failed";
      readonly message: string;
    };

interface FinalizeAutomationStructureTransitionArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly definitionName: string;
  readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  readonly activeDefinitionOnly: boolean;
  readonly persisted: PersistedReconfiguration;
  readonly patch: OfficialAutomationPatch;
  readonly preparation: OfficialAutomationEventPreparation | undefined;
}

function finalizedStructurePatch(
  current: OfficialAutomationRow,
  patch: OfficialAutomationPatch,
  currentTime: Date,
) {
  const refreshed = refreshOfficialAutomationPatch(current, patch, currentTime);
  return {
    ...refreshed,
    nextRunAt: reconciledScheduleAnchor(current, refreshed.nextRunAt),
    officialReconciliationStatus: "current" as const,
  };
}

function structureAccountProjectionArgs(
  owner: { readonly orgId: string; readonly userId: string },
  current: OfficialAutomationRow,
  patch: Pick<OfficialAutomationPatch, "eventType">,
) {
  return {
    orgId: owner.orgId,
    userId: owner.userId,
    workflowId: current.workflowId,
    currentEventType: current.eventType,
    nextEventType: patch.eventType,
  };
}

function structureTransitionReadPlan(
  args: FinalizeAutomationStructureTransitionArgs,
) {
  const source = args.persisted.current;
  return {
    source,
    authority: blueprintAuthorityIdentity(args),
    accountPlan: officialAccountProjectionReadPlan(
      structureAccountProjectionArgs(args, source, args.patch),
    ),
    installation: installedWorkflowCondition(args, source.workflowId),
  };
}

function requireOfficialAutomationRow(
  row: OfficialAutomationRow | undefined,
): OfficialAutomationRow {
  if (!row) {
    throw new Error("Official Workflow automation disappeared");
  }
  return row;
}

function structureTransitionPublicationPlan(
  previous: OfficialAutomationRow,
  current: OfficialAutomationRow,
  args: FinalizeAutomationStructureTransitionArgs,
  currentTime: Date,
) {
  return {
    resetCursor: googleFormsCursorMustReset(previous, current)
      ? deleteGoogleFormsCursorStatement(previous.id)
      : null,
    cursor: googleFormsCursorPublicationStatement(
      current,
      args.preparation?.googleFormsSeedCursor ?? null,
      currentTime,
    ),
    identity: activeAutomationIdentityUpsertStatement(current, currentTime),
    installation: installationUpdatedStatement(
      current.workflowId,
      args.userId,
      currentTime,
    ),
  };
}

const finalizeAutomationStructureTransition$ = command(
  async (
    { set },
    args: FinalizeAutomationStructureTransitionArgs,
    signal: AbortSignal,
  ): Promise<FinalizeAutomationStructureTransitionResult> => {
    const db = set(writeDb$);
    const { source, authority, accountPlan, installation } =
      structureTransitionReadPlan(args);

    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0202; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // SHARE fences the accepted pointer against the publisher's non-key UPDATE.
      await tx.execute(acceptedCatalogLockStatement());
      const catalogRows = parseRawRows(
        acceptedCatalogRowSchema,
        await tx.execute(acceptedCatalogReadStatement()),
      );
      signal.throwIfAborted();
      const acceptedDefinition = acceptedBlueprintDefinitionFromRows(
        catalogRows,
        authority,
      );
      if (!acceptedDefinition) {
        return { kind: "superseded" };
      }
      const revisionRows = parseRawRows(
        acceptedRevisionRowSchema,
        await tx.execute(acceptedRevisionReadStatement(acceptedDefinition)),
      );
      signal.throwIfAborted();
      if (!acceptedRevisionBlueprintRowsMatch(revisionRows, authority)) {
        return { kind: "superseded" };
      }
      let webhookTierEligible = true;
      if (args.patch.eventType === "webhook-received") {
        const tierRows = parseRawRows(
          webhookTierRowSchema,
          await tx.execute(webhookTierLockStatement(args.orgId)),
        );
        webhookTierEligible = webhookTierFromRows(tierRows, args.orgId);
        signal.throwIfAborted();
      }
      const accountRows = accountPlan.required
        ? await tx
            .select(accountPlan.columns)
            .from(accountPlan.source)
            .leftJoin(connectorCatalog, accountPlan.catalogJoin)
            .leftJoin(connectorCatalogEntries, accountPlan.entryJoin)
            .leftJoin(connectors, accountPlan.connectionJoin)
            .leftJoin(variables, accountPlan.variableJoin)
        : [];
      if (accountPlan.required) {
        signal.throwIfAborted();
      }
      const projection = officialAccountProjectionFromRow(
        accountPlan,
        accountRows[0],
      );
      const { rowCount: installationCount } = await tx.execute(
        installedWorkflowLockStatement(installation),
      );
      if (installationCount !== 1) {
        return { kind: "superseded" };
      }
      const [current] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(observedWorkflowAutomationCondition(source))
        .for("update")
        .limit(1);
      if (!structureTransitionSourceIsCurrent(current, source)) {
        return { kind: "superseded" };
      }
      const identityCondition = activeIdentityOwnershipCondition(current);
      const { rowCount: identityCount } = await tx.execute(
        activeAutomationIdentityLockStatement(identityCondition),
      );
      if (
        identityCount !== 1 ||
        !accountProjectionMatchesPatch(projection, args.patch)
      ) {
        return { kind: "superseded" };
      }
      const currentTime = nowDate();
      const desired = structureTransitionWatchAutomation(current, args.patch);
      const values = finalizedStructurePatch(current, args.patch, currentTime);
      const { rowCount: webhookCount } = await tx.execute(
        automationWebhookReadStatement(desired.id),
      );
      signal.throwIfAborted();
      const subtype = officialWebhookSubtypeMutation(
        desired,
        webhookCount === 1,
        args.preparation?.webhookCredentials,
        webhookTierEligible,
        currentTime,
      );
      if (subtype.kind === "failed") {
        return subtype;
      }
      if (subtype.statement !== null) {
        await tx.execute(subtype.statement);
      }
      signal.throwIfAborted();

      const [updated] = await tx
        .update(workflowAutomations)
        .set(values)
        .where(eq(workflowAutomations.id, current.id))
        .returning(workflowAutomationColumns());
      const finalized = requireOfficialAutomationRow(updated);
      const publication = structureTransitionPublicationPlan(
        current,
        finalized,
        args,
        currentTime,
      );
      if (publication.resetCursor !== null) {
        await tx.execute(publication.resetCursor);
      }
      if (publication.cursor !== null) {
        const { rowCount } = await tx.execute(publication.cursor);
        assertStructureCursorPublished(rowCount);
      }
      await tx.execute(publication.identity);
      await tx.execute(publication.installation);
      return { kind: "current" };
    });
  },
);
// Complete both watch cleanups before cancellation reaches the state restoration owner.
const cleanupStructureTransitionWatches$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly persisted: PersistedReconfiguration;
      readonly desired: OfficialAutomationRow;
    },
    _signal: AbortSignal,
  ): Promise<void> => {
    const cleanupSignal = new AbortController().signal;
    await set(
      reconcileAutomationEventWatchReconfiguration$,
      {
        previous: [args.desired],
        current: [args.persisted.current],
        googleForms: [],
      },
      cleanupSignal,
    );
    await set(
      reconcileAutomationEventWatchInventoryForOwner$,
      { orgId: args.orgId, userId: args.userId },
      cleanupSignal,
    );
  },
);
const reconcileAutomationStructureTransition$ = command(
  async (
    { set },
    args: ExistingAutomationReconciliationArgs,
    prepared: Extract<
      PreparedExistingAutomationReconfiguration,
      {
        kind: "ready";
      }
    >,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult> => {
    const persisted = await set(
      stageAutomationStructureTransition$,
      args,
      signal,
    );
    if (!persisted) {
      return {
        kind: "retry",
        workflowId: args.automation.workflowId,
        message: "Official Workflow reconciliation was superseded",
      };
    }
    const desired = structureTransitionWatchAutomation(
      persisted.current,
      prepared.patch,
    );
    const watchFailure = await set(
      prepareAutomationStructureTransitionWatch$,
      {
        orgId: args.orgId,
        userId: args.member.userId,
        persisted,
        desired,
        preparation: prepared.preparation,
      },
      signal,
    );
    if (watchFailure) {
      await set(compensateAutomationStructureTransition$, {
        orgId: args.orgId,
        userId: args.member.userId,
        definitionName: args.definitionName,
        persisted,
        desired,
      });
      signal.throwIfAborted();
      return {
        kind: "retry",
        workflowId: args.automation.workflowId,
        message: watchFailure,
      };
    }

    signal.throwIfAborted();
    const finalization = await settle(
      set(
        finalizeAutomationStructureTransition$,
        {
          orgId: args.orgId,
          userId: args.member.userId,
          definitionName: args.definitionName,
          blueprint: args.blueprint,
          activeDefinitionOnly: args.activeDefinitionOnly,
          persisted,
          patch: prepared.patch,
          preparation: prepared.preparation,
        },
        signal,
      ),
      signal,
    );
    if (finalization.ok && finalization.value.kind === "current") {
      return { kind: "current", workflowId: args.automation.workflowId };
    }
    await set(
      cleanupStructureTransitionWatches$,
      { orgId: args.orgId, userId: args.member.userId, persisted, desired },
      signal,
    );
    if (finalization.ok && finalization.value.kind === "superseded") {
      return {
        kind: "retry",
        workflowId: args.automation.workflowId,
        message: "Official Workflow reconciliation was superseded",
      };
    }
    await set(restoreFailedReconfiguration$, {
      orgId: args.orgId,
      userId: args.member.userId,
      definitionName: args.definitionName,
      persisted,
    });
    signal.throwIfAborted();
    return {
      kind: "retry",
      workflowId: args.automation.workflowId,
      message:
        finalization.ok && finalization.value.kind === "failed"
          ? finalization.value.message
          : "Official Workflow structure transition failed",
    };
  },
);
function formsReconfigurationInput(
  args: ExistingAutomationReconciliationArgs,
  prepared: Extract<
    PreparedExistingAutomationReconfiguration,
    { readonly kind: "ready" }
  >,
) {
  if (
    args.automation.eventType !== "google-forms-response-submitted" ||
    prepared.patch.eventType !== "google-forms-response-submitted" ||
    isMorningBriefReconciliation({
      definitionName: args.definitionName,
      blueprintKey: args.blueprint.key,
    })
  ) {
    return null;
  }
  const seedCursor = prepared.preparation?.googleFormsSeedCursor;
  if (seedCursor === undefined) {
    throw new Error(
      "Official Forms reconfiguration requires its prepared baseline",
    );
  }
  return {
    orgId: args.orgId,
    userId: args.member.userId,
    definitionName: args.definitionName,
    blueprint: args.blueprint,
    activeDefinitionOnly: args.activeDefinitionOnly,
    expected: args.automation,
    patch: prepared.patch,
    seedCursor,
  };
}
const reconcileExistingAutomation$ = command(
  async (
    { set },
    args: ExistingAutomationReconciliationArgs,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult> => {
    const prepared = await set(
      prepareExistingAutomationReconfiguration$,
      args,
      signal,
    );
    if (prepared.kind === "result") {
      return prepared.result;
    }
    const formsInput = formsReconfigurationInput(args, prepared);
    if (formsInput !== null) {
      return await set(
        reconcileOfficialGoogleFormsConfiguration$,
        formsInput,
        signal,
      );
    }
    if (
      automationStructureChanged(args.automation, prepared.patch) ||
      args.automation.officialReconciliationStatus === "reconciling" ||
      args.automation.officialReconciliationStatus === "failed"
    ) {
      return await set(
        reconcileAutomationStructureTransition$,
        args,
        prepared,
        signal,
      );
    }
    const persisted = await set(
      persistReconfigurationPatch$,
      {
        orgId: args.orgId,
        userId: args.member.userId,
        definitionName: args.definitionName,
        blueprint: args.blueprint,
        activeDefinitionOnly: args.activeDefinitionOnly,
        expected: args.automation,
        patch: prepared.patch,
        preparation: prepared.preparation,
      },
      signal,
    );
    if (!persisted) {
      return {
        kind: "retry",
        workflowId: args.automation.workflowId,
        message: "Official Workflow reconciliation was superseded",
      };
    }

    signal.throwIfAborted();
    const watch = await settle(
      set(
        reconcileAutomationEventWatchReconfiguration$,
        {
          previous: [persisted.previous],
          current: [persisted.current],
          googleForms:
            prepared.preparation?.googleFormsSeedCursor === undefined
              ? []
              : [
                  {
                    automationId: persisted.current.id,
                    seedCursor: prepared.preparation.googleFormsSeedCursor,
                  },
                ],
        },
        signal,
      ),
      signal,
    );
    if (!watch.ok || watch.value.kind !== "ok") {
      await set(restoreFailedReconfiguration$, {
        orgId: args.orgId,
        userId: args.member.userId,
        definitionName: args.definitionName,
        persisted,
      });
      signal.throwIfAborted();
      return {
        kind: "retry",
        workflowId: args.automation.workflowId,
        message: watch.ok
          ? eventWatchFailureMessage(watch.value)
          : "Official Workflow event-watch reconciliation failed",
      };
    }
    const finalized = await set(
      finalizeReconfiguration$,
      {
        orgId: args.orgId,
        userId: args.member.userId,
        definitionName: args.definitionName,
        blueprint: args.blueprint,
        activeDefinitionOnly: args.activeDefinitionOnly,
        persisted,
      },
      signal,
    );
    if (!finalized) {
      await set(restoreFailedReconfiguration$, {
        orgId: args.orgId,
        userId: args.member.userId,
        definitionName: args.definitionName,
        persisted,
      });
      signal.throwIfAborted();
      return {
        kind: "retry",
        workflowId: args.automation.workflowId,
        message: "Official Workflow reconciliation was superseded",
      };
    }
    return { kind: "current", workflowId: args.automation.workflowId };
  },
);

function createInput(
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
    readonly workflowId: string;
    readonly definitionName: string;
  },
  resolved: ResolvedBlueprint,
  options: {
    readonly enabled: boolean;
    readonly automationId?: string;
    readonly intendedEnabled?: boolean;
    readonly stagedMaterialization?: boolean;
  },
): CreateAutomationInput {
  return {
    ...resolved.createRequest,
    orgId: args.orgId,
    member: args.member,
    workflowId: args.workflowId,
    enabled: options.enabled,
    ...(resolved.autonomyBudget === undefined
      ? {}
      : { autonomyBudget: resolved.autonomyBudget }),
    ...(options.automationId === undefined
      ? {}
      : {
          officialInstallation: {
            definitionName: args.definitionName,
            blueprintKey: resolved.blueprint.key,
            appliedFingerprint: resolved.blueprint.fingerprint,
            parameterBindings: resolved.bindings,
            resultEmailEnabled: resolved.blueprint.runtime.resultEmail,
            automationId: options.automationId,
            installationState: "installed" as const,
            intendedEnabled: options.intendedEnabled ?? false,
            ...(options.stagedMaterialization === true
              ? { stagedMaterialization: true }
              : {}),
          },
        }),
  };
}

const markActiveAutomationFailed$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
      readonly definitionName: string;
      readonly blueprint: OfficialWorkflowAcceptedBlueprint;
      readonly activeDefinitionOnly: boolean;
      readonly automationId: string;
      readonly expected?: OfficialAutomationRow;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);

    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0203; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // SHARE fences the accepted pointer against the publisher's non-key UPDATE.
      await tx.execute(acceptedCatalogLockStatement());
      const [catalogRow] = parseRawRows(
        acceptedCatalogRowSchema,
        await tx.execute(acceptedCatalogReadStatement()),
      );
      signal.throwIfAborted();
      const catalogIdentity = blueprintAuthorityIdentity(args);
      const acceptedDefinition = matchingAcceptedBlueprintDefinition(
        acceptedCatalogFromRow(catalogRow),
        catalogIdentity,
      );
      if (!acceptedDefinition) {
        return false;
      }
      const [revisionRow] = parseRawRows(
        acceptedRevisionRowSchema,
        await tx.execute(acceptedRevisionReadStatement(acceptedDefinition)),
      );
      signal.throwIfAborted();
      if (!acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)) {
        return false;
      }
      const [installedWorkflow] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(installedWorkflowCondition(args, args.workflowId))
        .for("update")
        .limit(1);
      if (!installedWorkflow) {
        return false;
      }
      const [current] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, args.automationId))
        .for("update")
        .limit(1);
      if (
        !current ||
        current.workflowId !== args.workflowId ||
        current.officialBlueprintKey !== args.blueprint.key ||
        current.officialAppliedFingerprint !== args.blueprint.fingerprint ||
        (args.expected !== undefined &&
          !sameAutomationBaseline(args.expected, current))
      ) {
        return false;
      }
      const currentTime = nowDate();
      const [failed] = await tx
        .update(workflowAutomations)
        .set({
          officialReconciliationStatus: "failed",
          updatedAt: currentTime,
        })
        .where(eq(workflowAutomations.id, current.id))
        .returning(workflowAutomationColumns());
      if (!failed) {
        return false;
      }
      await tx
        .insert(officialWorkflowAutomationIdentities)
        .values(activeIdentityValues(failed, currentTime))
        .onConflictDoUpdate(activeIdentityConflict(failed, currentTime));
      return true;
    });
  },
);

interface DormantIdentityReservation {
  readonly kind: "reserved" | "busy" | "active";
  readonly id: string;
  readonly intendedEnabled: boolean;
}
function resolveDormantReservationChoice(args: {
  readonly identity:
    typeof officialWorkflowAutomationIdentities.$inferSelect | undefined;
  readonly fallbackIntendedEnabled: boolean;
}): { readonly id: string | null; readonly intendedEnabled: boolean } {
  return {
    id: args.identity?.id ?? null,
    intendedEnabled:
      args.identity?.retainedIntendedEnabled ?? args.fallbackIntendedEnabled,
  };
}

function dormantReservationValues(
  args: {
    readonly bindings: readonly OfficialWorkflowParameterBinding[];
    readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  },
  intendedEnabled: boolean,
  currentTime: Date,
) {
  return {
    automationId: null,
    state: "reconciling" as const,
    retainedParameterBindings: [...args.bindings],
    retainedIntendedEnabled: intendedEnabled,
    retainedAppliedFingerprint: args.blueprint.fingerprint,
    updatedAt: currentTime,
  };
}

const reserveDormantIdentity$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
      readonly definitionName: string;
      readonly blueprint: OfficialWorkflowAcceptedBlueprint;
      readonly activeDefinitionOnly: boolean;
      readonly bindings: readonly OfficialWorkflowParameterBinding[];
      readonly fallbackIntendedEnabled: boolean;
    },
    signal: AbortSignal,
  ): Promise<DormantIdentityReservation | null> => {
    const db = set(writeDb$);

    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0204; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // SHARE fences the accepted pointer against the publisher's non-key UPDATE.
      await tx.execute(acceptedCatalogLockStatement());
      const [catalogRow] = parseRawRows(
        acceptedCatalogRowSchema,
        await tx.execute(acceptedCatalogReadStatement()),
      );
      signal.throwIfAborted();
      const catalogIdentity = blueprintAuthorityIdentity(args);
      const acceptedDefinition = matchingAcceptedBlueprintDefinition(
        acceptedCatalogFromRow(catalogRow),
        catalogIdentity,
      );
      if (!acceptedDefinition) {
        return null;
      }
      const [revisionRow] = parseRawRows(
        acceptedRevisionRowSchema,
        await tx.execute(acceptedRevisionReadStatement(acceptedDefinition)),
      );
      signal.throwIfAborted();
      if (!acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)) {
        return null;
      }
      const [installedWorkflow] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(installedWorkflowCondition(args, args.workflowId))
        .for("update")
        .limit(1);
      if (!installedWorkflow) {
        return null;
      }
      const [automation] = await tx
        .select({ id: workflowAutomations.id })
        .from(workflowAutomations)
        .where(
          and(
            eq(workflowAutomations.workflowId, args.workflowId),
            eq(workflowAutomations.officialBlueprintKey, args.blueprint.key),
          ),
        )
        .for("update")
        .limit(1);
      if (automation) {
        return {
          kind: "active" as const,
          id: automation.id,
          intendedEnabled: args.fallbackIntendedEnabled,
        };
      }
      const [identity] = await tx
        .select()
        .from(officialWorkflowAutomationIdentities)
        .where(
          and(
            eq(
              officialWorkflowAutomationIdentities.workflowId,
              args.workflowId,
            ),
            eq(
              officialWorkflowAutomationIdentities.blueprintKey,
              args.blueprint.key,
            ),
          ),
        )
        .for("update")
        .limit(1);
      const currentTime = nowDate();
      const choice = resolveDormantReservationChoice({
        identity,
        fallbackIntendedEnabled: args.fallbackIntendedEnabled,
      });
      const intendedEnabled = choice.intendedEnabled;
      const values = dormantReservationValues(
        args,
        intendedEnabled,
        currentTime,
      );
      if (
        identity?.state === "reconciling" &&
        currentTime.getTime() - identity.updatedAt.getTime() <
          DORMANT_CREATION_LEASE_MS
      ) {
        return { kind: "busy", id: identity.id, intendedEnabled };
      }
      if (identity) {
        await tx
          .update(officialWorkflowAutomationIdentities)
          .set(values)
          .where(eq(officialWorkflowAutomationIdentities.id, identity.id));
        return { kind: "reserved", id: identity.id, intendedEnabled };
      }
      const [inserted] = await tx
        .insert(officialWorkflowAutomationIdentities)
        .values({
          ...values,
          ...(choice.id === null ? {} : { id: choice.id }),
          workflowId: args.workflowId,
          blueprintKey: args.blueprint.key,
          createdAt: currentTime,
        })
        .returning({ id: officialWorkflowAutomationIdentities.id });
      if (!inserted) {
        throw new Error("Failed to reserve Official Automation identity");
      }
      return { kind: "reserved", id: inserted.id, intendedEnabled };
    });
  },
);

const retainDormantIdentity$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
      readonly definitionName: string;
      readonly blueprint: OfficialWorkflowAcceptedBlueprint;
      readonly activeDefinitionOnly: boolean;
      readonly bindings: readonly OfficialWorkflowParameterBinding[];
      readonly state: "needs_reconfiguration" | "failed";
      readonly fallbackIntendedEnabled: boolean;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);

    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0205; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // SHARE fences the accepted pointer against the publisher's non-key UPDATE.
      await tx.execute(acceptedCatalogLockStatement());
      const [catalogRow] = parseRawRows(
        acceptedCatalogRowSchema,
        await tx.execute(acceptedCatalogReadStatement()),
      );
      signal.throwIfAborted();
      const catalogIdentity = blueprintAuthorityIdentity(args);
      const acceptedDefinition = matchingAcceptedBlueprintDefinition(
        acceptedCatalogFromRow(catalogRow),
        catalogIdentity,
      );
      if (!acceptedDefinition) {
        return false;
      }
      const [revisionRow] = parseRawRows(
        acceptedRevisionRowSchema,
        await tx.execute(acceptedRevisionReadStatement(acceptedDefinition)),
      );
      signal.throwIfAborted();
      if (!acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)) {
        return false;
      }
      const [installedWorkflow] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(installedWorkflowCondition(args, args.workflowId))
        .for("update")
        .limit(1);
      if (!installedWorkflow) {
        return false;
      }
      const [active] = await tx
        .select({ id: workflowAutomations.id })
        .from(workflowAutomations)
        .where(
          and(
            eq(workflowAutomations.workflowId, args.workflowId),
            eq(workflowAutomations.officialBlueprintKey, args.blueprint.key),
          ),
        )
        .for("update")
        .limit(1);
      if (active) {
        return false;
      }
      const [identity] = await tx
        .select()
        .from(officialWorkflowAutomationIdentities)
        .where(
          and(
            eq(
              officialWorkflowAutomationIdentities.workflowId,
              args.workflowId,
            ),
            eq(
              officialWorkflowAutomationIdentities.blueprintKey,
              args.blueprint.key,
            ),
          ),
        )
        .for("update")
        .limit(1);
      const currentTime = nowDate();
      const choice = resolveDormantReservationChoice({
        identity,
        fallbackIntendedEnabled: args.fallbackIntendedEnabled,
      });
      const { id: retainedIdentityId, intendedEnabled } = choice;
      if (identity) {
        await tx
          .update(officialWorkflowAutomationIdentities)
          .set({
            automationId: null,
            state: args.state,
            retainedParameterBindings: [...args.bindings],
            retainedIntendedEnabled: intendedEnabled,
            updatedAt: currentTime,
          })
          .where(eq(officialWorkflowAutomationIdentities.id, identity.id));
        return true;
      }
      await tx.insert(officialWorkflowAutomationIdentities).values({
        ...(retainedIdentityId === null ? {} : { id: retainedIdentityId }),
        workflowId: args.workflowId,
        automationId: null,
        blueprintKey: args.blueprint.key,
        state: args.state,
        retainedParameterBindings: [...args.bindings],
        retainedIntendedEnabled: intendedEnabled,
        retainedAppliedFingerprint: null,
        createdAt: currentTime,
        updatedAt: currentTime,
      });
      return true;
    });
  },
);
const deleteReservedCreationOrphan$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
      readonly definitionName: string;
      readonly blueprint: OfficialWorkflowAcceptedBlueprint;
      readonly activeDefinitionOnly: boolean;
      readonly reservationId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0206; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // SHARE fences the accepted pointer against the publisher's non-key UPDATE.
      await tx.execute(acceptedCatalogLockStatement());
      const [catalogRow] = parseRawRows(
        acceptedCatalogRowSchema,
        await tx.execute(acceptedCatalogReadStatement()),
      );
      signal.throwIfAborted();
      const catalogIdentity = blueprintAuthorityIdentity(args);
      const acceptedDefinition = matchingAcceptedBlueprintDefinition(
        acceptedCatalogFromRow(catalogRow),
        catalogIdentity,
      );
      if (!acceptedDefinition) {
        return { kind: "blocked" as const };
      }
      const [revisionRow] = parseRawRows(
        acceptedRevisionRowSchema,
        await tx.execute(acceptedRevisionReadStatement(acceptedDefinition)),
      );
      signal.throwIfAborted();
      if (!acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)) {
        return { kind: "blocked" as const };
      }
      const [installedWorkflow] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(installedWorkflowCondition(args, args.workflowId))
        .for("update")
        .limit(1);
      if (!installedWorkflow) {
        return { kind: "blocked" as const };
      }
      const [automation] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, args.reservationId))
        .for("update")
        .limit(1);
      const [identity] = await tx
        .select()
        .from(officialWorkflowAutomationIdentities)
        .where(
          and(
            eq(officialWorkflowAutomationIdentities.id, args.reservationId),
            eq(
              officialWorkflowAutomationIdentities.workflowId,
              args.workflowId,
            ),
            eq(
              officialWorkflowAutomationIdentities.blueprintKey,
              args.blueprint.key,
            ),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !identity ||
        identity.state !== "reconciling" ||
        identity.automationId !== null ||
        identity.retainedAppliedFingerprint !== args.blueprint.fingerprint
      ) {
        return { kind: "blocked" as const };
      }
      if (!automation) {
        return { kind: "none" as const };
      }
      const isRecoverableOrphan =
        automation.orgId === args.orgId &&
        automation.ownerUserId === args.userId &&
        automation.workflowId === args.workflowId &&
        !automation.enabled &&
        automation.officialBlueprintKey === null &&
        automation.officialAppliedFingerprint === null &&
        automation.officialReconciliationStatus === null &&
        automation.officialParameterBindings === null &&
        automation.officialIntendedEnabled === null;
      if (!isRecoverableOrphan) {
        return { kind: "blocked" as const };
      }
      await tx
        .delete(workflowAutomations)
        .where(eq(workflowAutomations.id, automation.id));
      return { kind: "deleted" as const, automation };
    });
  },
);
const removeDormantCreationOrphan$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
      readonly definitionName: string;
      readonly blueprint: OfficialWorkflowAcceptedBlueprint;
      readonly activeDefinitionOnly: boolean;
      readonly reservationId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const result = await set(deleteReservedCreationOrphan$, args, signal);
    if (result.kind === "blocked") {
      return false;
    }
    if (result.kind === "deleted") {
      const cleanup = await settle(
        set(
          reconcileAutomationEventWatches$,
          { automations: [result.automation] },
          signal,
        ),
        signal,
      );
      return cleanup.ok;
    }
    return true;
  },
);

interface DormantMaterializationOwnershipArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly definitionName: string;
  readonly blueprintKey: string;
  readonly fingerprint: string;
  readonly activeDefinitionOnly: boolean;
  readonly automationId: string;
  readonly bindings: readonly OfficialWorkflowParameterBinding[];
  readonly intendedEnabled: boolean;
  readonly resultEmailEnabled: boolean;
}

function dormantMaterializationRows(
  automation: OfficialAutomationRow | undefined,
  identity:
    typeof officialWorkflowAutomationIdentities.$inferSelect | undefined,
  args: DormantMaterializationOwnershipArgs,
): {
  readonly automation: OfficialAutomationRow;
  readonly identity: typeof officialWorkflowAutomationIdentities.$inferSelect;
} | null {
  if (
    !identity ||
    identity.automationId !== null ||
    identity.retainedAppliedFingerprint !== args.fingerprint ||
    identity.retainedIntendedEnabled !== args.intendedEnabled ||
    !isDeepStrictEqual(identity.retainedParameterBindings, args.bindings) ||
    !automation ||
    automation.orgId !== args.orgId ||
    automation.ownerUserId !== args.userId ||
    automation.workflowId !== args.workflowId ||
    automation.officialBlueprintKey !== args.blueprintKey ||
    automation.officialAppliedFingerprint !== args.fingerprint ||
    automation.officialReconciliationStatus === null ||
    automation.officialIntendedEnabled !== args.intendedEnabled ||
    automation.officialResultEmailEnabled !== args.resultEmailEnabled ||
    !isDeepStrictEqual(automation.officialParameterBindings, args.bindings)
  ) {
    return null;
  }
  return { automation, identity };
}

const validateDormantMaterialization$ = command(
  async (
    { set },
    args: DormantMaterializationOwnershipArgs,
    signal: AbortSignal,
  ): Promise<OfficialAutomationRow | null> => {
    const db = set(writeDb$);

    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0207; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // SHARE fences the accepted pointer against the publisher's non-key UPDATE.
      await tx.execute(acceptedCatalogLockStatement());
      const [catalogRow] = parseRawRows(
        acceptedCatalogRowSchema,
        await tx.execute(acceptedCatalogReadStatement()),
      );
      signal.throwIfAborted();
      const catalogIdentity = {
        definitionName: args.definitionName,
        blueprintKey: args.blueprintKey,
        fingerprint: args.fingerprint,
        activeDefinitionOnly: args.activeDefinitionOnly,
      };
      const acceptedDefinition = matchingAcceptedBlueprintDefinition(
        acceptedCatalogFromRow(catalogRow),
        catalogIdentity,
      );
      if (!acceptedDefinition) {
        return null;
      }
      const [revisionRow] = parseRawRows(
        acceptedRevisionRowSchema,
        await tx.execute(acceptedRevisionReadStatement(acceptedDefinition)),
      );
      signal.throwIfAborted();
      if (!acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)) {
        return null;
      }
      const [authorityRow] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(installedWorkflowCondition(args, args.workflowId))
        .for("update")
        .limit(1);
      const authority = authorityRow !== undefined;
      if (!authority) {
        return null;
      }
      const [materializationAutomation] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, args.automationId))
        .for("update")
        .limit(1);
      const [materializationIdentity] = await tx
        .select()
        .from(officialWorkflowAutomationIdentities)
        .where(
          and(
            eq(officialWorkflowAutomationIdentities.id, args.automationId),
            eq(
              officialWorkflowAutomationIdentities.workflowId,
              args.workflowId,
            ),
            eq(
              officialWorkflowAutomationIdentities.blueprintKey,
              args.blueprintKey,
            ),
          ),
        )
        .for("update")
        .limit(1);
      const rows = dormantMaterializationRows(
        materializationAutomation,
        materializationIdentity,
        args,
      );
      if (
        !rows ||
        rows.identity.state !== "reconciling" ||
        rows.automation.officialReconciliationStatus !== "reconciling"
      ) {
        return null;
      }
      return rows.automation;
    });
  },
);

const finalizeDormantMaterialization$ = command(
  async (
    { set },
    args: DormantMaterializationOwnershipArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);

    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0208; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // SHARE fences the accepted pointer against the publisher's non-key UPDATE.
      await tx.execute(acceptedCatalogLockStatement());
      const [catalogRow] = parseRawRows(
        acceptedCatalogRowSchema,
        await tx.execute(acceptedCatalogReadStatement()),
      );
      signal.throwIfAborted();
      const catalogIdentity = {
        definitionName: args.definitionName,
        blueprintKey: args.blueprintKey,
        fingerprint: args.fingerprint,
        activeDefinitionOnly: args.activeDefinitionOnly,
      };
      const acceptedDefinition = matchingAcceptedBlueprintDefinition(
        acceptedCatalogFromRow(catalogRow),
        catalogIdentity,
      );
      if (!acceptedDefinition) {
        return false;
      }
      const [revisionRow] = parseRawRows(
        acceptedRevisionRowSchema,
        await tx.execute(acceptedRevisionReadStatement(acceptedDefinition)),
      );
      signal.throwIfAborted();
      if (!acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)) {
        return false;
      }
      const [authorityRow] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(installedWorkflowCondition(args, args.workflowId))
        .for("update")
        .limit(1);
      const authority = authorityRow !== undefined;
      if (!authority) {
        return false;
      }
      const [materializationAutomation] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, args.automationId))
        .for("update")
        .limit(1);
      const [materializationIdentity] = await tx
        .select()
        .from(officialWorkflowAutomationIdentities)
        .where(
          and(
            eq(officialWorkflowAutomationIdentities.id, args.automationId),
            eq(
              officialWorkflowAutomationIdentities.workflowId,
              args.workflowId,
            ),
            eq(
              officialWorkflowAutomationIdentities.blueprintKey,
              args.blueprintKey,
            ),
          ),
        )
        .for("update")
        .limit(1);
      const rows = dormantMaterializationRows(
        materializationAutomation,
        materializationIdentity,
        args,
      );
      const expectedEnabled = args.intendedEnabled;
      if (
        !rows ||
        rows.identity.state !== "reconciling" ||
        rows.automation.officialReconciliationStatus !== "reconciling" ||
        rows.automation.enabled !== expectedEnabled
      ) {
        return false;
      }
      const automation = rows.automation;
      const currentTime = nowDate();
      const [finalized] = await tx
        .update(workflowAutomations)
        .set({
          officialReconciliationStatus: "current",
          updatedAt: currentTime,
        })
        .where(
          and(
            eq(workflowAutomations.id, automation.id),
            eq(workflowAutomations.officialReconciliationStatus, "reconciling"),
            eq(workflowAutomations.updatedAt, automation.updatedAt),
          ),
        )
        .returning({ id: workflowAutomations.id });
      const [identity] = await tx
        .update(officialWorkflowAutomationIdentities)
        .set(activeIdentityUpdate(automation, currentTime))
        .where(
          and(
            eq(officialWorkflowAutomationIdentities.id, automation.id),
            eq(officialWorkflowAutomationIdentities.state, "reconciling"),
            isNull(officialWorkflowAutomationIdentities.automationId),
          ),
        )
        .returning({ id: officialWorkflowAutomationIdentities.id });
      if (!finalized || !identity) {
        throw new Error(
          "Official Workflow materialization finalization lost ownership",
        );
      }
      await tx
        .update(workflows)
        .set({ updatedBy: args.userId, updatedAt: currentTime })
        .where(eq(workflows.id, args.workflowId));
      return true;
    });
  },
);
const persistDiscardedMaterialization$ = command(
  async (
    { set },
    args: DormantMaterializationOwnershipArgs,
    _signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0209; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // SHARE fences the accepted pointer against the publisher's non-key UPDATE.
      await tx.execute(acceptedCatalogLockStatement());
      const [materializationAutomation] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, args.automationId))
        .for("update")
        .limit(1);
      const [materializationIdentity] = await tx
        .select()
        .from(officialWorkflowAutomationIdentities)
        .where(
          and(
            eq(officialWorkflowAutomationIdentities.id, args.automationId),
            eq(
              officialWorkflowAutomationIdentities.workflowId,
              args.workflowId,
            ),
            eq(
              officialWorkflowAutomationIdentities.blueprintKey,
              args.blueprintKey,
            ),
          ),
        )
        .for("update")
        .limit(1);
      const rows = dormantMaterializationRows(
        materializationAutomation,
        materializationIdentity,
        args,
      );
      if (
        !rows ||
        !(
          (rows.automation.officialReconciliationStatus === "reconciling" &&
            rows.identity.state === "reconciling") ||
          (rows.automation.officialReconciliationStatus === "failed" &&
            rows.identity.state === "failed")
        )
      ) {
        return null;
      }
      const previous = rows.automation;
      const currentTime = nowDate();
      const [current] = await tx
        .update(workflowAutomations)
        .set({
          enabled: false,
          nextRunAt: null,
          officialReconciliationStatus: "failed",
          updatedAt: currentTime,
        })
        .where(eq(workflowAutomations.id, previous.id))
        .returning(workflowAutomationColumns());
      if (!current) {
        return null;
      }
      const [identity] = await tx
        .update(officialWorkflowAutomationIdentities)
        .set({ state: "failed", updatedAt: currentTime })
        .where(
          and(
            eq(officialWorkflowAutomationIdentities.id, previous.id),
            eq(officialWorkflowAutomationIdentities.state, rows.identity.state),
            eq(
              officialWorkflowAutomationIdentities.updatedAt,
              rows.identity.updatedAt,
            ),
            isNull(officialWorkflowAutomationIdentities.automationId),
          ),
        )
        .returning({ id: officialWorkflowAutomationIdentities.id });
      if (!identity) {
        throw new Error(
          "Official Workflow materialization discard lost identity",
        );
      }
      return { previous, current };
    });
  },
);
const discardDormantMaterialization$ = command(
  async (
    { set },
    args: DormantMaterializationOwnershipArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);

    const persisted = await set(persistDiscardedMaterialization$, args, signal);
    if (!persisted) {
      return false;
    }
    const watch = await settle(
      set(
        reconcileAutomationEventWatches$,
        { automations: [persisted.previous] },
        signal,
      ),
      signal,
    );
    if (!watch.ok || !watch.value) {
      return false;
    }
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0210; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // SHARE fences the accepted pointer against the publisher's non-key UPDATE.
      await tx.execute(acceptedCatalogLockStatement());
      const [materializationAutomation] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, args.automationId))
        .for("update")
        .limit(1);
      const [materializationIdentity] = await tx
        .select()
        .from(officialWorkflowAutomationIdentities)
        .where(
          and(
            eq(officialWorkflowAutomationIdentities.id, args.automationId),
            eq(
              officialWorkflowAutomationIdentities.workflowId,
              args.workflowId,
            ),
            eq(
              officialWorkflowAutomationIdentities.blueprintKey,
              args.blueprintKey,
            ),
          ),
        )
        .for("update")
        .limit(1);
      const rows = dormantMaterializationRows(
        materializationAutomation,
        materializationIdentity,
        args,
      );
      if (
        !rows ||
        rows.automation.enabled ||
        rows.automation.officialReconciliationStatus !== "failed" ||
        rows.automation.updatedAt.getTime() !==
          persisted.current.updatedAt.getTime() ||
        rows.identity.state !== "failed"
      ) {
        return false;
      }
      await tx
        .delete(workflowAutomations)
        .where(eq(workflowAutomations.id, rows.automation.id));
      return true;
    });
  },
);

interface DormantBlueprintReconciliationArgs {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly definitionName: string;
  readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  readonly activeDefinitionOnly: boolean;
  readonly identity:
    typeof officialWorkflowAutomationIdentities.$inferSelect | undefined;
  readonly overrides: readonly OfficialWorkflowParameterBinding[];
  readonly userTimezone: string | null;
}

function dormantMaterializationOwnershipArgs(
  args: DormantBlueprintReconciliationArgs,
  materialization: {
    readonly automationId: string;
    readonly bindings: readonly OfficialWorkflowParameterBinding[];
    readonly intendedEnabled: boolean;
  },
): DormantMaterializationOwnershipArgs {
  return {
    orgId: args.orgId,
    userId: args.member.userId,
    workflowId: args.workflowId,
    definitionName: args.definitionName,
    blueprintKey: args.blueprint.key,
    fingerprint: args.blueprint.fingerprint,
    activeDefinitionOnly: args.activeDefinitionOnly,
    resultEmailEnabled: args.blueprint.runtime.resultEmail,
    ...materialization,
  };
}
const resumeDormantMaterialization$ = command(
  async (
    { set },
    args: DormantBlueprintReconciliationArgs,
    materialization: {
      readonly automationId: string;
      readonly bindings: readonly OfficialWorkflowParameterBinding[];
      readonly intendedEnabled: boolean;
    },
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult> => {
    const ownership = dormantMaterializationOwnershipArgs(
      args,
      materialization,
    );
    const staged = await set(
      validateDormantMaterialization$,
      ownership,
      signal,
    );
    if (!staged) {
      await set(discardDormantMaterialization$, ownership, signal);
      return {
        kind: "retry",
        workflowId: args.workflowId,
        message: "Official Workflow reconciliation was superseded",
      };
    }
    if (staged.enabled && !materialization.intendedEnabled) {
      await set(discardDormantMaterialization$, ownership, signal);
      return {
        kind: "retry",
        workflowId: args.workflowId,
        message: "Official Workflow materialization state is inconsistent",
      };
    }
    if (materialization.intendedEnabled && !staged.enabled) {
      const enabled = await settle(
        set(
          enableWorkflowAutomation$,
          {
            orgId: args.orgId,
            member: args.member,
            automationId: materialization.automationId,
            allowReservedOfficialMaterialization: true,
          },
          signal,
        ),
        signal,
      );
      signal.throwIfAborted();
      if (!enabled.ok || enabled.value.kind !== "ok") {
        await set(discardDormantMaterialization$, ownership, signal);
        return {
          kind: "retry",
          workflowId: args.workflowId,
          message: enabled.ok
            ? failureMessage(enabled.value)
            : "Official Workflow materialization lifecycle failed",
        };
      }
    }
    if (await set(finalizeDormantMaterialization$, ownership, signal)) {
      return { kind: "current", workflowId: args.workflowId };
    }
    await set(discardDormantMaterialization$, ownership, signal);
    return {
      kind: "retry",
      workflowId: args.workflowId,
      message: "Official Workflow reconciliation was superseded",
    };
  },
);
const materializeReservedDormantAutomation$ = command(
  async (
    { set },
    args: DormantBlueprintReconciliationArgs,
    resolved: ResolvedBlueprint,
    reservation: {
      readonly id: string;
      readonly intendedEnabled: boolean;
    },
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult> => {
    const created = await settle(
      set(
        createWorkflowAutomation$,
        createInput(
          {
            orgId: args.orgId,
            member: args.member,
            workflowId: args.workflowId,
            definitionName: args.definitionName,
          },
          resolved,
          {
            enabled: false,
            automationId: reservation.id,
            intendedEnabled: reservation.intendedEnabled,
            stagedMaterialization: true,
          },
        ),
        signal,
      ),
      signal,
    );
    if (!created.ok || created.value.kind !== "ok") {
      await set(
        removeDormantCreationOrphan$,
        {
          orgId: args.orgId,
          userId: args.member.userId,
          workflowId: args.workflowId,
          definitionName: args.definitionName,
          blueprint: args.blueprint,
          activeDefinitionOnly: args.activeDefinitionOnly,
          reservationId: reservation.id,
        },
        signal,
      );
      await set(
        retainDormantIdentity$,
        {
          orgId: args.orgId,
          userId: args.member.userId,
          workflowId: args.workflowId,
          definitionName: args.definitionName,
          blueprint: args.blueprint,
          activeDefinitionOnly: args.activeDefinitionOnly,
          bindings: resolved.bindings,
          state: "failed",
          fallbackIntendedEnabled: reservation.intendedEnabled,
        },
        signal,
      );
      return {
        kind: "retry",
        workflowId: args.workflowId,
        message: created.ok
          ? failureMessage(created.value)
          : "Official Workflow Automation creation failed",
      };
    }
    return await set(
      resumeDormantMaterialization$,
      args,
      {
        automationId: reservation.id,
        bindings: resolved.bindings,
        intendedEnabled: reservation.intendedEnabled,
      },
      signal,
    );
  },
);
const reconcileDormantBlueprint$ = command(
  async (
    { set },
    args: DormantBlueprintReconciliationArgs,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult> => {
    const resolution = resolveOfficialWorkflowBlueprintForReconciliation(
      args.blueprint,
      args.identity?.retainedParameterBindings ?? [],
      args.overrides,
      args.userTimezone,
    );
    if (!resolution.ok) {
      const retained = await set(
        retainDormantIdentity$,
        {
          orgId: args.orgId,
          userId: args.member.userId,
          workflowId: args.workflowId,
          definitionName: args.definitionName,
          blueprint: args.blueprint,
          activeDefinitionOnly: args.activeDefinitionOnly,
          bindings: resolution.bindings,
          state: "needs_reconfiguration",
          fallbackIntendedEnabled: false,
        },
        signal,
      );
      return retained
        ? {
            kind: "needs-reconfiguration",
            workflowId: args.workflowId,
            message: resolution.message,
          }
        : {
            kind: "retry",
            workflowId: args.workflowId,
            message: "Official Workflow reconciliation was superseded",
          };
    }
    const reservation = await set(
      reserveDormantIdentity$,
      {
        orgId: args.orgId,
        userId: args.member.userId,
        workflowId: args.workflowId,
        definitionName: args.definitionName,
        blueprint: args.blueprint,
        activeDefinitionOnly: args.activeDefinitionOnly,
        bindings: resolution.resolved.bindings,
        fallbackIntendedEnabled: false,
      },
      signal,
    );
    if (!reservation || reservation.kind !== "reserved") {
      return {
        kind: "retry",
        workflowId: args.workflowId,
        message: "Official Workflow Automation identity is busy",
      };
    }
    const orphanRemoved = await set(
      removeDormantCreationOrphan$,
      {
        orgId: args.orgId,
        userId: args.member.userId,
        workflowId: args.workflowId,
        definitionName: args.definitionName,
        blueprint: args.blueprint,
        activeDefinitionOnly: args.activeDefinitionOnly,
        reservationId: reservation.id,
      },
      signal,
    );
    if (!orphanRemoved) {
      return {
        kind: "retry",
        workflowId: args.workflowId,
        message: "Official Workflow Automation creation recovery is busy",
      };
    }
    signal.throwIfAborted();
    return await set(
      materializeReservedDormantAutomation$,
      args,
      resolution.resolved,
      reservation,
      signal,
    );
  },
);

interface RemoveAutomationConfigurationArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly definition: OfficialWorkflowAcceptedDefinition;
  readonly activeDefinitionOnly: boolean;
  readonly automation: OfficialAutomationRow;
}

function acceptedDefinitionOmitsBlueprint(
  catalog: AcceptedOfficialWorkflowCatalog | null,
  definitionName: string,
  blueprintKey: string | null,
  activeDefinitionOnly: boolean,
): boolean {
  const definition = catalog?.payload.definitions.find((candidate) => {
    return candidate.name === definitionName;
  });
  return (
    definition !== undefined &&
    (!activeDefinitionOnly || definition.lifecycle === "active") &&
    blueprintKey !== null &&
    !definition.blueprints.some((blueprint) => {
      return blueprint.key === blueprintKey;
    })
  );
}

const pauseRemovedAutomationConfiguration$ = command(
  async (
    { set },
    args: RemoveAutomationConfigurationArgs,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly previous: OfficialAutomationRow;
        readonly current: OfficialAutomationRow;
      }
    | undefined
  > => {
    const db = set(writeDb$);

    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0211; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // SHARE fences the accepted pointer against the publisher's non-key UPDATE.
      await tx.execute(acceptedCatalogLockStatement());
      const [catalogRow] = parseRawRows(
        acceptedCatalogRowSchema,
        await tx.execute(acceptedCatalogReadStatement()),
      );
      signal.throwIfAborted();
      if (
        !acceptedDefinitionOmitsBlueprint(
          acceptedCatalogFromRow(catalogRow),
          args.definition.name,
          args.automation.officialBlueprintKey,
          args.activeDefinitionOnly,
        )
      ) {
        return undefined;
      }
      const [installedWorkflow] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          installedWorkflowCondition(
            {
              orgId: args.orgId,
              userId: args.userId,
              definitionName: args.definition.name,
            },
            args.automation.workflowId,
          ),
        )
        .for("update")
        .limit(1);
      if (!installedWorkflow) {
        return undefined;
      }
      const [current] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(observedWorkflowAutomationCondition(args.automation))
        .for("update")
        .limit(1);
      if (!current || !sameAutomationBaseline(args.automation, current)) {
        return undefined;
      }
      const currentTime = nowDate();
      const [row] = await tx
        .update(workflowAutomations)
        .set({
          enabled: false,
          nextRunAt: null,
          officialReconciliationStatus: "reconciling",
          updatedAt: currentTime,
        })
        .where(eq(workflowAutomations.id, current.id))
        .returning(workflowAutomationColumns());
      return row
        ? {
            previous: current,
            current: row,
          }
        : undefined;
    });
  },
);

const deleteRemovedAutomationConfiguration$ = command(
  async (
    { set },
    args: RemoveAutomationConfigurationArgs,
    paused: {
      readonly current: OfficialAutomationRow;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);

    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0212; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // SHARE fences the accepted pointer against the publisher's non-key UPDATE.
      await tx.execute(acceptedCatalogLockStatement());
      const [catalogRow] = parseRawRows(
        acceptedCatalogRowSchema,
        await tx.execute(acceptedCatalogReadStatement()),
      );
      signal.throwIfAborted();
      if (
        !acceptedDefinitionOmitsBlueprint(
          acceptedCatalogFromRow(catalogRow),
          args.definition.name,
          paused.current.officialBlueprintKey,
          args.activeDefinitionOnly,
        )
      ) {
        return false;
      }
      const [installedWorkflow] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          installedWorkflowCondition(
            {
              orgId: args.orgId,
              userId: args.userId,
              definitionName: args.definition.name,
            },
            paused.current.workflowId,
          ),
        )
        .for("update")
        .limit(1);
      if (!installedWorkflow) {
        return false;
      }
      const [current] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, paused.current.id))
        .for("update")
        .limit(1);
      if (
        !current ||
        current.updatedAt.getTime() !== paused.current.updatedAt.getTime() ||
        current.officialReconciliationStatus !== "reconciling" ||
        !current.officialBlueprintKey ||
        !current.officialParameterBindings ||
        current.officialIntendedEnabled === null
      ) {
        return false;
      }
      const currentTime = nowDate();
      await tx
        .insert(officialWorkflowAutomationIdentities)
        .values({
          id: current.id,
          workflowId: current.workflowId,
          automationId: null,
          blueprintKey: current.officialBlueprintKey,
          state: "removed",
          retainedParameterBindings: current.officialParameterBindings,
          retainedIntendedEnabled: current.officialIntendedEnabled,
          retainedAppliedFingerprint: current.officialAppliedFingerprint,
          createdAt: currentTime,
          updatedAt: currentTime,
        })
        .onConflictDoUpdate({
          target: [
            officialWorkflowAutomationIdentities.workflowId,
            officialWorkflowAutomationIdentities.blueprintKey,
          ],
          set: {
            automationId: null,
            state: "removed",
            retainedParameterBindings: current.officialParameterBindings,
            retainedIntendedEnabled: current.officialIntendedEnabled,
            retainedAppliedFingerprint: current.officialAppliedFingerprint,
            updatedAt: currentTime,
          },
        });
      await tx
        .delete(workflowAutomations)
        .where(eq(workflowAutomations.id, current.id));
      return true;
    });
  },
);
const removeAutomationConfiguration$ = command(
  async (
    { set },
    args: RemoveAutomationConfigurationArgs,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult> => {
    const paused = await set(
      pauseRemovedAutomationConfiguration$,
      args,
      signal,
    );
    if (!paused) {
      return {
        kind: "retry",
        workflowId: args.automation.workflowId,
        message: "Official Workflow reconciliation was superseded",
      };
    }
    const watch = await settle(
      set(
        reconcileAutomationEventWatchReconfiguration$,
        {
          previous: [paused.previous],
          current: [paused.current],
          googleForms: [],
        },
        signal,
      ),
      signal,
    );
    if (!watch.ok || watch.value.kind !== "ok") {
      await set(restoreFailedReconfiguration$, {
        orgId: args.orgId,
        userId: args.userId,
        definitionName: args.definition.name,
        persisted: paused,
      });
      signal.throwIfAborted();
      return {
        kind: "retry",
        workflowId: args.automation.workflowId,
        message: watch.ok
          ? eventWatchFailureMessage(watch.value)
          : "Official Workflow event-watch removal failed",
      };
    }
    const removed = await set(
      deleteRemovedAutomationConfiguration$,
      args,
      paused,
      signal,
    );
    if (!removed) {
      await set(restoreFailedReconfiguration$, {
        orgId: args.orgId,
        userId: args.userId,
        definitionName: args.definition.name,
        persisted: paused,
      });
      signal.throwIfAborted();
      return {
        kind: "retry",
        workflowId: args.automation.workflowId,
        message: "Official Workflow Blueprint removal was superseded",
      };
    }
    return { kind: "removed", workflowId: args.automation.workflowId };
  },
);

function mergeResults(
  workflowId: string,
  results: readonly OfficialWorkflowReconciliationResult[],
): OfficialWorkflowReconciliationResult {
  const retry = results.find((result) => {
    return result.kind === "retry";
  });
  if (retry) {
    return retry;
  }
  const needs = results.find((result) => {
    return result.kind === "needs-reconfiguration";
  });
  return needs ?? { kind: "current", workflowId };
}

interface ReconciliationIndexes {
  readonly automationByKey: ReadonlyMap<string, OfficialAutomationRow>;
  readonly identityByKey: ReadonlyMap<
    string,
    typeof officialWorkflowAutomationIdentities.$inferSelect
  >;
  readonly blueprintByKey: ReadonlyMap<
    string,
    OfficialWorkflowAcceptedBlueprint
  >;
}

interface InstallationReconciliationExecution {
  readonly args: ReconcileOfficialWorkflowInstallationArgs;
  readonly context: ReconciliationContext;
  readonly indexes: ReconciliationIndexes;
  readonly overridesByKey: ReadonlyMap<
    string,
    readonly OfficialWorkflowParameterBinding[]
  >;
  readonly userTimezone: string | null;
}

function buildReconciliationIndexes(
  context: ReconciliationContext,
): ReconciliationIndexes {
  return {
    automationByKey: new Map(
      context.automations.flatMap((automation) => {
        return automation.officialBlueprintKey
          ? [[automation.officialBlueprintKey, automation] as const]
          : [];
      }),
    ),
    identityByKey: new Map(
      context.identities.map((identity) => {
        return [identity.blueprintKey, identity] as const;
      }),
    ),
    blueprintByKey: new Map(
      context.blueprints.map((blueprint) => {
        return [blueprint.key, blueprint] as const;
      }),
    ),
  };
}

function invalidReconciliationResult(
  workflowId: string,
  message: string,
): OfficialWorkflowReconciliationResult {
  return { kind: "invalid", workflowId, message };
}

function validateReconciliationOverrides(
  args: ReconcileOfficialWorkflowInstallationArgs,
  indexes: ReconciliationIndexes,
  userTimezone: string | null,
):
  | {
      readonly ok: true;
      readonly overridesByKey: ReadonlyMap<
        string,
        readonly OfficialWorkflowParameterBinding[]
      >;
    }
  | {
      readonly ok: false;
      readonly result: OfficialWorkflowReconciliationResult;
    } {
  const overridesByKey = new Map<
    string,
    readonly OfficialWorkflowParameterBinding[]
  >();
  for (const entry of args.overrides ?? []) {
    if (overridesByKey.has(entry.blueprintKey)) {
      return {
        ok: false,
        result: invalidReconciliationResult(
          args.workflowId,
          `Duplicate Blueprint bindings: ${entry.blueprintKey}`,
        ),
      };
    }
    const blueprint = indexes.blueprintByKey.get(entry.blueprintKey);
    if (!blueprint) {
      return {
        ok: false,
        result: invalidReconciliationResult(
          args.workflowId,
          `Unknown Blueprint: ${entry.blueprintKey}`,
        ),
      };
    }
    const automation = indexes.automationByKey.get(entry.blueprintKey);
    const identity = indexes.identityByKey.get(entry.blueprintKey);
    const validation = resolveOfficialWorkflowBlueprintForReconciliation(
      blueprint,
      automation?.officialParameterBindings ??
        identity?.retainedParameterBindings ??
        [],
      entry.bindings,
      userTimezone,
    );
    if (
      !validation.ok &&
      /^(Duplicate|Unknown|Invalid) /.test(validation.message)
    ) {
      return {
        ok: false,
        result: invalidReconciliationResult(
          args.workflowId,
          validation.message,
        ),
      };
    }
    overridesByKey.set(entry.blueprintKey, entry.bindings);
  }
  return { ok: true, overridesByKey };
}
const reconcileReservedDormantMaterialization$ = command(
  async (
    { set },
    execution: InstallationReconciliationExecution,
    candidate: {
      readonly blueprint: OfficialWorkflowAcceptedBlueprint;
      readonly automation: OfficialAutomationRow;
      readonly identity: typeof officialWorkflowAutomationIdentities.$inferSelect;
    },
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult | null> => {
    const { blueprint, automation, identity } = candidate;
    const { args, context, userTimezone } = execution;
    const overrides = execution.overridesByKey.get(blueprint.key) ?? [];
    const matchingPhase =
      (automation.officialReconciliationStatus === "reconciling" &&
        identity.state === "reconciling") ||
      (automation.officialReconciliationStatus === "failed" &&
        identity.state === "failed");
    if (
      identity.id !== automation.id ||
      identity.automationId !== null ||
      !matchingPhase
    ) {
      return null;
    }
    if (
      automation.officialBlueprintKey === null ||
      automation.officialAppliedFingerprint === null ||
      automation.officialParameterBindings === null ||
      automation.officialIntendedEnabled === null ||
      automation.officialResultEmailEnabled === null
    ) {
      return {
        kind: "retry",
        workflowId: args.workflowId,
        message: "Official Workflow materialization state is incomplete",
      };
    }
    const cleanupOnly =
      automation.officialReconciliationStatus === "failed" ||
      overrides.length !== 0 ||
      automation.officialAppliedFingerprint !== blueprint.fingerprint;
    if (cleanupOnly) {
      await set(
        discardDormantMaterialization$,
        {
          orgId: args.orgId,
          userId: args.member.userId,
          workflowId: args.workflowId,
          definitionName: context.definition.name,
          blueprintKey: automation.officialBlueprintKey,
          fingerprint: automation.officialAppliedFingerprint,
          activeDefinitionOnly: args.activeDefinitionOnly === true,
          automationId: automation.id,
          bindings: automation.officialParameterBindings,
          intendedEnabled: automation.officialIntendedEnabled,
          resultEmailEnabled: automation.officialResultEmailEnabled,
        },
        signal,
      );
      return {
        kind: "retry",
        workflowId: args.workflowId,
        message: "Official Workflow materialization was superseded",
      };
    }
    return await set(
      resumeDormantMaterialization$,
      {
        orgId: args.orgId,
        member: args.member,
        workflowId: args.workflowId,
        definitionName: context.definition.name,
        blueprint,
        activeDefinitionOnly: args.activeDefinitionOnly === true,
        identity,
        overrides,
        userTimezone,
      },
      {
        automationId: automation.id,
        bindings: automation.officialParameterBindings,
        intendedEnabled: automation.officialIntendedEnabled,
      },
      signal,
    );
  },
);
const reconcileCurrentBlueprintLifecycleGap$ = command(
  async (
    { set },
    execution: InstallationReconciliationExecution,
    blueprint: OfficialWorkflowAcceptedBlueprint,
    automation: OfficialAutomationRow,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult | null> => {
    const { args, context } = execution;
    const overrides = execution.overridesByKey.get(blueprint.key) ?? [];
    if (
      overrides.length !== 0 ||
      automation.officialAppliedFingerprint !== blueprint.fingerprint ||
      automation.officialReconciliationStatus !== "current"
    ) {
      return null;
    }
    if (automation.officialIntendedEnabled && !automation.enabled) {
      const enabled = await set(
        enableWorkflowAutomation$,
        { orgId: args.orgId, member: args.member, automationId: automation.id },
        signal,
      );
      signal.throwIfAborted();
      if (enabled.kind !== "ok") {
        await set(
          markActiveAutomationFailed$,
          {
            orgId: args.orgId,
            userId: args.member.userId,
            workflowId: args.workflowId,
            definitionName: context.definition.name,
            blueprint,
            activeDefinitionOnly: args.activeDefinitionOnly === true,
            automationId: automation.id,
            expected: automation,
          },
          signal,
        );
        return {
          kind: "retry",
          workflowId: args.workflowId,
          message: failureMessage(enabled),
        };
      }
    }
    return { kind: "current", workflowId: args.workflowId };
  },
);

const reconcileDesiredBlueprint$ = command(
  async (
    { set },
    execution: InstallationReconciliationExecution,
    blueprint: OfficialWorkflowAcceptedBlueprint,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult> => {
    const { args, context, indexes, userTimezone } = execution;
    const automation = indexes.automationByKey.get(blueprint.key);
    const identity = indexes.identityByKey.get(blueprint.key);
    const overrides = execution.overridesByKey.get(blueprint.key) ?? [];
    if (automation && identity) {
      const materialization = await set(
        reconcileReservedDormantMaterialization$,
        execution,
        { blueprint, automation, identity },
        signal,
      );
      if (materialization) {
        return materialization;
      }
    }
    if (automation) {
      const current = await set(
        reconcileCurrentBlueprintLifecycleGap$,
        execution,
        blueprint,
        automation,
        signal,
      );
      if (current) {
        return current;
      }
    }
    return automation
      ? await set(
          reconcileExistingAutomation$,
          {
            orgId: args.orgId,
            member: args.member,
            definitionName: context.definition.name,
            blueprint,
            activeDefinitionOnly: args.activeDefinitionOnly === true,
            automation,
            overrides,
            userTimezone,
          },
          signal,
        )
      : await set(
          reconcileDormantBlueprint$,
          {
            orgId: args.orgId,
            member: args.member,
            workflowId: args.workflowId,
            definitionName: context.definition.name,
            blueprint,
            activeDefinitionOnly: args.activeDefinitionOnly === true,
            identity: indexes.identityByKey.get(blueprint.key),
            overrides,
            userTimezone,
          },
          signal,
        );
  },
);
const reconcileLoadedInstallation$ = command(
  async (
    { set },
    execution: InstallationReconciliationExecution,
    target: OfficialAutomationRow | undefined,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult> => {
    const { args, context, indexes } = execution;
    const results: OfficialWorkflowReconciliationResult[] = [];
    const removedAutomations = (target ? [target] : context.automations).filter(
      (automation) => {
        return (
          automation.officialBlueprintKey !== null &&
          !indexes.blueprintByKey.has(automation.officialBlueprintKey)
        );
      },
    );
    for (const automation of removedAutomations) {
      results.push(
        await set(
          removeAutomationConfiguration$,
          {
            orgId: args.orgId,
            userId: args.member.userId,
            definition: context.definition,
            activeDefinitionOnly: args.activeDefinitionOnly === true,
            automation,
          },
          signal,
        ),
      );
      signal.throwIfAborted();
    }
    if (target && removedAutomations.length > 0) {
      return results[0] ?? { kind: "removed", workflowId: args.workflowId };
    }
    const desiredBlueprints = target
      ? context.blueprints.filter((blueprint) => {
          return blueprint.key === target.officialBlueprintKey;
        })
      : context.blueprints;
    for (const blueprint of desiredBlueprints) {
      results.push(
        await set(reconcileDesiredBlueprint$, execution, blueprint, signal),
      );
      signal.throwIfAborted();
    }
    return mergeResults(args.workflowId, results);
  },
);
export const reconcileOfficialWorkflowInstallation$ = command(
  async (
    { get, set },
    args: ReconcileOfficialWorkflowInstallationArgs,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult> => {
    const context = await set(loadReconciliationContext$, args, signal);
    if (!context) {
      return { kind: "not-found" };
    }
    const indexes = buildReconciliationIndexes(context);
    const [metadata] = await get(db$)
      .select({ timezone: orgMembersMetadata.timezone })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, args.orgId),
          eq(orgMembersMetadata.userId, args.member.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const userTimezone = metadata?.timezone ?? null;
    const overrides = validateReconciliationOverrides(
      args,
      indexes,
      userTimezone,
    );
    if (!overrides.ok) {
      return overrides.result;
    }
    const target =
      args.targetAutomationId === undefined
        ? undefined
        : context.automations.find((automation) => {
            return automation.id === args.targetAutomationId;
          });
    if (args.targetAutomationId !== undefined && !target) {
      return { kind: "not-found" };
    }
    return await set(
      reconcileLoadedInstallation$,
      {
        args,
        context,
        indexes,
        overridesByKey: overrides.overridesByKey,
        userTimezone,
      },
      target,
      signal,
    );
  },
);
