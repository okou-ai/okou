import { PROACTIVE_JOBS_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/proactive-jobs";
import { synchronizeOfficialWorkflowThread$ } from "./official-workflow-thread.service";
import { isDeepStrictEqual } from "node:util";

import type {
  OfficialWorkflowAcceptedBlueprint,
  OfficialWorkflowAcceptedDefinition,
  OfficialWorkflowParameterBinding,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  isMorningBriefDefinitionName,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { googleFormsResponseSubmittedEventConfigSchema } from "@okouai/api-contracts/contracts/workflows";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import {
  officialWorkflowCatalogState,
  officialWorkflowCatalogReleases,
  officialWorkflowDefinitionRevisions,
} from "@okouai/db/schema/official-workflow-catalog";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import {
  googleFormsAutomationCursors,
  googleFormsWatchStates,
} from "@okouai/db/schema/google-forms-event";
import {
  officialWorkflowAutomationIdentities,
  workflowWebhookAutomations,
  workflows,
} from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import {
  and,
  asc,
  count,
  eq,
  exists,
  getTableColumns,
  gte,
  isNull,
  inArray,
  isNotNull,
  ne,
  notExists,
  or,
  sql,
  WithSubquery,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { boolean, object, uuid } from "zod";

import { nowDate, nowDateSql, timestampWithoutTimeZone } from "../../lib/time";
import {
  pgBooleanDecoder,
  pgNullDecoder,
  pgTextDecoder,
  nullableDriverValueDecoder,
} from "../../lib/db-structured-result";

import {
  webhookTierLockStatement,
  webhookTierFromRows,
  webhookTierRowSchema,
  acceptedBlueprintDefinitionFromRows,
  acceptedRevisionBlueprintRowsMatch,
  matchingAcceptedBlueprintDefinition,
  acceptedRevisionBlueprintMatches,
  type AcceptedBlueprintIdentity,
  acceptedCatalogRowSchema,
  acceptedCatalogReadStatement,
  acceptedCatalogDefinitionRevision,
  acceptedCatalogLockStatement,
  acceptedRevisionRowSchema,
  acceptedRevisionReadStatement,
} from "./official-workflow-reconciliation-sql";
import { parseRawRows } from "../../lib/db-raw-rows";
import {
  officialAccountProjectionReadPlan,
  officialAccountProjectionFromRow,
  type OfficialAutomationAccountProjection,
} from "./official-workflow-account-projection";

import { db$, rawSqlReadDb$, writeDb$ } from "../external/db";
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
import {
  notionConfigConnectorId,
  notionConfigWithConnectorId,
} from "./notion-automation-account.service";
import {
  acceptedCatalogFromRow,
  OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
  acceptedOfficialWorkflowCatalogReadPlan,
  acceptedOfficialWorkflowRevisionReadPlan,
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
import { withMorningBriefCronBinding } from "./official-workflow-owner-schedule";
import { calculateNextRun } from "./time-automation";
import {
  createWorkflowAutomation$,
  enableWorkflowAutomation$,
  prepareOfficialAutomationReconfiguration$,
  type AutomationResult,
  type CreateAutomationInput,
  type OfficialAutomationEventPreparation,
} from "./workflow-automation.service";
import type { WorkflowMember } from "./workflow-data.service";

const DORMANT_CREATION_LEASE_MS = 5 * 60 * 1000;

export type ReconcileOfficialWorkflowInstallationArgs =
  OfficialWorkflowReconciliationArgs;

export type { OfficialWorkflowReconciliationResult };

interface ReconciliationContext {
  readonly catalog: AcceptedOfficialWorkflowCatalog;
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
  // Jobs owns the empty idle/in-flight slot and its completion-based interval.
  if (automation.officialBlueprintKey === PROACTIVE_JOBS_BLUEPRINT_KEY) {
    return automation.nextRunAt;
  }
  if (
    automation.officialBlueprintKey !== MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY ||
    nextRunAt === null
  ) {
    return nextRunAt;
  }
  return sql`CASE WHEN (SELECT settlement FROM morning_brief_schedule_claims WHERE automation_id = ${automation.id}::uuid ORDER BY claim_sequence DESC LIMIT 1) = 'unsettled' THEN NULL ELSE ${nextRunAt}::timestamp END`;
}

/**
 * Moving the Morning Brief start earlier must not skip a day: when the new time
 * already passed since the last run, keep the pending occurrence once. Its
 * completion callback then advances on the new schedule.
 */
function keepSkippedMorningBriefOccurrence(
  current: OfficialAutomationRow,
  refreshed: OfficialAutomationPatch,
  currentTime: Date,
): Date | null {
  const pending = current.nextRunAt;
  const next = refreshed.nextRunAt;
  if (
    current.officialBlueprintKey !== MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY ||
    pending === null ||
    next === null ||
    refreshed.cronExpression === null ||
    current.timezone !== refreshed.timezone ||
    pending.getTime() <= currentTime.getTime() ||
    pending.getTime() >= next.getTime()
  ) {
    return next;
  }
  const skipped = calculateNextRun(
    refreshed.cronExpression,
    refreshed.timezone,
    current.lastRunAt ?? current.createdAt,
  );
  return skipped !== null && skipped.getTime() <= currentTime.getTime()
    ? pending
    : next;
}

function isMorningBriefReconciliation(args: {
  readonly definitionName: string;
  readonly blueprintKey: string | null;
}): boolean {
  return (
    isMorningBriefDefinitionName(args.definitionName) &&
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
  return true;
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
    if (!catalog) {
      return null;
    }
    const definition = catalog.payload.definitions.find((candidate) => {
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
      catalog,
      definition,
      blueprints: revision.definition.blueprints,
      automations,
      identities,
    };
  },
);

const persistMorningBriefScheduleRecovery$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly context: ReconciliationContext;
      readonly automation: OfficialAutomationRow;
      readonly patch: OfficialAutomationPatch;
      readonly userTimezone: string | null;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const { context, automation, patch } = args;
    const catalogPlan = acceptedOfficialWorkflowCatalogReadPlan();
    const revisionPlan = acceptedOfficialWorkflowRevisionReadPlan(
      context.definition,
    );
    const timezoneQuery = db
      .select({ userId: orgMembersMetadata.userId })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, args.orgId),
          eq(orgMembersMetadata.userId, args.userId),
          args.userTimezone === null
            ? isNotNull(orgMembersMetadata.timezone)
            : eq(orgMembersMetadata.timezone, args.userTimezone),
        ),
      );
    const [updated] = await db
      .update(workflowAutomations)
      .set({
        ...patch,
        officialReconciliationStatus: "current",
        nextRunAt: reconciledScheduleAnchor(
          automation,
          keepSkippedMorningBriefOccurrence(automation, patch, patch.updatedAt),
        ),
      })
      .where(
        and(
          observedWorkflowAutomationCondition(automation),
          exists(
            db
              .select({ id: workflows.id })
              .from(workflows)
              .where(
                installedWorkflowCondition(
                  { ...args, definitionName: context.definition.name },
                  automation.workflowId,
                ),
              ),
          ),
          exists(
            db
              .select({ id: officialWorkflowAutomationIdentities.id })
              .from(officialWorkflowAutomationIdentities)
              .where(
                and(
                  eq(
                    officialWorkflowAutomationIdentities.workflowId,
                    automation.workflowId,
                  ),
                  eq(
                    officialWorkflowAutomationIdentities.blueprintKey,
                    MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
                  ),
                  eq(
                    officialWorkflowAutomationIdentities.automationId,
                    automation.id,
                  ),
                  eq(officialWorkflowAutomationIdentities.state, "active"),
                ),
              ),
          ),
          exists(
            db
              .select(catalogPlan.columns)
              .from(officialWorkflowCatalogState)
              .innerJoin(officialWorkflowCatalogReleases, catalogPlan.join)
              .where(
                and(
                  catalogPlan.condition,
                  eq(
                    officialWorkflowCatalogState.acceptedReleaseId,
                    context.catalog.releaseId,
                  ),
                ),
              ),
          ),
          exists(
            db
              .select(revisionPlan.columns)
              .from(officialWorkflowDefinitionRevisions)
              .innerJoin(storages, revisionPlan.storageJoin)
              .innerJoin(storageVersions, revisionPlan.storageVersionJoin)
              .where(revisionPlan.condition),
          ),
          args.userTimezone === null
            ? notExists(timezoneQuery)
            : exists(timezoneQuery),
          notExists(
            db
              .select({ userId: morningBriefEnrollments.userId })
              .from(morningBriefEnrollments)
              .where(
                and(
                  eq(morningBriefEnrollments.orgId, args.orgId),
                  eq(morningBriefEnrollments.userId, args.userId),
                  eq(morningBriefEnrollments.state, "departed"),
                ),
              ),
          ),
        ),
      )
      .returning({ id: workflowAutomations.id });
    signal.throwIfAborted();
    return updated !== undefined;
  },
);

function morningBriefScheduleRecoveryTarget(
  context: ReconciliationContext | null,
) {
  if (!context || !isMorningBriefDefinitionName(context.definition.name)) {
    return null;
  }
  const automation = context.automations.find((row) => {
    return row.officialBlueprintKey === MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY;
  });
  const blueprint = context.blueprints.find((row) => {
    return row.key === MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY;
  });
  if (
    !automation ||
    automation.kind !== "schedule" ||
    automation.scheduleType !== "cron" ||
    automation.officialIntendedEnabled === null ||
    automation.officialParameterBindings === null ||
    (automation.officialReconciliationStatus !== "current" &&
      automation.officialReconciliationStatus !== "needs_reconfiguration") ||
    !blueprint ||
    !context.identities.some((identity) => {
      return (
        identity.automationId === automation.id && identity.state === "active"
      );
    })
  ) {
    return null;
  }
  return {
    context,
    automation,
    blueprint,
    intendedEnabled: automation.officialIntendedEnabled,
    bindings: automation.officialParameterBindings,
  };
}

/** Recover only the existing cron row; no installation or event lifecycle writes. */
export const reconcileOfficialMorningBriefSchedule$ = command(
  async (
    { get, set },
    args: ReconcileOfficialWorkflowInstallationArgs,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult> => {
    const target = morningBriefScheduleRecoveryTarget(
      await set(
        loadReconciliationContext$,
        { ...args, activeDefinitionOnly: true },
        signal,
      ),
    );
    if (!target) {
      return retryReconciliation(args.workflowId);
    }
    const { context, automation, blueprint, intendedEnabled, bindings } =
      target;
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
    const resolved = resolveOfficialWorkflowBlueprintForReconciliation(
      blueprint,
      withMorningBriefCronBinding({
        definitionName: context.definition.name,
        blueprint,
        owner: { orgId: args.orgId, userId: args.member.userId },
        bindings,
      }),
      userTimezone,
    );
    if (
      !resolved.ok ||
      !("schedule" in resolved.resolved.createRequest) ||
      resolved.resolved.createRequest.schedule.type !== "cron"
    ) {
      return needsReconfigurationResult(args.workflowId, blueprint.key);
    }
    const built = buildOfficialAutomationPatch(
      { ...automation, enabled: intendedEnabled },
      resolved.resolved,
      undefined,
      nowDate(),
    );
    if (!built.ok) {
      return needsReconfigurationResult(args.workflowId, blueprint.key);
    }
    const patch = built.patch;
    if (
      automation.officialReconciliationStatus === "current" &&
      automation.officialAppliedFingerprint ===
        patch.officialAppliedFingerprint &&
      automation.cronExpression === patch.cronExpression &&
      automation.timezone === patch.timezone &&
      automation.enabled === patch.enabled &&
      isDeepStrictEqual(
        automation.officialParameterBindings,
        patch.officialParameterBindings,
      )
    ) {
      return { kind: "current", workflowId: args.workflowId };
    }
    const persisted = await set(
      persistMorningBriefScheduleRecovery$,
      {
        orgId: args.orgId,
        userId: args.member.userId,
        context,
        automation,
        patch,
        userTimezone,
      },
      signal,
    );
    return persisted
      ? { kind: "current", workflowId: args.workflowId }
      : retryReconciliation(args.workflowId);
  },
);

function failedAutomationBaselineCondition(expected: OfficialAutomationRow) {
  // Match the original Date.getTime() comparison, including invalid Dates,
  // without strengthening this baseline to an exact row-version condition.
  if (Number.isNaN(expected.updatedAt.getTime())) {
    return sql`false`;
  }
  return and(
    eq(workflowAutomations.id, expected.id),
    eq(
      sql`date_trunc('milliseconds', ${workflowAutomations.updatedAt})`,
      sql`${sql.param(expected.updatedAt, workflowAutomations.updatedAt)}::timestamp`,
    ),
    expected.officialBlueprintKey === null
      ? isNull(workflowAutomations.officialBlueprintKey)
      : eq(
          workflowAutomations.officialBlueprintKey,
          expected.officialBlueprintKey,
        ),
    expected.officialAppliedFingerprint === null
      ? isNull(workflowAutomations.officialAppliedFingerprint)
      : eq(
          workflowAutomations.officialAppliedFingerprint,
          expected.officialAppliedFingerprint,
        ),
    expected.officialReconciliationStatus === null
      ? isNull(workflowAutomations.officialReconciliationStatus)
      : eq(
          workflowAutomations.officialReconciliationStatus,
          expected.officialReconciliationStatus,
        ),
    eq(workflowAutomations.enabled, expected.enabled),
    expected.officialIntendedEnabled === null
      ? isNull(workflowAutomations.officialIntendedEnabled)
      : eq(
          workflowAutomations.officialIntendedEnabled,
          expected.officialIntendedEnabled,
        ),
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
    )
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

interface ReconfigurationPatchArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly definitionName: string;
  readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  readonly activeDefinitionOnly: boolean;
  readonly expected: OfficialAutomationRow;
  readonly patch: OfficialAutomationPatch;
  readonly preparation: OfficialAutomationEventPreparation | undefined;
}

function reconfigurationPatchOwnership(
  args: ReconfigurationPatchArgs,
  releaseId: string,
  current: OfficialAutomationRow,
) {
  const builder = new QueryBuilder();
  const catalogFence = builder.$with("reconfigure_catalog_fence").as(
    builder
      .select({ authority: officialWorkflowCatalogState.authority })
      .from(officialWorkflowCatalogState)
      .where(
        and(
          eq(
            officialWorkflowCatalogState.authority,
            OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
          ),
          eq(officialWorkflowCatalogState.acceptedReleaseId, releaseId),
        ),
      )
      .for("share"),
  );
  const installation = builder.$with("reconfigure_installed_workflow").as(
    builder
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          installedWorkflowCondition(args, current.workflowId),
          exists(builder.select().from(catalogFence)),
        ),
      )
      .for("update")
      .limit(1),
  );
  const locked = builder.$with("reconfigure_locked_automation").as(
    builder
      .select({ id: workflowAutomations.id })
      .from(workflowAutomations)
      .where(
        and(
          observedWorkflowAutomationCondition(current),
          exists(builder.select().from(installation)),
        ),
      )
      .for("update")
      .limit(1),
  );
  return { catalogFence, installation, locked };
}

function reconfigurationPatchPublication(
  current: OfficialAutomationRow,
  patch: OfficialAutomationPatch,
  currentTime: Date,
) {
  const enabled = current.officialIntendedEnabled === true || current.enabled;
  const refreshed = refreshOfficialAutomationPatch(
    current,
    { ...patch, enabled },
    currentTime,
  );
  if (!current.officialBlueprintKey) {
    throw new Error("Official Workflow automation identity is incomplete");
  }
  const automation = alias(
    workflowAutomations,
    "reconfigure_updated_automation",
  );
  const identities = officialWorkflowAutomationIdentities;
  return {
    values: {
      ...refreshed,
      nextRunAt: reconciledScheduleAnchor(
        current,
        keepSkippedMorningBriefOccurrence(current, refreshed, currentTime),
      ),
    },
    resetCursor: googleFormsCursorMustReset(current, {
      ...current,
      ...refreshed,
    }),
    identitySelection: {
      id: automation.id,
      workflowId: automation.workflowId,
      automationId: automation.id,
      blueprintKey: automation.officialBlueprintKey,
      state: sql`'active'`.mapWith(identities.state).as("state"),
      retainedParameterBindings: sql`NULL`
        .mapWith(pgNullDecoder)
        .as("retained_parameter_bindings"),
      retainedIntendedEnabled: sql`NULL`
        .mapWith(pgNullDecoder)
        .as("retained_intended_enabled"),
      retainedAppliedFingerprint: sql`NULL`
        .mapWith(pgNullDecoder)
        .as("retained_applied_fingerprint"),
      createdAt: automation.updatedAt,
      updatedAt: automation.updatedAt,
    },
    identityConflict: {
      target: [identities.workflowId, identities.blueprintKey],
      set: {
        automationId: sql`excluded.automation_id`,
        state: "active" as const,
        retainedParameterBindings: null,
        retainedIntendedEnabled: null,
        retainedAppliedFingerprint: null,
        updatedAt: sql`excluded.updated_at`,
      },
    },
  };
}

const persistReconfigurationPatch$ = command(
  async (
    { set },
    args: ReconfigurationPatchArgs,
    signal: AbortSignal,
  ): Promise<PersistedReconfiguration | null> => {
    const db = set(writeDb$);
    const [catalogRow] = parseRawRows(
      acceptedCatalogRowSchema,
      await db.execute(acceptedCatalogReadStatement()),
    );
    signal.throwIfAborted();
    const catalogIdentity = blueprintAuthorityIdentity(args);
    const catalog = acceptedCatalogFromRow(catalogRow);
    const acceptedDefinition = matchingAcceptedBlueprintDefinition(
      catalog,
      catalogIdentity,
    );
    if (!catalog || !acceptedDefinition) {
      return null;
    }
    const [revisionRow] = parseRawRows(
      acceptedRevisionRowSchema,
      await db.execute(acceptedRevisionReadStatement(acceptedDefinition)),
    );
    signal.throwIfAborted();
    if (!acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)) {
      return null;
    }
    const accountPlan = officialAccountProjectionReadPlan({
      orgId: args.orgId,
      userId: args.userId,
      workflowId: args.expected.workflowId,
      currentEventType: args.expected.eventType,
      nextEventType: args.patch.eventType,
    });
    const accountRows = accountPlan.required
      ? await db.select(accountPlan.columns).from(accountPlan.source)
      : [];
    if (accountPlan.required) {
      signal.throwIfAborted();
    }
    const accountProjection = officialAccountProjectionFromRow(
      accountPlan,
      accountRows[0],
    );
    const [current] = await db
      .select(workflowAutomationColumns())
      .from(workflowAutomations)
      .where(reconfigurationSourceCondition(args.expected))
      .limit(1);
    signal.throwIfAborted();
    if (
      !current ||
      !sameAutomationConfigurationBaseline(args.expected, current) ||
      !accountProjectionMatchesPatch(accountProjection, args.patch)
    ) {
      return null;
    }
    const publication = reconfigurationPatchPublication(
      current,
      args.patch,
      nowDate(),
    );
    const { catalogFence, installation, locked } =
      reconfigurationPatchOwnership(args, catalog.releaseId, current);
    const columns = workflowAutomationColumns();
    // Preparation may race a pause or another reconciliation. The final exact
    // tuple predicate rejects that attempt instead of overwriting its intent.
    const updated = db.$with("reconfigure_updated_automation").as(
      db
        .update(workflowAutomations)
        .set(publication.values)
        .from(locked)
        .where(eq(workflowAutomations.id, locked.id))
        .returning({
          ...columns,
          observedUpdatedAt: columns.observedUpdatedAt.as("observedUpdatedAt"),
          observedXmin: columns.observedXmin.as("observedXmin"),
        }),
    );
    const removedCursor = db.$with("reconfigure_removed_forms_cursor").as(
      db
        .delete(googleFormsAutomationCursors)
        .where(
          and(
            eq(googleFormsAutomationCursors.automationId, current.id),
            exists(db.select().from(updated)),
            publication.resetCursor ? sql`true` : sql`false`,
          ),
        )
        .returning({ automationId: googleFormsAutomationCursors.automationId }),
    );
    const identities = officialWorkflowAutomationIdentities;
    const identity = db.$with("reconfigure_updated_identity").as(
      db
        .insert(identities)
        .select(
          db
            .select(publication.identitySelection)
            .from(updated)
            .where(gte(db.select({ count: count() }).from(removedCursor), 0)),
        )
        .onConflictDoUpdate(publication.identityConflict)
        .returning({ automationId: identities.automationId }),
    );
    const [result] = await db
      .with(
        catalogFence,
        installation,
        locked,
        updated,
        removedCursor,
        identity,
      )
      .select({
        current: automationMaterializationColumns(
          "reconfigure_updated_automation",
        ),
      })
      .from(updated)
      .innerJoin(identity, eq(identity.automationId, updated.id));
    signal.throwIfAborted();
    return result ? { previous: current, current: result.current } : null;
  },
);

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

function restoredAutomationAccountFields(
  previous: OfficialAutomationRow,
  required: boolean,
  connectorId: ReturnType<typeof sql>,
) {
  if (!required) {
    return {};
  }
  const previousConnectorId = notionConfigConnectorId(
    previous.eventType,
    previous.eventConfig,
  );
  const notion =
    previousConnectorId === null
      ? null
      : notionConfigWithConnectorId(
          previous.eventType,
          previous.eventConfig,
          previousConnectorId,
        );
  return {
    eventConnectorId: connectorId,
    ...(notion === null
      ? {}
      : {
          eventConfig: sql`CASE WHEN ${connectorId} IS NULL
        THEN ${sql.param(previous.eventConfig, workflowAutomations.eventConfig)}
        ELSE ${sql.param(notion, workflowAutomations.eventConfig)}
          || jsonb_build_object('connectorId', ${connectorId}::text) END`,
        }),
  };
}

interface FailedReconfigurationArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly definitionName: string;
  readonly persisted: PersistedReconfiguration;
}

function failedReconfigurationRestorePlan(
  args: FailedReconfigurationArgs,
  currentTime: Date,
) {
  const previous = args.persisted.previous;
  const current = args.persisted.current;
  const accountPlan = officialAccountProjectionReadPlan({
    orgId: args.orgId,
    userId: args.userId,
    workflowId: previous.workflowId,
    currentEventType: current.eventType,
    nextEventType: previous.eventType,
  });
  const builder = new QueryBuilder();
  const catalogFence = builder
    .$with("restore_catalog_fence")
    .as(
      builder
        .select({ authority: officialWorkflowCatalogState.authority })
        .from(officialWorkflowCatalogState)
        .where(
          eq(
            officialWorkflowCatalogState.authority,
            OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
          ),
        )
        .for("share"),
    );
  const installation = builder.$with("restore_installed_workflow").as(
    builder
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          installedWorkflowCondition(args, previous.workflowId),
          gte(builder.select({ count: count() }).from(catalogFence), 0),
        ),
      )
      .for("update")
      .limit(1),
  );
  // Keep the original catalog -> installation -> exact observed automation
  // lock order. A changed tuple cannot be restored from this compensation.
  const locked = builder.$with("restore_locked_automation").as(
    builder
      .select({ id: workflowAutomations.id })
      .from(workflowAutomations)
      .where(
        and(
          observedWorkflowAutomationCondition(current),
          eq(
            sql`date_trunc('milliseconds', ${workflowAutomations.updatedAt})`,
            sql`${timestampWithoutTimeZone(current.updatedAt)}::timestamp`,
          ),
          exists(builder.select().from(installation)),
        ),
      )
      .for("update")
      .limit(1),
  );
  const projection = builder.$with("restore_account_projection").as(
    builder
      .select({
        connectorId: accountPlan.columns.connectorId.as("connector_id"),
      })
      .from(accountPlan.source),
  );
  const projectedConnectorId = sql`(${builder
    .select({ connectorId: projection.connectorId })
    .from(projection)})`;
  const restorePatch = officialAutomationRestorePatch(
    previous,
    previous.nextRunAt,
    currentTime,
  );
  const restoredValues = {
    ...restorePatch,
    nextRunAt: reconciledScheduleAnchor(current, restorePatch.nextRunAt),
    ...restoredAutomationAccountFields(
      previous,
      accountPlan.required,
      projectedConnectorId,
    ),
    enabled: previous.enabled,
    officialIntendedEnabled: previous.officialIntendedEnabled,
    officialReconciliationStatus: "failed" as const,
  };
  const resetForConfiguration = googleFormsCursorMustReset(current, {
    ...current,
    ...restorePatch,
    eventConnectorId: current.eventConnectorId,
    enabled: previous.enabled,
    officialIntendedEnabled: previous.officialIntendedEnabled,
  });
  const resetForAccount = accountPlan.required
    ? sql`${current.eventConnectorId}::uuid IS DISTINCT FROM ${projectedConnectorId}`
    : sql`${current.eventConnectorId}::uuid IS DISTINCT FROM ${previous.eventConnectorId}::uuid`;
  const formsChanged =
    current.eventType === "google-forms-response-submitted" ||
    previous.eventType === "google-forms-response-submitted";
  return {
    catalogFence,
    installation,
    locked,
    projection,
    restoredValues,
    cursorReset: resetForConfiguration
      ? sql`true`
      : formsChanged
        ? resetForAccount
        : sql`false`,
  };
}

const restoreFailedReconfiguration$ = command(
  async ({ set }, args: FailedReconfigurationArgs): Promise<void> => {
    const db = set(writeDb$);
    const cleanupSignal = new AbortController().signal;
    const previous = args.persisted.previous;
    const current = args.persisted.current;
    if (!Number.isFinite(current.updatedAt.getTime())) {
      return;
    }
    if (!previous.officialBlueprintKey) {
      throw new Error("Official Workflow automation identity is incomplete");
    }
    const {
      catalogFence,
      installation,
      locked,
      projection,
      restoredValues,
      cursorReset,
    } = failedReconfigurationRestorePlan(args, nowDate());
    const columns = workflowAutomationColumns();
    const updated = db.$with("restore_updated_automation").as(
      db
        .update(workflowAutomations)
        .set(restoredValues)
        .from(locked)
        .where(eq(workflowAutomations.id, locked.id))
        .returning({
          ...columns,
          observedUpdatedAt: columns.observedUpdatedAt.as("observedUpdatedAt"),
          observedXmin: columns.observedXmin.as("observedXmin"),
        }),
    );
    const removedCursor = db.$with("restore_removed_forms_cursor").as(
      db
        .delete(googleFormsAutomationCursors)
        .where(
          and(
            eq(googleFormsAutomationCursors.automationId, current.id),
            exists(db.select().from(updated)),
            cursorReset,
          ),
        )
        .returning({ automationId: googleFormsAutomationCursors.automationId }),
    );
    const identities = officialWorkflowAutomationIdentities;
    const identity = db.$with("restore_updated_identity").as(
      db
        .insert(identities)
        .select(
          db
            .select({
              id: updated.id,
              workflowId: updated.workflowId,
              automationId: updated.id,
              blueprintKey: updated.officialBlueprintKey,
              state: sql`'active'`.mapWith(identities.state).as("state"),
              retainedParameterBindings: sql`NULL`
                .mapWith(pgNullDecoder)
                .as("retained_parameter_bindings"),
              retainedIntendedEnabled: sql`NULL`
                .mapWith(pgNullDecoder)
                .as("retained_intended_enabled"),
              retainedAppliedFingerprint: sql`NULL`
                .mapWith(pgNullDecoder)
                .as("retained_applied_fingerprint"),
              createdAt: updated.updatedAt,
              updatedAt: updated.updatedAt,
            })
            .from(updated)
            .where(gte(db.select({ count: count() }).from(removedCursor), 0)),
        )
        .onConflictDoUpdate({
          target: [identities.workflowId, identities.blueprintKey],
          set: {
            automationId: sql`excluded.automation_id`,
            state: "active",
            retainedParameterBindings: null,
            retainedIntendedEnabled: null,
            retainedAppliedFingerprint: null,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .returning({ automationId: identities.automationId }),
    );
    const [result] = await db
      .with(
        catalogFence,
        installation,
        locked,
        projection,
        updated,
        removedCursor,
        identity,
      )
      .select({
        restored: automationMaterializationColumns(
          "restore_updated_automation",
        ),
      })
      .from(updated)
      .innerJoin(identity, eq(identity.automationId, updated.id));
    const restored = result?.restored;
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

interface FinalizeReconfigurationArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly definitionName: string;
  readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  readonly activeDefinitionOnly: boolean;
  readonly persisted: PersistedReconfiguration;
}

function finalizationCondition(
  current: OfficialAutomationRow,
  fingerprint: string,
) {
  return and(
    observedWorkflowAutomationCondition(current),
    eq(
      sql`date_trunc('milliseconds', ${workflowAutomations.updatedAt})`,
      sql`${sql.param(current.updatedAt, workflowAutomations.updatedAt)}::timestamp`,
    ),
    eq(workflowAutomations.officialReconciliationStatus, "reconciling"),
    eq(workflowAutomations.officialAppliedFingerprint, fingerprint),
  );
}

const finalizeReconfiguration$ = command(
  async (
    { get, set },
    args: FinalizeReconfigurationArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const readDb = get(rawSqlReadDb$);
    const [catalogRow] = parseRawRows(
      acceptedCatalogRowSchema,
      await readDb.execute(acceptedCatalogReadStatement()),
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
      await readDb.execute(acceptedRevisionReadStatement(acceptedDefinition)),
    );
    signal.throwIfAborted();
    if (!acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)) {
      return false;
    }

    const current = args.persisted.current;
    // Invalid Date observations never matched the original getTime comparison.
    if (!Number.isFinite(current.updatedAt.getTime())) {
      return false;
    }

    const db = set(writeDb$);
    const currentTime = nowDate();
    const columns = workflowAutomationColumns();
    const identities = officialWorkflowAutomationIdentities;
    // Catalog and installation authority are observations. The actual target
    // retains its complete observed version predicate after any implicit wait.
    const finalized = db.$with("finalized_official_reconfiguration").as(
      db
        .update(workflowAutomations)
        .set({
          officialReconciliationStatus: "current",
          updatedAt: currentTime,
        })
        .where(
          and(
            finalizationCondition(current, args.blueprint.fingerprint),
            exists(
              db
                .select({ id: workflows.id })
                .from(workflows)
                .where(installedWorkflowCondition(args, current.workflowId)),
            ),
          ),
        )
        .returning({
          ...columns,
          observedUpdatedAt: columns.observedUpdatedAt.as("observedUpdatedAt"),
          observedXmin: columns.observedXmin.as("observedXmin"),
        }),
    );
    const identity = db.$with("finalized_official_identity").as(
      db
        .insert(identities)
        .select(
          db
            .select({
              id: finalized.id,
              workflowId: finalized.workflowId,
              automationId: finalized.id,
              blueprintKey: finalized.officialBlueprintKey,
              state: sql`'active'`.mapWith(identities.state).as("state"),
              retainedParameterBindings: sql`NULL`
                .mapWith(pgNullDecoder)
                .as("retained_parameter_bindings"),
              retainedIntendedEnabled: sql`NULL`
                .mapWith(pgNullDecoder)
                .as("retained_intended_enabled"),
              retainedAppliedFingerprint: sql`NULL`
                .mapWith(pgNullDecoder)
                .as("retained_applied_fingerprint"),
              createdAt: sql`${sql.param(currentTime, identities.createdAt)}`
                .mapWith(identities.createdAt)
                .as("created_at"),
              updatedAt: sql`${sql.param(currentTime, identities.updatedAt)}`
                .mapWith(identities.updatedAt)
                .as("updated_at"),
            })
            .from(finalized),
        )
        .onConflictDoUpdate({
          target: [identities.workflowId, identities.blueprintKey],
          set: {
            automationId: sql`excluded.automation_id`,
            state: "active",
            retainedParameterBindings: null,
            retainedIntendedEnabled: null,
            retainedAppliedFingerprint: null,
            updatedAt: currentTime,
          },
        })
        .returning({
          automationId: identities.automationId,
        }),
    );
    const touched = db
      .$with("finalized_official_workflow")
      .as(
        db
          .update(workflows)
          .set({ updatedBy: args.userId, updatedAt: currentTime })
          .from(finalized)
          .innerJoin(identity, eq(identity.automationId, finalized.id))
          .where(eq(workflows.id, finalized.workflowId))
          .returning({ id: workflows.id }),
      );
    // Consume every write, but retain the original success condition: a
    // workflow touch with no returned row does not negate finalization.
    const [row] = await db
      .with(finalized, identity, touched)
      .select()
      .from(finalized)
      .innerJoin(identity, eq(identity.automationId, finalized.id))
      .leftJoin(touched, eq(touched.id, finalized.workflowId));
    signal.throwIfAborted();
    return row !== undefined;
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
    const [catalogRow] = parseRawRows(
      acceptedCatalogRowSchema,
      await db.execute(acceptedCatalogReadStatement()),
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
      await db.execute(acceptedRevisionReadStatement(acceptedDefinition)),
    );
    signal.throwIfAborted();
    if (!acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)) {
      return null;
    }
    const expected = args.automation;
    if (!Number.isFinite(expected.updatedAt.getTime())) {
      return null;
    }
    const currentTime = nowDate();
    const columns = workflowAutomationColumns();
    const paused = db.$with("paused_official_automation").as(
      db
        .update(workflowAutomations)
        .set({
          enabled: false,
          nextRunAt: null,
          officialParameterBindings: [...args.bindings],
          officialReconciliationStatus: "needs_reconfiguration",
          updatedAt: currentTime,
        })
        .where(
          and(
            observedWorkflowAutomationCondition(expected),
            eq(
              sql`date_trunc('milliseconds', ${workflowAutomations.updatedAt})`,
              sql`${timestampWithoutTimeZone(expected.updatedAt)}::timestamp`,
            ),
            expected.officialBlueprintKey === null
              ? isNull(workflowAutomations.officialBlueprintKey)
              : eq(
                  workflowAutomations.officialBlueprintKey,
                  expected.officialBlueprintKey,
                ),
            expected.officialAppliedFingerprint === null
              ? isNull(workflowAutomations.officialAppliedFingerprint)
              : eq(
                  workflowAutomations.officialAppliedFingerprint,
                  expected.officialAppliedFingerprint,
                ),
            expected.officialReconciliationStatus === null
              ? isNull(workflowAutomations.officialReconciliationStatus)
              : eq(
                  workflowAutomations.officialReconciliationStatus,
                  expected.officialReconciliationStatus,
                ),
            eq(workflowAutomations.enabled, expected.enabled),
            expected.officialIntendedEnabled === null
              ? isNull(workflowAutomations.officialIntendedEnabled)
              : eq(
                  workflowAutomations.officialIntendedEnabled,
                  expected.officialIntendedEnabled,
                ),
            exists(
              db
                .select({ id: workflows.id })
                .from(workflows)
                .where(installedWorkflowCondition(args, expected.workflowId)),
            ),
          ),
        )
        .returning({
          ...columns,
          observedUpdatedAt: columns.observedUpdatedAt.as("observedUpdatedAt"),
          observedXmin: columns.observedXmin.as("observedXmin"),
        }),
    );
    const identity = db.$with("paused_official_identity").as(
      db
        .insert(officialWorkflowAutomationIdentities)
        .select(
          sql`
          SELECT ${paused.id}, ${paused.workflowId}, ${paused.id},
            ${paused.officialBlueprintKey}, 'active', NULL, NULL, NULL,
            ${sql.param(currentTime, officialWorkflowAutomationIdentities.createdAt)},
            ${sql.param(currentTime, officialWorkflowAutomationIdentities.updatedAt)}
          FROM ${paused}
        `,
        )
        .onConflictDoUpdate({
          target: [
            officialWorkflowAutomationIdentities.workflowId,
            officialWorkflowAutomationIdentities.blueprintKey,
          ],
          set: {
            automationId: sql`excluded.${sql.identifier(officialWorkflowAutomationIdentities.automationId.name)}`,
            state: "active",
            retainedParameterBindings: null,
            retainedIntendedEnabled: null,
            retainedAppliedFingerprint: null,
            updatedAt: currentTime,
          },
        })
        .returning({
          automationId: officialWorkflowAutomationIdentities.automationId,
        }),
    );
    const [current] = await db
      .with(paused, identity)
      .select()
      .from(paused)
      .where(
        exists(
          db.select({ automationId: identity.automationId }).from(identity),
        ),
      );
    signal.throwIfAborted();
    // The exact target observation rejects intervening writes, including account
    // projections that leave updatedAt unchanged. Keep its full runtime snapshot.
    return current ? { previous: expected, current } : null;
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
      withMorningBriefCronBinding({
        definitionName: args.definitionName,
        blueprint: args.blueprint,
        owner: { orgId: args.orgId, userId: args.member.userId },
        bindings: args.automation.officialParameterBindings ?? [],
      }),
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

function structureTransitionBaselineCondition(expected: OfficialAutomationRow) {
  const current = alias(workflowAutomations, "stage_locked_automation");
  if (expected.atTime !== null && !Number.isFinite(expected.atTime.getTime())) {
    return sql`false`;
  }
  return and(
    eq(current.id, expected.id),
    eq(current.workflowId, expected.workflowId),
    eq(current.kind, expected.kind),
    sql`${current.eventType} IS NOT DISTINCT FROM ${expected.eventType}`,
    sql`COALESCE(${current.eventConfig}, 'null'::jsonb) = ${JSON.stringify(expected.eventConfig)}::jsonb`,
    sql`${current.scheduleType} IS NOT DISTINCT FROM ${expected.scheduleType}`,
    sql`${current.cronExpression} IS NOT DISTINCT FROM ${expected.cronExpression}`,
    sql`${current.intervalSeconds} IS NOT DISTINCT FROM ${expected.intervalSeconds}`,
    expected.atTime === null
      ? isNull(current.atTime)
      : eq(
          sql`date_trunc('milliseconds', ${current.atTime})`,
          sql`${timestampWithoutTimeZone(expected.atTime)}::timestamp`,
        ),
    eq(current.timezone, expected.timezone),
    eq(current.autonomyBudget, expected.autonomyBudget),
    sql`${current.officialBlueprintKey} IS NOT DISTINCT FROM ${expected.officialBlueprintKey}`,
    sql`${current.officialAppliedFingerprint} IS NOT DISTINCT FROM ${expected.officialAppliedFingerprint}`,
    sql`${current.officialReconciliationStatus} IS NOT DISTINCT FROM ${expected.officialReconciliationStatus}`,
    sql`COALESCE(${current.officialParameterBindings}, 'null'::jsonb) = ${JSON.stringify(expected.officialParameterBindings)}::jsonb`,
  );
}

function structureTransitionOwnership(
  args: ExistingAutomationReconciliationArgs,
  releaseId: string,
  acceptedDefinition: OfficialWorkflowAcceptedDefinition,
) {
  const builder = new QueryBuilder();
  const catalogFence = builder.$with("stage_catalog_fence").as(
    builder
      .select({ authority: officialWorkflowCatalogState.authority })
      .from(officialWorkflowCatalogState)
      .where(
        and(
          eq(
            officialWorkflowCatalogState.authority,
            OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
          ),
          eq(officialWorkflowCatalogState.acceptedReleaseId, releaseId),
        ),
      )
      .for("share"),
  );
  const revisionPlan =
    acceptedOfficialWorkflowRevisionReadPlan(acceptedDefinition);
  const installed = builder.$with("stage_installed_workflow").as(
    builder
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          installedWorkflowCondition(
            {
              orgId: args.orgId,
              userId: args.member.userId,
              definitionName: args.definitionName,
            },
            args.automation.workflowId,
          ),
          exists(builder.select().from(catalogFence)),
          exists(
            builder
              .select(revisionPlan.columns)
              .from(officialWorkflowDefinitionRevisions)
              .innerJoin(storages, revisionPlan.storageJoin)
              .innerJoin(storageVersions, revisionPlan.storageVersionJoin)
              .where(revisionPlan.condition),
          ),
        ),
      )
      .for("update")
      .limit(1),
  );
  const columns = workflowAutomationColumns();
  const selectedColumns = {
    ...columns,
    observedUpdatedAt: columns.observedUpdatedAt.as("observedUpdatedAt"),
    observedXmin: columns.observedXmin.as("observedXmin"),
  };
  // Retain the existing catalog -> installation -> automation lock order.
  // The locked tuple supplies both the baseline and the compensation receipt.
  const locked = builder.$with("stage_locked_automation").as(
    builder
      .select(selectedColumns)
      .from(workflowAutomations)
      .where(
        and(
          reconfigurationSourceCondition(args.automation),
          exists(builder.select().from(installed)),
        ),
      )
      .for("update")
      .limit(1),
  );
  const owned = builder
    .$with("stage_owned_automation")
    .as(
      builder
        .select()
        .from(locked)
        .where(structureTransitionBaselineCondition(args.automation)),
    );
  return { catalogFence, installed, locked, owned };
}

const stageAutomationStructureTransition$ = command(
  async (
    { set },
    args: ExistingAutomationReconciliationArgs,
    signal: AbortSignal,
  ): Promise<PersistedReconfiguration | null> => {
    const db = set(writeDb$);
    // Parse immutable publication payloads before mutation. A replacement of the
    // accepted pointer makes the final statement decline this prepared revision.
    const [catalogRow] = parseRawRows(
      acceptedCatalogRowSchema,
      await db.execute(acceptedCatalogReadStatement()),
    );
    signal.throwIfAborted();
    const catalogIdentity = blueprintAuthorityIdentity(args);
    const catalog = acceptedCatalogFromRow(catalogRow);
    const acceptedDefinition = matchingAcceptedBlueprintDefinition(
      catalog,
      catalogIdentity,
    );
    if (!catalog || !acceptedDefinition) {
      return null;
    }
    const [revisionRow] = parseRawRows(
      acceptedRevisionRowSchema,
      await db.execute(acceptedRevisionReadStatement(acceptedDefinition)),
    );
    signal.throwIfAborted();
    if (!acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)) {
      return null;
    }

    const { catalogFence, installed, locked, owned } =
      structureTransitionOwnership(args, catalog.releaseId, acceptedDefinition);
    const columns = workflowAutomationColumns();
    const selectedColumns = {
      ...columns,
      observedUpdatedAt: columns.observedUpdatedAt.as("observedUpdatedAt"),
      observedXmin: columns.observedXmin.as("observedXmin"),
    };
    const staged = db.$with("stage_updated_automation").as(
      db
        .update(workflowAutomations)
        .set({
          enabled: false,
          nextRunAt: null,
          officialReconciliationStatus: "reconciling",
          updatedAt: nowDateSql(),
        })
        .from(owned)
        .where(
          and(
            eq(workflowAutomations.id, owned.id),
            isNotNull(owned.officialBlueprintKey),
            ne(owned.officialBlueprintKey, ""),
          ),
        )
        .returning(selectedColumns),
    );
    const identities = officialWorkflowAutomationIdentities;
    const identity = db.$with("stage_updated_identity").as(
      db
        .insert(identities)
        .select(
          db
            .select({
              id: staged.id,
              workflowId: staged.workflowId,
              automationId: staged.id,
              blueprintKey: staged.officialBlueprintKey,
              state: sql`'active'`.mapWith(identities.state).as("state"),
              retainedParameterBindings: sql`NULL`
                .mapWith(pgNullDecoder)
                .as("retained_parameter_bindings"),
              retainedIntendedEnabled: sql`NULL`
                .mapWith(pgNullDecoder)
                .as("retained_intended_enabled"),
              retainedAppliedFingerprint: sql`NULL`
                .mapWith(pgNullDecoder)
                .as("retained_applied_fingerprint"),
              createdAt: staged.updatedAt,
              updatedAt: staged.updatedAt,
            })
            .from(staged),
        )
        .onConflictDoUpdate({
          target: [identities.workflowId, identities.blueprintKey],
          set: {
            automationId: sql`excluded.automation_id`,
            state: "active",
            retainedParameterBindings: null,
            retainedIntendedEnabled: null,
            retainedAppliedFingerprint: null,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .returning({ automationId: identities.automationId }),
    );
    const [row] = await db
      .with(catalogFence, installed, locked, owned, staged, identity)
      .select({
        previous: automationMaterializationColumns("stage_owned_automation"),
        current: automationMaterializationColumns("stage_updated_automation"),
        identityId: identity.automationId,
      })
      .from(owned)
      .leftJoin(staged, eq(staged.id, owned.id))
      .leftJoin(identity, eq(identity.automationId, staged.id));
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const previous = row.previous;
    const current = row.current;
    if (!previous.officialBlueprintKey) {
      throw new Error("Official Workflow automation identity is incomplete");
    }
    if (!current || !row.identityId) {
      throw new Error("Official Workflow automation disappeared");
    }
    return { previous, current };
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

function structureTransitionCursorGate(current: OfficialAutomationRow) {
  if (
    !current.enabled ||
    current.eventType !== "google-forms-response-submitted"
  ) {
    return sql`true`;
  }
  const config = googleFormsResponseSubmittedEventConfigSchema.parse(
    current.eventConfig,
  );
  const builder = new QueryBuilder();
  return exists(
    builder
      .select({ id: googleFormsWatchStates.id })
      .from(googleFormsWatchStates)
      .where(
        and(
          eq(googleFormsWatchStates.orgId, current.orgId),
          eq(googleFormsWatchStates.userId, current.ownerUserId),
          eq(googleFormsWatchStates.connectorId, config.connectorId),
          eq(googleFormsWatchStates.formId, config.form.id),
        ),
      ),
  );
}

function structureFinalizationCatalog(releaseId: string) {
  const builder = new QueryBuilder();
  return builder.$with("structure_catalog_fence").as(
    builder
      .select({ authority: officialWorkflowCatalogState.authority })
      .from(officialWorkflowCatalogState)
      .where(
        and(
          eq(
            officialWorkflowCatalogState.authority,
            OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
          ),
          eq(officialWorkflowCatalogState.acceptedReleaseId, releaseId),
        ),
      )
      .for("share"),
  );
}

function structureFinalizationTier(
  orgId: string,
  webhook: boolean,
  catalog: ReturnType<typeof structureFinalizationCatalog>,
) {
  const builder = new QueryBuilder();
  return builder.$with("structure_webhook_tier").as(
    builder
      .select({
        entitlementExists: sql`structure_tier."entitlementExists"`
          .mapWith(pgBooleanDecoder)
          .as("entitlementExists"),
        orgExists: sql`structure_tier."orgExists"`
          .mapWith(pgBooleanDecoder)
          .as("orgExists"),
        restrictedBuiltInModels: sql`structure_tier."restrictedBuiltInModels"`
          .mapWith(nullableDriverValueDecoder(pgBooleanDecoder))
          .as("restrictedBuiltInModels"),
        allowed: sql`structure_tier.allowed`
          .mapWith(nullableDriverValueDecoder(pgBooleanDecoder))
          .as("allowed"),
      })
      .from(
        sql`(SELECT * FROM (${
          webhook
            ? webhookTierLockStatement(orgId)
            : sql`SELECT true AS "entitlementExists", false AS "orgExists", false AS "restrictedBuiltInModels", true AS allowed`
        }) AS structure_tier LIMIT (SELECT CASE WHEN ${count()} > 0 THEN 1 ELSE 0 END FROM ${catalog})) AS structure_tier`,
      ),
  );
}

function structureFinalizationOwnership(
  args: FinalizeAutomationStructureTransitionArgs,
  releaseId: string,
  desired: OfficialAutomationRow,
  accountPlan: ReturnType<typeof officialAccountProjectionReadPlan>,
) {
  const builder = new QueryBuilder();
  const catalog = structureFinalizationCatalog(releaseId);
  const tier = structureFinalizationTier(
    args.orgId,
    desired.eventType === "webhook-received",
    catalog,
  );
  const installation = builder.$with("structure_installed_workflow").as(
    builder
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          installedWorkflowCondition(args, desired.workflowId),
          exists(builder.select().from(tier)),
        ),
      )
      .for("update")
      .limit(1),
  );
  const locked = builder.$with("structure_locked_automation").as(
    builder
      .select({ id: workflowAutomations.id })
      .from(workflowAutomations)
      .where(
        and(
          observedWorkflowAutomationCondition(args.persisted.current),
          exists(builder.select().from(installation)),
        ),
      )
      .for("update")
      .limit(1),
  );
  const identity = builder.$with("structure_owned_identity").as(
    builder
      .select({ id: officialWorkflowAutomationIdentities.id })
      .from(officialWorkflowAutomationIdentities)
      .where(
        and(
          activeIdentityOwnershipCondition(args.persisted.current),
          exists(builder.select().from(locked)),
        ),
      )
      .for("update")
      .limit(1),
  );
  const accountMatches = accountPlan.required
    ? sql`(SELECT projection_selection."connectorId" FROM ${accountPlan.source}) IS NOT DISTINCT FROM ${args.patch.eventConnectorId}::uuid`
    : sql`true`;
  const webhookPresent = exists(
    builder
      .select({ id: workflowWebhookAutomations.automationId })
      .from(workflowWebhookAutomations)
      .where(eq(workflowWebhookAutomations.automationId, desired.id)),
  );
  const cursorPresent = structureTransitionCursorGate(desired);
  const ready = builder.$with("structure_ready").as(
    builder
      .select({ id: identity.id })
      .from(identity)
      .where(
        and(
          accountMatches,
          exists(
            builder
              .select()
              .from(tier)
              .where(
                and(
                  eq(tier.entitlementExists, true),
                  isNotNull(tier.restrictedBuiltInModels),
                  eq(tier.allowed, true),
                ),
              ),
          ),
          cursorPresent,
          desired.eventType === "webhook-received" &&
            !args.preparation?.webhookCredentials
            ? webhookPresent
            : undefined,
        ),
      ),
  );
  return {
    catalog,
    tier,
    installation,
    locked,
    identity,
    ready,
    accountMatches,
    webhookPresent,
    cursorPresent,
    owners: [catalog, tier, installation, locked, identity, ready] as const,
  };
}

function structureTransitionWebhookStatement(
  desired: OfficialAutomationRow,
  credentials: OfficialAutomationEventPreparation["webhookCredentials"],
  currentTime: Date,
) {
  const gate = sql`EXISTS (SELECT 1 FROM structure_ready)`;
  const condition = eq(workflowWebhookAutomations.automationId, desired.id);
  const timestamp = timestampWithoutTimeZone(currentTime);
  if (desired.eventType !== "webhook-received") {
    return sql`DELETE FROM ${workflowWebhookAutomations} WHERE ${condition} AND ${gate} RETURNING automation_id`;
  }
  if (!credentials) {
    return sql`UPDATE ${workflowWebhookAutomations} SET disabled_reason = NULL,
      updated_at = ${timestamp}::timestamp WHERE ${condition} AND ${gate} RETURNING automation_id`;
  }
  return sql`INSERT INTO ${workflowWebhookAutomations}
    (automation_id, token_hash, encrypted_token, encrypted_secret, secret_last_four, created_at, updated_at)
    SELECT ${desired.id}::uuid, ${credentials.tokenHash}, ${credentials.encryptedToken},
      ${credentials.encryptedSecret}, ${credentials.secretLastFour}, ${timestamp}::timestamp, ${timestamp}::timestamp
    WHERE ${gate}
    ON CONFLICT (automation_id) DO UPDATE SET disabled_reason = NULL, updated_at = excluded.updated_at
    RETURNING automation_id`;
}

function structureTransitionResult(
  row:
    | {
        readonly owned: boolean;
        readonly accountMatches: boolean;
        readonly cursorPresent: boolean;
        readonly webhookPresent: boolean;
        readonly published: boolean;
        readonly entitlementExists: boolean | null;
        readonly orgExists: boolean | null;
        readonly restrictedBuiltInModels: boolean | null;
        readonly allowed: boolean | null;
      }
    | undefined,
  args: FinalizeAutomationStructureTransitionArgs,
): FinalizeAutomationStructureTransitionResult {
  if (!row) {
    throw new Error("Official Workflow automation disappeared");
  }
  if (!row.owned || !row.accountMatches) {
    return { kind: "superseded" };
  }
  if (args.patch.eventType === "webhook-received") {
    const eligible = webhookTierFromRows(
      webhookTierRowSchema.array().parse([row]),
      args.orgId,
    );
    if (!eligible) {
      return {
        kind: "failed",
        message: "Webhook automations require a Team or Custom workspace",
      };
    }
    if (!row.webhookPresent && !args.preparation?.webhookCredentials) {
      throw new Error("Missing prepared Official webhook credentials");
    }
  }
  if (!row.cursorPresent) {
    throw new Error(
      "Google Forms structure watch disappeared before publication",
    );
  }
  if (!row.published) {
    throw new Error("Official Workflow automation disappeared");
  }
  return { kind: "current" };
}

function structureFinalizationPublicationPlan(
  args: FinalizeAutomationStructureTransitionArgs,
  currentTime: Date,
  p: ReturnType<typeof structureFinalizationOwnership>,
) {
  const source = args.persisted.current;
  const desired = structureTransitionWatchAutomation(source, args.patch);
  const builder = new QueryBuilder();
  const updated = sql`structure_updated`;
  const published = sql`structure_updated_installation`;
  const subtype = new WithSubquery(
    structureTransitionWebhookStatement(
      desired,
      args.preparation?.webhookCredentials,
      currentTime,
    ),
    {},
    "structure_webhook",
    true,
  );
  return {
    subtype,
    subtypeCompleted:
      desired.eventType === "webhook-received"
        ? eq(builder.select({ count: count() }).from(sql`structure_webhook`), 1)
        : gte(
            builder.select({ count: count() }).from(sql`structure_webhook`),
            0,
          ),
    cursorStatement: googleFormsCursorPublicationStatement(
      desired,
      args.preparation?.googleFormsSeedCursor ?? null,
      currentTime,
      {
        gate: exists(builder.select().from(updated)),
        reset: googleFormsCursorMustReset(source, desired),
      },
    ),
    deleteCursor: and(
      eq(googleFormsAutomationCursors.automationId, source.id),
      exists(builder.select().from(updated)),
      googleFormsCursorMustReset(source, desired) ? sql`true` : sql`false`,
    ),
    identityValues: {
      automationId: desired.id,
      state: "active" as const,
      retainedParameterBindings: null,
      retainedIntendedEnabled: null,
      retainedAppliedFingerprint: null,
      updatedAt: currentTime,
    },
    selection: {
      owned: exists(builder.select().from(p.identity)).mapWith(
        pgBooleanDecoder,
      ),
      accountMatches: p.accountMatches.mapWith(pgBooleanDecoder),
      cursorPresent: p.cursorPresent.mapWith(pgBooleanDecoder),
      webhookPresent: p.webhookPresent.mapWith(pgBooleanDecoder),
      published: exists(builder.select().from(published)).mapWith(
        pgBooleanDecoder,
      ),
      entitlementExists:
        sql`(SELECT "entitlementExists" FROM ${p.tier})`.mapWith(
          nullableDriverValueDecoder(pgBooleanDecoder),
        ),
      orgExists: sql`(SELECT "orgExists" FROM ${p.tier})`.mapWith(
        nullableDriverValueDecoder(pgBooleanDecoder),
      ),
      restrictedBuiltInModels:
        sql`(SELECT "restrictedBuiltInModels" FROM ${p.tier})`.mapWith(
          nullableDriverValueDecoder(pgBooleanDecoder),
        ),
      allowed: sql`(SELECT allowed FROM ${p.tier})`.mapWith(
        nullableDriverValueDecoder(pgBooleanDecoder),
      ),
    },
  };
}

const finalizeAutomationStructureTransition$ = command(
  async (
    { set },
    args: FinalizeAutomationStructureTransitionArgs,
    signal: AbortSignal,
  ): Promise<FinalizeAutomationStructureTransitionResult> => {
    const db = set(writeDb$);
    const { source, authority, accountPlan } =
      structureTransitionReadPlan(args);
    const catalogRows = parseRawRows(
      acceptedCatalogRowSchema,
      await db.execute(acceptedCatalogReadStatement()),
    );
    signal.throwIfAborted();
    const acceptedDefinition = acceptedBlueprintDefinitionFromRows(
      catalogRows,
      authority,
    );
    const releaseId = catalogRows[0]?.releaseId;
    if (!acceptedDefinition || !releaseId) {
      return { kind: "superseded" };
    }
    const revisionRows = parseRawRows(
      acceptedRevisionRowSchema,
      await db.execute(acceptedRevisionReadStatement(acceptedDefinition)),
    );
    signal.throwIfAborted();
    if (
      !acceptedRevisionBlueprintRowsMatch(revisionRows, authority) ||
      !structureTransitionSourceIsCurrent(source, source)
    ) {
      return { kind: "superseded" };
    }
    const accountRows = accountPlan.required
      ? await db.select(accountPlan.columns).from(accountPlan.source)
      : [];
    signal.throwIfAborted();
    if (
      !accountProjectionMatchesPatch(
        officialAccountProjectionFromRow(accountPlan, accountRows[0]),
        args.patch,
      )
    ) {
      return { kind: "superseded" };
    }
    const currentTime = nowDate();
    const values = finalizedStructurePatch(source, args.patch, currentTime);
    const desired = structureTransitionWatchAutomation(source, args.patch);
    const p = structureFinalizationOwnership(
      args,
      releaseId,
      desired,
      accountPlan,
    );
    const publication = structureFinalizationPublicationPlan(
      args,
      currentTime,
      p,
    );
    const updated = db.$with("structure_updated").as(
      db
        .update(workflowAutomations)
        .set(values)
        .from(p.ready)
        .where(
          and(
            eq(workflowAutomations.id, p.ready.id),
            publication.subtypeCompleted,
          ),
        )
        .returning({ id: workflowAutomations.id }),
    );
    const cursor =
      publication.cursorStatement === null
        ? db.$with("structure_cursor").as(
            db
              .delete(googleFormsAutomationCursors)
              .where(publication.deleteCursor)
              .returning({
                automationId: googleFormsAutomationCursors.automationId,
              }),
          )
        : new WithSubquery(
            publication.cursorStatement,
            {},
            "structure_cursor",
            true,
          );
    const identities = officialWorkflowAutomationIdentities;
    const identity = db.$with("structure_updated_identity").as(
      db
        .update(identities)
        .set(publication.identityValues)
        .from(updated)
        .where(
          and(
            eq(identities.id, updated.id),
            gte(db.select({ count: count() }).from(sql`structure_cursor`), 0),
          ),
        )
        .returning({ id: identities.id }),
    );
    const installation = db
      .$with("structure_updated_installation")
      .as(
        db
          .update(workflows)
          .set({ updatedBy: args.userId, updatedAt: currentTime })
          .from(identity)
          .where(eq(workflows.id, source.workflowId))
          .returning({ id: workflows.id }),
      );
    signal.throwIfAborted();
    const [row] = await db
      .with(
        ...p.owners,
        publication.subtype,
        updated,
        cursor,
        identity,
        installation,
      )
      .select(publication.selection)
      .from(sql`(SELECT 1) AS structure_result`);
    signal.throwIfAborted();
    return structureTransitionResult(row, args);
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

    const [catalogRow] = parseRawRows(
      acceptedCatalogRowSchema,
      await db.execute(acceptedCatalogReadStatement()),
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
      await db.execute(acceptedRevisionReadStatement(acceptedDefinition)),
    );
    signal.throwIfAborted();
    if (!acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)) {
      return false;
    }

    const expectedCondition =
      args.expected === undefined
        ? undefined
        : failedAutomationBaselineCondition(args.expected);
    const currentTime = nowDate();
    const columns = workflowAutomationColumns();
    const failed = db.$with("failed_official_automation").as(
      db
        .update(workflowAutomations)
        .set({
          officialReconciliationStatus: "failed",
          updatedAt: currentTime,
        })
        .where(
          and(
            eq(workflowAutomations.id, args.automationId),
            eq(workflowAutomations.workflowId, args.workflowId),
            eq(workflowAutomations.officialBlueprintKey, args.blueprint.key),
            eq(
              workflowAutomations.officialAppliedFingerprint,
              args.blueprint.fingerprint,
            ),
            expectedCondition,
            exists(
              db
                .select({ id: workflows.id })
                .from(workflows)
                .where(installedWorkflowCondition(args, args.workflowId)),
            ),
          ),
        )
        .returning({
          ...columns,
          observedUpdatedAt: columns.observedUpdatedAt.as("observedUpdatedAt"),
          observedXmin: columns.observedXmin.as("observedXmin"),
        }),
    );
    const identity = officialWorkflowAutomationIdentities;
    const published = await db
      .with(failed)
      .insert(identity)
      .select(
        db
          .select({
            id: failed.id,
            workflowId: failed.workflowId,
            automationId: failed.id,
            blueprintKey: sql`${failed.officialBlueprintKey}`
              .mapWith(identity.blueprintKey)
              .as("blueprint_key"),
            state: sql`'active'`.mapWith(identity.state).as("state"),
            retainedParameterBindings: sql`NULL`
              .mapWith(identity.retainedParameterBindings)
              .as("retained_parameter_bindings"),
            retainedIntendedEnabled: sql`NULL`
              .mapWith(identity.retainedIntendedEnabled)
              .as("retained_intended_enabled"),
            retainedAppliedFingerprint: sql`NULL`
              .mapWith(identity.retainedAppliedFingerprint)
              .as("retained_applied_fingerprint"),
            createdAt:
              sql`${sql.param(currentTime, identity.createdAt)}::timestamp`
                .mapWith(identity.createdAt)
                .as("created_at"),
            updatedAt:
              sql`${sql.param(currentTime, identity.updatedAt)}::timestamp`
                .mapWith(identity.updatedAt)
                .as("updated_at"),
          })
          .from(failed),
      )
      .onConflictDoUpdate({
        target: [identity.workflowId, identity.blueprintKey],
        set: {
          automationId: sql`excluded.automation_id`,
          state: "active",
          retainedParameterBindings: null,
          retainedIntendedEnabled: null,
          retainedAppliedFingerprint: null,
          updatedAt: currentTime,
        },
      })
      .returning({ id: identity.id });
    // The dependent identity write commits with the actual failed target.
    signal.throwIfAborted();
    return published.length > 0;
  },
);

interface DormantIdentityReservation {
  readonly kind: "reserved";
  readonly id: string;
  readonly intendedEnabled: boolean;
}

interface DormantReservationArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly definitionName: string;
  readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  readonly activeDefinitionOnly: boolean;
  readonly bindings: readonly OfficialWorkflowParameterBinding[];
  readonly fallbackIntendedEnabled: boolean;
}

function dormantReservationOwnership(
  args: DormantReservationArgs,
  releaseId: string,
) {
  const builder = new QueryBuilder();
  const catalog = builder.$with("reserve_catalog_fence").as(
    builder
      .select({ authority: officialWorkflowCatalogState.authority })
      .from(officialWorkflowCatalogState)
      .where(
        and(
          eq(officialWorkflowCatalogState.authority, "official"),
          eq(officialWorkflowCatalogState.acceptedReleaseId, releaseId),
        ),
      )
      .for("share"),
  );
  const installed = builder.$with("reserve_installed_workflow").as(
    builder
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          installedWorkflowCondition(args, args.workflowId),
          exists(builder.select().from(catalog)),
        ),
      )
      .for("update")
      .limit(1),
  );
  const active = builder.$with("reserve_keyed_automation").as(
    builder
      .select({ id: workflowAutomations.id })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.workflowId, args.workflowId),
          eq(workflowAutomations.officialBlueprintKey, args.blueprint.key),
          exists(builder.select().from(installed)),
        ),
      )
      .for("update")
      .limit(1),
  );
  const identities = officialWorkflowAutomationIdentities;
  const locked = builder.$with("reserve_locked_identity").as(
    builder
      .select({ id: identities.id })
      .from(identities)
      .where(
        and(
          eq(identities.workflowId, args.workflowId),
          eq(identities.blueprintKey, args.blueprint.key),
          exists(builder.select().from(installed)),
          gte(builder.select({ count: count() }).from(active), 0),
        ),
      )
      .for("update")
      .limit(1),
  );
  // The volatile clock depends on the existing lock chain. A lock wait must
  // not consume the new lease before this statement can publish it.
  const clock = builder.$with("reserve_lease_clock").as(
    builder
      .select({
        workflowId: installed.id,
        currentTime: nowDateSql().mapWith(identities.updatedAt).as("at"),
      })
      .from(installed)
      .where(gte(builder.select({ count: count() }).from(locked), 0)),
  );
  return { catalog, installed, active, locked, clock };
}

function dormantReservationProjection(
  args: DormantReservationArgs,
  ownership: ReturnType<typeof dormantReservationOwnership>,
) {
  const identity = officialWorkflowAutomationIdentities;
  return {
    id: sql`gen_random_uuid()`.mapWith(identity.id).as("id"),
    workflowId: ownership.clock.workflowId,
    automationId: sql`NULL::uuid`.mapWith(pgNullDecoder).as("automation_id"),
    blueprintKey: sql`${args.blueprint.key}::varchar`
      .mapWith(identity.blueprintKey)
      .as("blueprint_key"),
    state: sql`'reconciling'`.mapWith(identity.state).as("state"),
    retainedParameterBindings:
      sql`${sql.param([...args.bindings], identity.retainedParameterBindings)}::jsonb`
        .mapWith(identity.retainedParameterBindings)
        .as("retained_parameter_bindings"),
    retainedIntendedEnabled: sql`${args.fallbackIntendedEnabled}::boolean`
      .mapWith(identity.retainedIntendedEnabled)
      .as("retained_intended_enabled"),
    retainedAppliedFingerprint: sql`${args.blueprint.fingerprint}::varchar`
      .mapWith(identity.retainedAppliedFingerprint)
      .as("retained_applied_fingerprint"),
    createdAt: ownership.clock.currentTime,
    updatedAt: ownership.clock.currentTime,
  };
}

const reserveDormantIdentity$ = command(
  async (
    { set },
    args: DormantReservationArgs,
    signal: AbortSignal,
  ): Promise<DormantIdentityReservation | null> => {
    const db = set(writeDb$);

    const [catalogRow] = parseRawRows(
      acceptedCatalogRowSchema,
      await db.execute(acceptedCatalogReadStatement()),
    );
    signal.throwIfAborted();
    const catalog = acceptedCatalogFromRow(catalogRow);
    const authority = blueprintAuthorityIdentity(args);
    const definition = matchingAcceptedBlueprintDefinition(catalog, authority);
    if (!catalog || !definition) {
      return null;
    }
    const [revisionRow] = parseRawRows(
      acceptedRevisionRowSchema,
      await db.execute(acceptedRevisionReadStatement(definition)),
    );
    signal.throwIfAborted();
    if (!acceptedRevisionBlueprintMatches(revisionRow, authority)) {
      return null;
    }

    const identity = officialWorkflowAutomationIdentities;
    const ownership = dormantReservationOwnership(args, catalog.releaseId);
    const { catalog: fence, installed, active, locked, clock } = ownership;
    const [reserved] = await db
      .with(fence, installed, active, locked, clock)
      .insert(identity)
      .select(
        db
          .select(dormantReservationProjection(args, ownership))
          .from(clock)
          .where(notExists(db.select().from(active))),
      )
      .onConflictDoUpdate({
        target: [identity.workflowId, identity.blueprintKey],
        set: {
          automationId: null,
          state: "reconciling",
          retainedParameterBindings: sql`excluded.retained_parameter_bindings`,
          retainedIntendedEnabled: sql`COALESCE(${identity.retainedIntendedEnabled}, excluded.retained_intended_enabled)`,
          retainedAppliedFingerprint: sql`excluded.retained_applied_fingerprint`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: and(
          exists(db.select().from(locked).where(eq(locked.id, identity.id))),
          isNull(identity.automationId),
          ne(identity.state, "active"),
          or(
            ne(identity.state, "reconciling"),
            gte(
              sql`excluded.updated_at - date_trunc('milliseconds', ${identity.updatedAt})`,
              sql`${DORMANT_CREATION_LEASE_MS} * interval '1 millisecond'`,
            ),
          ),
        ),
      })
      .returning({
        id: identity.id,
        intendedEnabled: sql`${identity.retainedIntendedEnabled}`.mapWith(
          pgBooleanDecoder,
        ),
      });
    // Active/busy/changed ownership all reach the caller's existing retry.
    // Cancellation after autocommit skips the response, not the committed lease.
    signal.throwIfAborted();
    return reserved
      ? {
          kind: "reserved",
          id: reserved.id,
          intendedEnabled: reserved.intendedEnabled,
        }
      : null;
  },
);

interface DormantIdentityRetentionArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly definitionName: string;
  readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  readonly activeDefinitionOnly: boolean;
  readonly bindings: readonly OfficialWorkflowParameterBinding[];
  readonly state: "needs_reconfiguration" | "failed";
  readonly fallbackIntendedEnabled: boolean;
}

function dormantRetentionProjection(
  args: DormantIdentityRetentionArgs,
  currentTime: Date,
) {
  const identity = officialWorkflowAutomationIdentities;
  return {
    id: sql`gen_random_uuid()`.mapWith(identity.id).as("id"),
    workflowId: workflows.id,
    automationId: sql`NULL::uuid`.mapWith(pgNullDecoder).as("automation_id"),
    blueprintKey:
      sql`${sql.param(args.blueprint.key, identity.blueprintKey)}::varchar`
        .mapWith(identity.blueprintKey)
        .as("blueprint_key"),
    state: sql`${sql.param(args.state, identity.state)}::varchar`
      .mapWith(identity.state)
      .as("state"),
    retainedParameterBindings:
      sql`${sql.param([...args.bindings], identity.retainedParameterBindings)}::jsonb`
        .mapWith(identity.retainedParameterBindings)
        .as("retained_parameter_bindings"),
    retainedIntendedEnabled:
      sql`${sql.param(args.fallbackIntendedEnabled, identity.retainedIntendedEnabled)}::boolean`
        .mapWith(identity.retainedIntendedEnabled)
        .as("retained_intended_enabled"),
    retainedAppliedFingerprint: sql`NULL::varchar`
      .mapWith(pgNullDecoder)
      .as("retained_applied_fingerprint"),
    createdAt: sql`${sql.param(currentTime, identity.createdAt)}::timestamp`
      .mapWith(identity.createdAt)
      .as("created_at"),
    updatedAt: sql`${sql.param(currentTime, identity.updatedAt)}::timestamp`
      .mapWith(identity.updatedAt)
      .as("updated_at"),
  };
}

const retainDormantIdentity$ = command(
  async (
    { get, set },
    args: DormantIdentityRetentionArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const readDb = get(db$);
    const catalogPlan = acceptedOfficialWorkflowCatalogReadPlan();
    const [catalogRow] = acceptedCatalogRowSchema
      .array()
      .parse(
        await readDb
          .select(catalogPlan.columns)
          .from(officialWorkflowCatalogState)
          .innerJoin(officialWorkflowCatalogReleases, catalogPlan.join)
          .where(catalogPlan.condition)
          .limit(1),
      );
    signal.throwIfAborted();
    const authority = blueprintAuthorityIdentity(args);
    const catalog = acceptedCatalogFromRow(catalogRow);
    const definition = matchingAcceptedBlueprintDefinition(catalog, authority);
    if (!catalog || !definition) {
      return false;
    }
    const revisionPlan = acceptedOfficialWorkflowRevisionReadPlan({
      name: definition.name,
      revision: definition.revision,
    });
    const [revisionRow] = acceptedRevisionRowSchema
      .array()
      .parse(
        await readDb
          .select(revisionPlan.columns)
          .from(officialWorkflowDefinitionRevisions)
          .innerJoin(storages, revisionPlan.storageJoin)
          .innerJoin(storageVersions, revisionPlan.storageVersionJoin)
          .where(revisionPlan.condition)
          .limit(1),
      );
    signal.throwIfAborted();
    if (
      !acceptedRevisionBlueprintMatches(revisionRow, authority) ||
      !revisionRow
    ) {
      return false;
    }

    const db = set(writeDb$);
    const identity = officialWorkflowAutomationIdentities;
    const currentTime = nowDate();
    const keyedAutomation = db
      .select({ id: workflowAutomations.id })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.workflowId, args.workflowId),
          eq(workflowAutomations.officialBlueprintKey, args.blueprint.key),
        ),
      );
    const catalogAuthority = db
      .select({ authority: officialWorkflowCatalogState.authority })
      .from(officialWorkflowCatalogState)
      .where(
        and(
          eq(officialWorkflowCatalogState.authority, "official"),
          eq(officialWorkflowCatalogState.acceptedReleaseId, catalog.releaseId),
        ),
      );
    const revisionAuthority = db
      .select({ revision: officialWorkflowDefinitionRevisions.revision })
      .from(officialWorkflowDefinitionRevisions)
      .innerJoin(storages, revisionPlan.storageJoin)
      .innerJoin(storageVersions, revisionPlan.storageVersionJoin)
      .where(
        and(
          revisionPlan.condition,
          eq(
            officialWorkflowDefinitionRevisions.storageName,
            revisionRow.storageName,
          ),
          eq(
            officialWorkflowDefinitionRevisions.storageId,
            revisionRow.storageId,
          ),
          eq(
            officialWorkflowDefinitionRevisions.storageVersion,
            revisionRow.storageVersion,
          ),
        ),
      );
    const [retained] = await db
      .insert(identity)
      .select(
        db
          .select(dormantRetentionProjection(args, currentTime))
          .from(workflows)
          .where(
            and(
              installedWorkflowCondition(args, args.workflowId),
              exists(catalogAuthority),
              exists(revisionAuthority),
              notExists(keyedAutomation),
            ),
          ),
      )
      .onConflictDoUpdate({
        target: [identity.workflowId, identity.blueprintKey],
        set: {
          automationId: null,
          state: sql`excluded.state`,
          retainedParameterBindings: sql`excluded.retained_parameter_bindings`,
          retainedIntendedEnabled: sql`COALESCE(${identity.retainedIntendedEnabled}, excluded.retained_intended_enabled)`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: and(
          ne(identity.state, "active"),
          isNull(identity.automationId),
          notExists(keyedAutomation),
        ),
      })
      .returning({ id: identity.id });
    // Cancellation after autocommit skips this response, not the persisted retention.
    signal.throwIfAborted();
    return retained !== undefined;
  },
);
interface ReservedCreationOrphanArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly definitionName: string;
  readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  readonly activeDefinitionOnly: boolean;
  readonly reservationId: string;
}

function reservedCreationIdentityCondition(args: ReservedCreationOrphanArgs) {
  return and(
    eq(officialWorkflowAutomationIdentities.id, args.reservationId),
    eq(officialWorkflowAutomationIdentities.workflowId, args.workflowId),
    eq(officialWorkflowAutomationIdentities.blueprintKey, args.blueprint.key),
    eq(officialWorkflowAutomationIdentities.state, "reconciling"),
    isNull(officialWorkflowAutomationIdentities.automationId),
    eq(
      officialWorkflowAutomationIdentities.retainedAppliedFingerprint,
      args.blueprint.fingerprint,
    ),
  );
}

function reservedCreationOrphanCondition(args: ReservedCreationOrphanArgs) {
  return and(
    eq(workflowAutomations.id, args.reservationId),
    eq(workflowAutomations.orgId, args.orgId),
    eq(workflowAutomations.ownerUserId, args.userId),
    eq(workflowAutomations.workflowId, args.workflowId),
    eq(workflowAutomations.enabled, false),
    isNull(workflowAutomations.officialBlueprintKey),
    isNull(workflowAutomations.officialAppliedFingerprint),
    isNull(workflowAutomations.officialReconciliationStatus),
    isNull(workflowAutomations.officialParameterBindings),
    isNull(workflowAutomations.officialIntendedEnabled),
  );
}

function admittedCreationRevisionCondition(
  revision: Pick<
    typeof officialWorkflowDefinitionRevisions.$inferSelect,
    "storageName" | "storageId" | "storageVersion"
  >,
) {
  return and(
    eq(officialWorkflowDefinitionRevisions.storageName, revision.storageName),
    eq(officialWorkflowDefinitionRevisions.storageId, revision.storageId),
    eq(
      officialWorkflowDefinitionRevisions.storageVersion,
      revision.storageVersion,
    ),
  );
}

const deleteReservedCreationOrphan$ = command(
  async (
    { get, set },
    args: ReservedCreationOrphanArgs,
    signal: AbortSignal,
  ) => {
    const readDb = get(db$);
    const catalogPlan = acceptedOfficialWorkflowCatalogReadPlan();
    const [catalogRow] = acceptedCatalogRowSchema
      .array()
      .parse(
        await readDb
          .select(catalogPlan.columns)
          .from(officialWorkflowCatalogState)
          .innerJoin(officialWorkflowCatalogReleases, catalogPlan.join)
          .where(catalogPlan.condition)
          .limit(1),
      );
    signal.throwIfAborted();
    const catalog = acceptedCatalogFromRow(catalogRow);
    const catalogIdentity = blueprintAuthorityIdentity(args);
    const acceptedDefinition = matchingAcceptedBlueprintDefinition(
      catalog,
      catalogIdentity,
    );
    if (!catalog || !acceptedDefinition) {
      return { kind: "blocked" as const };
    }
    const revisionPlan =
      acceptedOfficialWorkflowRevisionReadPlan(acceptedDefinition);
    const [revisionRow] = acceptedRevisionRowSchema
      .array()
      .parse(
        await readDb
          .select(revisionPlan.columns)
          .from(officialWorkflowDefinitionRevisions)
          .innerJoin(storages, revisionPlan.storageJoin)
          .innerJoin(storageVersions, revisionPlan.storageVersionJoin)
          .where(revisionPlan.condition)
          .limit(1),
      );
    signal.throwIfAborted();
    if (
      !revisionRow ||
      !acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)
    ) {
      return { kind: "blocked" as const };
    }

    const db = set(writeDb$);
    const catalogAuthority = exists(
      db
        .select({ releaseId: officialWorkflowCatalogState.acceptedReleaseId })
        .from(officialWorkflowCatalogState)
        .innerJoin(officialWorkflowCatalogReleases, catalogPlan.join)
        .where(
          and(
            catalogPlan.condition,
            eq(
              officialWorkflowCatalogState.acceptedReleaseId,
              catalog.releaseId,
            ),
          ),
        ),
    );
    const revisionAuthority = exists(
      db
        .select({ revision: officialWorkflowDefinitionRevisions.revision })
        .from(officialWorkflowDefinitionRevisions)
        .innerJoin(storages, revisionPlan.storageJoin)
        .innerJoin(storageVersions, revisionPlan.storageVersionJoin)
        .where(
          and(
            revisionPlan.condition,
            admittedCreationRevisionCondition(revisionRow),
          ),
        ),
    );
    const identityAuthority = exists(
      db
        .select({ id: officialWorkflowAutomationIdentities.id })
        .from(officialWorkflowAutomationIdentities)
        .where(reservedCreationIdentityCondition(args)),
    );
    const installedAuthority = exists(
      db
        .select({ id: workflows.id })
        .from(workflows)
        .where(installedWorkflowCondition(args, args.workflowId)),
    );
    const [automation] = await db
      .delete(workflowAutomations)
      .where(
        and(
          reservedCreationOrphanCondition(args),
          catalogAuthority,
          revisionAuthority,
          identityAuthority,
          installedAuthority,
        ),
      )
      .returning(workflowAutomationColumns());
    signal.throwIfAborted();
    if (automation) {
      return { kind: "deleted" as const, automation };
    }

    // This is a new observation after an empty DELETE, not its old snapshot.
    const [admission] = await readDb
      .select({ automationId: workflowAutomations.id })
      .from(workflows)
      .leftJoin(
        workflowAutomations,
        eq(workflowAutomations.id, args.reservationId),
      )
      .where(
        and(
          installedWorkflowCondition(args, args.workflowId),
          catalogAuthority,
          revisionAuthority,
          identityAuthority,
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return admission && admission.automationId === null
      ? { kind: "none" as const }
      : { kind: "blocked" as const };
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
    !isDeepStrictEqual(automation.officialParameterBindings, args.bindings)
  ) {
    return null;
  }
  return { automation, identity };
}

const validateDormantMaterialization$ = command(
  async (
    { get },
    args: DormantMaterializationOwnershipArgs,
    signal: AbortSignal,
  ): Promise<OfficialAutomationRow | null> => {
    const db = get(db$);
    const catalogPlan = acceptedOfficialWorkflowCatalogReadPlan();
    // One committed statement observation, without waiting for publisher/row locks.
    // Neither this read nor the former transaction reserves later enable/finalize.
    const [row] = await db
      .select({
        catalog: catalogPlan.columns,
        revision: {
          definitionName: officialWorkflowDefinitionRevisions.definitionName,
          revision: officialWorkflowDefinitionRevisions.revision,
          payload: officialWorkflowDefinitionRevisions.payload,
          storageName: officialWorkflowDefinitionRevisions.storageName,
          storageId: officialWorkflowDefinitionRevisions.storageId,
          storageVersion: officialWorkflowDefinitionRevisions.storageVersion,
        },
        registeredStorageId: storages.id,
        registeredStorageVersion: storageVersions.id,
        installation: { id: workflows.id },
        automation: workflowAutomationColumns(),
        identity: getTableColumns(officialWorkflowAutomationIdentities),
      })
      .from(officialWorkflowCatalogState)
      .innerJoin(officialWorkflowCatalogReleases, catalogPlan.join)
      .leftJoin(
        officialWorkflowDefinitionRevisions,
        and(
          eq(
            officialWorkflowDefinitionRevisions.definitionName,
            args.definitionName,
          ),
          eq(
            officialWorkflowDefinitionRevisions.revision,
            acceptedCatalogDefinitionRevision(args.definitionName),
          ),
        ),
      )
      .leftJoin(
        storages,
        and(
          eq(storages.id, officialWorkflowDefinitionRevisions.storageId),
          eq(storages.name, officialWorkflowDefinitionRevisions.storageName),
          eq(storages.orgId, SYSTEM_ORG_ID),
          eq(storages.userId, VOLUME_ORG_USER_ID),
        ),
      )
      .leftJoin(
        storageVersions,
        and(
          eq(
            storageVersions.id,
            officialWorkflowDefinitionRevisions.storageVersion,
          ),
          eq(
            storageVersions.storageId,
            officialWorkflowDefinitionRevisions.storageId,
          ),
        ),
      )
      .leftJoin(workflows, installedWorkflowCondition(args, args.workflowId))
      .leftJoin(
        workflowAutomations,
        eq(workflowAutomations.id, args.automationId),
      )
      .leftJoin(
        officialWorkflowAutomationIdentities,
        and(
          eq(officialWorkflowAutomationIdentities.id, args.automationId),
          eq(officialWorkflowAutomationIdentities.workflowId, args.workflowId),
          eq(
            officialWorkflowAutomationIdentities.blueprintKey,
            args.blueprintKey,
          ),
        ),
      )
      .where(catalogPlan.condition)
      .limit(1);
    signal.throwIfAborted();
    const catalogIdentity = {
      definitionName: args.definitionName,
      blueprintKey: args.blueprintKey,
      fingerprint: args.fingerprint,
      activeDefinitionOnly: args.activeDefinitionOnly,
    };
    const acceptedDefinition = matchingAcceptedBlueprintDefinition(
      acceptedCatalogFromRow(row?.catalog),
      catalogIdentity,
    );
    if (!acceptedDefinition || !row) {
      return null;
    }
    // Missing artifact registration has the same absence outcome as the old inner joins.
    if (
      !acceptedRevisionBlueprintMatches(
        row.registeredStorageId !== null &&
          row.registeredStorageVersion !== null
          ? (row.revision ?? undefined)
          : undefined,
        catalogIdentity,
      )
    ) {
      return null;
    }
    if (!row.installation) {
      return null;
    }
    const rows = dormantMaterializationRows(
      row.automation ?? undefined,
      row.identity ?? undefined,
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
  },
);

function finalizationMaterializationCondition(
  args: DormantMaterializationOwnershipArgs,
) {
  const automation = alias(workflowAutomations, "finalize_automation");
  const identity = alias(
    officialWorkflowAutomationIdentities,
    "finalize_identity",
  );
  // JSONB normalizes -0 to 0; strict JavaScript comparison did not.
  const bindingsComparable = !args.bindings.some((binding) => {
    return Object.is(binding.value, -0);
  });
  return and(
    isNull(identity.automationId),
    eq(identity.state, "reconciling"),
    eq(identity.retainedAppliedFingerprint, args.fingerprint),
    eq(identity.retainedIntendedEnabled, args.intendedEnabled),
    eq(identity.retainedParameterBindings, [...args.bindings]),
    eq(automation.orgId, args.orgId),
    eq(automation.ownerUserId, args.userId),
    eq(automation.workflowId, args.workflowId),
    eq(automation.officialBlueprintKey, args.blueprintKey),
    eq(automation.officialAppliedFingerprint, args.fingerprint),
    eq(automation.officialReconciliationStatus, "reconciling"),
    eq(automation.officialIntendedEnabled, args.intendedEnabled),
    eq(automation.officialParameterBindings, [...args.bindings]),
    eq(automation.enabled, args.intendedEnabled),
    sql`${bindingsComparable}`,
  );
}

function dormantMaterializationFinalizationStatement(
  args: DormantMaterializationOwnershipArgs,
  releaseId: string,
  definition: OfficialWorkflowAcceptedDefinition,
  currentTime: Date,
) {
  const catalogCondition = and(
    eq(
      officialWorkflowCatalogState.authority,
      OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
    ),
    eq(officialWorkflowCatalogState.acceptedReleaseId, releaseId),
  );
  const identityCondition = and(
    eq(officialWorkflowAutomationIdentities.id, args.automationId),
    eq(officialWorkflowAutomationIdentities.workflowId, args.workflowId),
    eq(officialWorkflowAutomationIdentities.blueprintKey, args.blueprintKey),
  );
  const automation = alias(workflowAutomations, "finalize_automation");
  const identity = alias(
    officialWorkflowAutomationIdentities,
    "finalize_identity",
  );
  const currentTimestamp = timestampWithoutTimeZone(currentTime);
  // MATERIALIZED owners retain the existing catalog -> workflow -> automation
  // -> identity lock order, including the current tuples returned after waits.
  // Every mutation consumes its predecessor's actual RETURNING rows.
  return sql`WITH finalize_catalog_fence AS MATERIALIZED (
      SELECT ${officialWorkflowCatalogState.authority} FROM ${officialWorkflowCatalogState}
      WHERE ${catalogCondition} FOR SHARE
    ), finalize_registered_revision AS MATERIALIZED (
      ${acceptedRevisionReadStatement(definition)}
    ), finalize_installed_workflow AS MATERIALIZED (
      SELECT ${workflows.id} FROM ${workflows}
      WHERE ${installedWorkflowCondition(args, args.workflowId)}
        AND ${exists(sql`(SELECT 1 FROM finalize_catalog_fence)`)}
        AND ${exists(sql`(SELECT 1 FROM finalize_registered_revision)`)}
      LIMIT 1 FOR UPDATE
    ), finalize_locked_automation AS MATERIALIZED (
      SELECT ${workflowAutomations}.* FROM ${workflowAutomations}
      WHERE ${eq(workflowAutomations.id, args.automationId)}
        AND ${exists(sql`(SELECT 1 FROM finalize_installed_workflow)`)}
      LIMIT 1 FOR UPDATE
    ), finalize_locked_identity AS MATERIALIZED (
      SELECT ${officialWorkflowAutomationIdentities}.* FROM ${officialWorkflowAutomationIdentities}
      WHERE ${identityCondition}
        AND ${exists(sql`(SELECT 1 FROM finalize_installed_workflow)`)}
      LIMIT (SELECT CASE WHEN ${count()} >= 0 THEN 1 ELSE 0 END FROM finalize_locked_automation)
      FOR UPDATE
    ), finalize_owned_materialization AS MATERIALIZED (
      SELECT ${automation.id} AS id,
        isfinite(${automation.updatedAt})
          AND ${automation.updatedAt} = date_trunc('milliseconds', ${automation.updatedAt}) AS exact_timestamp
      FROM finalize_locked_automation AS finalize_automation
      INNER JOIN finalize_locked_identity AS finalize_identity ON ${eq(identity.id, automation.id)}
      WHERE ${finalizationMaterializationCondition(args)}
    ), finalized_automation AS (
      UPDATE ${workflowAutomations} SET official_reconciliation_status = 'current',
        updated_at = ${currentTimestamp}::timestamp
      FROM finalize_owned_materialization AS owned
      WHERE ${eq(workflowAutomations.id, sql`owned.id`)} AND owned.exact_timestamp
      RETURNING ${workflowAutomations.id}
    ), finalized_identity AS (
      UPDATE ${officialWorkflowAutomationIdentities} SET automation_id = finalized_automation.id,
        state = 'active', retained_parameter_bindings = NULL,
        retained_intended_enabled = NULL, retained_applied_fingerprint = NULL,
        updated_at = ${currentTimestamp}::timestamp
      FROM finalized_automation
      WHERE ${eq(officialWorkflowAutomationIdentities.id, sql`finalized_automation.id`)}
      RETURNING ${officialWorkflowAutomationIdentities.id}
    ), finalized_installation AS (
      UPDATE ${workflows} SET updated_by = ${args.userId}, updated_at = ${currentTimestamp}::timestamp
      WHERE ${eq(workflows.id, args.workflowId)}
        AND ${exists(sql`(SELECT 1 FROM finalized_identity)`)}
      RETURNING ${workflows.id}
    ) SELECT owned.exact_timestamp AS "exactTimestamp", finalized_installation.id AS "workflowId"
      FROM finalize_owned_materialization AS owned
      LEFT JOIN finalized_installation ON ${eq(sql`finalized_installation.id`, args.workflowId)}`;
}

const finalizeDormantMaterialization$ = command(
  async (
    { set },
    args: DormantMaterializationOwnershipArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    // Parse complete immutable payloads before publication. The locked pointer
    // rejects a catalog replacement after this read without finalizing anything.
    const [catalogRow] = parseRawRows(
      acceptedCatalogRowSchema,
      await db.execute(acceptedCatalogReadStatement()),
    );
    signal.throwIfAborted();
    const catalog = acceptedCatalogFromRow(catalogRow);
    const catalogIdentity = {
      definitionName: args.definitionName,
      blueprintKey: args.blueprintKey,
      fingerprint: args.fingerprint,
      activeDefinitionOnly: args.activeDefinitionOnly,
    };
    const acceptedDefinition = matchingAcceptedBlueprintDefinition(
      catalog,
      catalogIdentity,
    );
    if (!catalog || !acceptedDefinition) {
      return false;
    }
    const [revisionRow] = parseRawRows(
      acceptedRevisionRowSchema,
      await db.execute(acceptedRevisionReadStatement(acceptedDefinition)),
    );
    signal.throwIfAborted();
    if (!acceptedRevisionBlueprintMatches(revisionRow, catalogIdentity)) {
      return false;
    }
    // One audit-clock sample precedes the statement's lock waits.
    const query = dormantMaterializationFinalizationStatement(
      args,
      catalog.releaseId,
      acceptedDefinition,
      nowDate(),
    );
    const [result] = parseRawRows(
      object({
        exactTimestamp: boolean(),
        workflowId: uuid().nullable(),
      }),
      await db.execute(query),
    );
    signal.throwIfAborted();
    if (!result) {
      return false;
    }
    if (!result.exactTimestamp || !result.workflowId) {
      // The original Date-encoded automation CAS rejected submillisecond
      // timestamps. That rejection gates every write before this error.
      throw new Error(
        "Official Workflow materialization finalization lost ownership",
      );
    }
    return true;
  },
);
/** Schema columns decode both committed tuples; the CTE retains xmin as text. */
function automationMaterializationColumns(name: string) {
  const automation = alias(workflowAutomations, name);
  return {
    ...getTableColumns(automation),
    observedUpdatedAt: sql`${automation.updatedAt}::text`.mapWith(
      pgTextDecoder,
    ),
    observedXmin: sql`${automation}.${sql.identifier("observedXmin")}`.mapWith(
      pgTextDecoder,
    ),
  };
}

function discardedMaterializationCondition(
  args: DormantMaterializationOwnershipArgs,
) {
  const lockedAutomation = alias(
    workflowAutomations,
    "discard_locked_automation",
  );
  const lockedIdentity = alias(
    officialWorkflowAutomationIdentities,
    "discard_locked_identity",
  );
  // JSONB cannot retain negative zero, whereas isDeepStrictEqual rejects it.
  const bindingsComparable = !args.bindings.some((binding) => {
    return Object.is(binding.value, -0);
  });
  return and(
    isNull(lockedIdentity.automationId),
    eq(lockedIdentity.retainedAppliedFingerprint, args.fingerprint),
    eq(lockedIdentity.retainedIntendedEnabled, args.intendedEnabled),
    eq(lockedIdentity.retainedParameterBindings, [...args.bindings]),
    eq(lockedAutomation.orgId, args.orgId),
    eq(lockedAutomation.ownerUserId, args.userId),
    eq(lockedAutomation.workflowId, args.workflowId),
    eq(lockedAutomation.officialBlueprintKey, args.blueprintKey),
    eq(lockedAutomation.officialAppliedFingerprint, args.fingerprint),
    eq(lockedAutomation.officialIntendedEnabled, args.intendedEnabled),
    eq(lockedAutomation.officialParameterBindings, [...args.bindings]),
    eq(lockedAutomation.officialReconciliationStatus, lockedIdentity.state),
    inArray(lockedIdentity.state, ["reconciling", "failed"]),
    sql`${bindingsComparable}`,
  );
}

const persistDiscardedMaterialization$ = command(
  async (
    { set },
    args: DormantMaterializationOwnershipArgs,
    _signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const columns = workflowAutomationColumns();
    const identities = officialWorkflowAutomationIdentities;
    const catalog = db
      .$with("discard_catalog_fence")
      .as(
        db
          .select({ authority: officialWorkflowCatalogState.authority })
          .from(officialWorkflowCatalogState)
          .where(
            eq(
              officialWorkflowCatalogState.authority,
              OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
            ),
          )
          .for("share"),
      );
    // Retain the existing catalog -> automation -> identity lock order. The
    // locked tuples, including a row changed while waiting, own both writes.
    const lockedAutomation = db.$with("discard_locked_automation").as(
      db
        .select({
          ...columns,
          observedUpdatedAt: columns.observedUpdatedAt.as("observedUpdatedAt"),
          observedXmin: columns.observedXmin.as("observedXmin"),
        })
        .from(workflowAutomations)
        .where(
          and(
            eq(workflowAutomations.id, args.automationId),
            gte(db.select({ count: count() }).from(catalog), 0),
          ),
        )
        .for("update")
        .limit(1),
    );
    const lockedIdentity = db.$with("discard_locked_identity").as(
      db
        .select()
        .from(identities)
        .where(
          and(
            eq(identities.id, args.automationId),
            eq(identities.workflowId, args.workflowId),
            eq(identities.blueprintKey, args.blueprintKey),
            gte(db.select({ count: count() }).from(lockedAutomation), 0),
          ),
        )
        .for("update")
        .limit(1),
    );
    const owned = db.$with("discard_owned_materialization").as(
      db
        .select({
          id: lockedAutomation.id,
          identityUpdatedAt: lockedIdentity.updatedAt,
        })
        .from(lockedAutomation)
        .innerJoin(lockedIdentity, eq(lockedIdentity.id, lockedAutomation.id))
        .where(discardedMaterializationCondition(args)),
    );
    // Both persisted rows receive the same application-clock sample. It is
    // prepared before this statement instead of after its lock wait.
    const currentTime = nowDate();
    const failedAutomation = db.$with("discard_failed_automation").as(
      db
        .update(workflowAutomations)
        .set({
          enabled: false,
          nextRunAt: null,
          officialReconciliationStatus: "failed",
          updatedAt: currentTime,
        })
        .from(owned)
        .where(
          and(
            eq(workflowAutomations.id, owned.id),
            // The former Date-encoded identity CAS rejected submillisecond
            // timestamps. Reject before either write, preserving its rollback.
            eq(
              owned.identityUpdatedAt,
              sql`date_trunc('milliseconds', ${owned.identityUpdatedAt})`,
            ),
          ),
        )
        .returning({
          ...columns,
          observedUpdatedAt: columns.observedUpdatedAt.as("observedUpdatedAt"),
          observedXmin: columns.observedXmin.as("observedXmin"),
        }),
    );
    const failedIdentity = db
      .$with("discard_failed_identity")
      .as(
        db
          .update(identities)
          .set({ state: "failed", updatedAt: currentTime })
          .from(failedAutomation)
          .where(eq(identities.id, failedAutomation.id))
          .returning({ id: identities.id }),
      );
    const [row] = await db
      .with(
        catalog,
        lockedAutomation,
        lockedIdentity,
        owned,
        failedAutomation,
        failedIdentity,
      )
      .select({
        previous: automationMaterializationColumns("discard_locked_automation"),
        current: automationMaterializationColumns("discard_failed_automation"),
        identityId: failedIdentity.id,
      })
      .from(owned)
      .innerJoin(lockedAutomation, eq(lockedAutomation.id, owned.id))
      .leftJoin(failedAutomation, eq(failedAutomation.id, owned.id))
      .leftJoin(failedIdentity, eq(failedIdentity.id, owned.id));
    if (!row) {
      return null;
    }
    if (!row.current || !row.identityId) {
      throw new Error(
        "Official Workflow materialization discard lost identity",
      );
    }
    return { previous: row.previous, current: row.current };
  },
);
function discardedMaterializationDeleteStatement(
  args: DormantMaterializationOwnershipArgs,
  updatedAt: Date,
) {
  const automation = alias(workflowAutomations, "discarded_automation");
  const identity = alias(
    officialWorkflowAutomationIdentities,
    "discarded_identity",
  );
  // JSON serialization loses negative zero; strict JavaScript comparison did
  // not match it to the zero read back from either persisted JSONB field.
  const bindingsComparable = !args.bindings.some((binding) => {
    return Object.is(binding.value, -0);
  });
  const ownedConditions = [
    isNull(identity.automationId),
    eq(identity.retainedAppliedFingerprint, args.fingerprint),
    eq(identity.retainedIntendedEnabled, args.intendedEnabled),
    eq(identity.retainedParameterBindings, [...args.bindings]),
    eq(automation.orgId, args.orgId),
    eq(automation.ownerUserId, args.userId),
    eq(automation.workflowId, args.workflowId),
    eq(automation.officialBlueprintKey, args.blueprintKey),
    eq(automation.officialAppliedFingerprint, args.fingerprint),
    eq(automation.officialIntendedEnabled, args.intendedEnabled),
    eq(automation.officialParameterBindings, [...args.bindings]),
    eq(automation.enabled, false),
    eq(automation.officialReconciliationStatus, "failed"),
    eq(
      sql`date_trunc('milliseconds', ${automation.updatedAt})`,
      sql`${timestampWithoutTimeZone(updatedAt)}::timestamp`,
    ),
    eq(identity.state, "failed"),
    sql`${bindingsComparable}`,
  ];
  const ownedFailedMaterialization = sql`(${sql.join(ownedConditions, sql` and `)})`;
  const identityScope = sql`(${eq(officialWorkflowAutomationIdentities.id, args.automationId)} and ${eq(officialWorkflowAutomationIdentities.workflowId, args.workflowId)} and ${eq(officialWorkflowAutomationIdentities.blueprintKey, args.blueprintKey)})`;
  // Each LIMIT consumes the preceding owner even when this selection is empty.
  // Retain the existing catalog -> automation -> identity locking order.
  return sql`WITH accepted_catalog_fence AS MATERIALIZED (
      ${acceptedCatalogLockStatement()}
    ), locked_discard_automation AS MATERIALIZED (
      SELECT ${workflowAutomations}.* FROM ${workflowAutomations}
      WHERE ${eq(workflowAutomations.id, args.automationId)}
      LIMIT (SELECT CASE WHEN ${count()} >= 0 THEN 1 ELSE 0 END FROM accepted_catalog_fence)
      FOR UPDATE
    ), locked_discard_identity AS MATERIALIZED (
      SELECT ${officialWorkflowAutomationIdentities}.* FROM ${officialWorkflowAutomationIdentities}
      WHERE ${identityScope}
      LIMIT (SELECT CASE WHEN ${count()} >= 0 THEN 1 ELSE 0 END FROM locked_discard_automation)
      FOR UPDATE
    ), discarded_materialization AS (
      DELETE FROM ${workflowAutomations}
      USING locked_discard_automation AS discarded_automation,
        locked_discard_identity AS discarded_identity
      WHERE ${eq(workflowAutomations.id, automation.id)}
        AND ${ownedFailedMaterialization}
      RETURNING ${workflowAutomations.id}
    ) SELECT EXISTS (SELECT 1 FROM discarded_materialization) AS deleted
      FROM (SELECT ${count()} AS owner_count FROM locked_discard_identity) consumed_identity
      WHERE owner_count >= 0`;
}

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
    const [result] = parseRawRows(
      object({ deleted: boolean() }),
      await db.execute(
        discardedMaterializationDeleteStatement(
          args,
          persisted.current.updatedAt,
        ),
      ),
    );
    if (!result) {
      throw new Error(
        "Official Workflow materialization discard returned no row",
      );
    }
    return result.deleted;
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
      withMorningBriefCronBinding({
        definitionName: args.definitionName,
        blueprint: args.blueprint,
        owner: { orgId: args.orgId, userId: args.member.userId },
        bindings: args.identity?.retainedParameterBindings ?? [],
      }),
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
    { get, set },
    args: RemoveAutomationConfigurationArgs,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly previous: OfficialAutomationRow;
        readonly current: OfficialAutomationRow;
      }
    | undefined
  > => {
    const readDb = get(db$);
    const plan = acceptedOfficialWorkflowCatalogReadPlan();
    const [catalogRow] = acceptedCatalogRowSchema
      .array()
      .parse(
        await readDb
          .select(plan.columns)
          .from(officialWorkflowCatalogState)
          .innerJoin(officialWorkflowCatalogReleases, plan.join)
          .where(plan.condition)
          .limit(1),
      );
    signal.throwIfAborted();
    const catalog = acceptedCatalogFromRow(catalogRow);
    if (
      !catalog ||
      !acceptedDefinitionOmitsBlueprint(
        catalog,
        args.definition.name,
        args.automation.officialBlueprintKey,
        args.activeDefinitionOnly,
      )
    ) {
      return undefined;
    }
    const previous = args.automation;
    if (!Number.isFinite(previous.updatedAt.getTime())) {
      return undefined;
    }

    const db = set(writeDb$);
    const currentTime = nowDate();
    // Catalog and installation authority are observed at the write snapshot.
    // The existing exact source snapshot owns this single-row transition.
    const [current] = await db
      .update(workflowAutomations)
      .set({
        enabled: false,
        nextRunAt: null,
        officialReconciliationStatus: "reconciling",
        updatedAt: currentTime,
      })
      .where(
        and(
          observedWorkflowAutomationCondition(previous),
          failedAutomationBaselineCondition(previous),
          exists(
            db
              .select({ id: workflows.id })
              .from(workflows)
              .where(
                installedWorkflowCondition(
                  {
                    orgId: args.orgId,
                    userId: args.userId,
                    definitionName: args.definition.name,
                  },
                  previous.workflowId,
                ),
              ),
          ),
          exists(
            db
              .select({
                releaseId: officialWorkflowCatalogState.acceptedReleaseId,
              })
              .from(officialWorkflowCatalogState)
              .innerJoin(officialWorkflowCatalogReleases, plan.join)
              .where(
                and(
                  plan.condition,
                  eq(
                    officialWorkflowCatalogState.acceptedReleaseId,
                    catalog.releaseId,
                  ),
                ),
              ),
          ),
        ),
      )
      .returning(workflowAutomationColumns());
    signal.throwIfAborted();
    return current ? { previous, current } : undefined;
  },
);

function removedAutomationCondition(
  current: Pick<OfficialAutomationRow, "id" | "updatedAt">,
) {
  return and(
    eq(workflowAutomations.id, current.id),
    eq(
      sql`date_trunc('milliseconds', ${workflowAutomations.updatedAt})`,
      sql`${sql.param(current.updatedAt, workflowAutomations.updatedAt)}::timestamp`,
    ),
    eq(workflowAutomations.officialReconciliationStatus, "reconciling"),
    isNotNull(workflowAutomations.officialBlueprintKey),
    ne(workflowAutomations.officialBlueprintKey, ""),
    isNotNull(workflowAutomations.officialParameterBindings),
    sql`${workflowAutomations.officialParameterBindings} <> 'null'::jsonb`,
    isNotNull(workflowAutomations.officialIntendedEnabled),
  );
}

const deleteRemovedAutomationConfiguration$ = command(
  async (
    { get, set },
    args: RemoveAutomationConfigurationArgs,
    paused: {
      readonly current: OfficialAutomationRow;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const readDb = get(db$);
    const plan = acceptedOfficialWorkflowCatalogReadPlan();
    const [catalogRow] = acceptedCatalogRowSchema
      .array()
      .parse(
        await readDb
          .select(plan.columns)
          .from(officialWorkflowCatalogState)
          .innerJoin(officialWorkflowCatalogReleases, plan.join)
          .where(plan.condition)
          .limit(1),
      );
    signal.throwIfAborted();
    const catalog = acceptedCatalogFromRow(catalogRow);
    if (
      !catalog ||
      !acceptedDefinitionOmitsBlueprint(
        catalog,
        args.definition.name,
        paused.current.officialBlueprintKey,
        args.activeDefinitionOnly,
      )
    ) {
      return false;
    }
    const current = paused.current;
    if (!Number.isFinite(current.updatedAt.getTime())) {
      return false;
    }

    const db = set(writeDb$);
    const currentTime = nowDate();
    const identities = officialWorkflowAutomationIdentities;
    // Authority is observed at the write snapshot. Only the actual DELETE
    // owns retention, including after an implicit wait on the target row.
    const removed = db.$with("removed_official_automation").as(
      db
        .delete(workflowAutomations)
        .where(
          and(
            removedAutomationCondition(current),
            exists(
              db
                .select({ id: workflows.id })
                .from(workflows)
                .where(
                  installedWorkflowCondition(
                    {
                      orgId: args.orgId,
                      userId: args.userId,
                      definitionName: args.definition.name,
                    },
                    current.workflowId,
                  ),
                ),
            ),
            exists(
              db
                .select({
                  releaseId: officialWorkflowCatalogState.acceptedReleaseId,
                })
                .from(officialWorkflowCatalogState)
                .innerJoin(officialWorkflowCatalogReleases, plan.join)
                .where(
                  and(
                    plan.condition,
                    eq(
                      officialWorkflowCatalogState.acceptedReleaseId,
                      catalog.releaseId,
                    ),
                  ),
                ),
            ),
          ),
        )
        .returning({
          id: workflowAutomations.id,
          workflowId: workflowAutomations.workflowId,
          blueprintKey: workflowAutomations.officialBlueprintKey,
          parameterBindings: workflowAutomations.officialParameterBindings,
          intendedEnabled: workflowAutomations.officialIntendedEnabled,
          appliedFingerprint: workflowAutomations.officialAppliedFingerprint,
        }),
    );
    // Keep DELETE and UPSERT in one statement: the active identity's SET NULL
    // FK action must see the coherent removed identity at end of query.
    const [identity] = await db
      .with(removed)
      .insert(identities)
      .select(
        db
          .select({
            id: removed.id,
            workflowId: removed.workflowId,
            automationId: sql`NULL`.mapWith(pgNullDecoder).as("automation_id"),
            blueprintKey: removed.blueprintKey,
            state: sql`'removed'`.mapWith(identities.state).as("state"),
            retainedParameterBindings: removed.parameterBindings,
            retainedIntendedEnabled: removed.intendedEnabled,
            retainedAppliedFingerprint: removed.appliedFingerprint,
            createdAt: sql`${sql.param(currentTime, identities.createdAt)}`
              .mapWith(identities.createdAt)
              .as("created_at"),
            updatedAt: sql`${sql.param(currentTime, identities.updatedAt)}`
              .mapWith(identities.updatedAt)
              .as("updated_at"),
          })
          .from(removed)
          .where(sql`true`),
      )
      .onConflictDoUpdate({
        target: [identities.workflowId, identities.blueprintKey],
        set: {
          automationId: null,
          state: "removed",
          retainedParameterBindings: sql`excluded.retained_parameter_bindings`,
          retainedIntendedEnabled: sql`excluded.retained_intended_enabled`,
          retainedAppliedFingerprint: sql`excluded.retained_applied_fingerprint`,
          updatedAt: currentTime,
        },
      })
      .returning({ id: identities.id });
    signal.throwIfAborted();
    return identity !== undefined;
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
      automation.officialIntendedEnabled === null
    ) {
      return {
        kind: "retry",
        workflowId: args.workflowId,
        message: "Official Workflow materialization state is incomplete",
      };
    }
    const cleanupOnly =
      automation.officialReconciliationStatus === "failed" ||
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
    if (
      automation.officialAppliedFingerprint !== blueprint.fingerprint ||
      automation.officialReconciliationStatus !== "current"
    ) {
      return null;
    }
    if (
      automation.officialIntendedEnabled &&
      !automation.enabled &&
      // Failure-threshold pauses belong to the timed recovery lane.
      automation.consecutiveFailures < 3
    ) {
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
    await set(
      synchronizeOfficialWorkflowThread$,
      {
        orgId: args.orgId,
        userId: args.member.userId,
        workflowId: args.workflowId,
      },
      signal,
    );
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
        userTimezone,
      },
      target,
      signal,
    );
  },
);
