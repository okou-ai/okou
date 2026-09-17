import { isDeepStrictEqual } from "node:util";

import type {
  OfficialWorkflowAcceptedBlueprint,
  OfficialWorkflowAcceptedDefinition,
  OfficialWorkflowParameterBinding,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  googleFormsResponseSubmittedEventConfigSchema,
  stripeInvoicePaidEventConfigSchema,
  type StripeInvoicePaidEventConfig,
} from "@okouai/api-contracts/contracts/workflows";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import {
  officialWorkflowAutomationIdentities,
  workflowAutomations,
  workflows,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { testOverride } from "../../lib/singleton";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import {
  ensureAutomationEventWatchReconfiguration,
  reconcileAutomationEventWatchInventoryForOwner,
  reconcileAutomationEventWatches,
  reconcileAutomationEventWatchReconfiguration,
} from "./automation-event-watch-lifecycle.service";
import { lockConnectorAccountTarget } from "./auth-state-lock.service";
import { notionConfigWithConnectorId } from "./notion-automation-account.service";
import { OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK } from "./official-workflow-constants";
import {
  readAcceptedOfficialWorkflowCatalog,
  readAcceptedOfficialWorkflowRevision,
} from "./official-workflow-catalog-read.service";
import type {
  OfficialWorkflowReconciliationArgs,
  OfficialWorkflowReconciliationResult,
} from "./official-workflow-reconciliation-dispatch.service";
import {
  buildOfficialAutomationPatch,
  loadOfficialWorkflowUserTimezone,
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
  syncOfficialAutomationSubtypeRows,
  type AutomationResult,
  type CreateAutomationInput,
  type OfficialAutomationEventPreparation,
  type OfficialAutomationEventPreparationResult,
} from "./workflow-automation.service";
import { lockWorkflowWebhookAutomationTierEligibleForOrg } from "./workflow-webhook-automation-entitlement.service";
import type { WorkflowMember } from "./workflow-data.service";
import { resolveWorkflowAutomationConnectorId } from "./workflow-automation-account.service";
import {
  workflowAutomationAccountConnectorSlug,
  type WorkflowAutomationAccountConnectorSlug,
} from "./workflow-automation-account-classification.service";
import { resolveStripeInvoicePaidAutomationBinding } from "./stripe-invoice-paid-workflow-automation.service";

const DORMANT_CREATION_LEASE_MS = 5 * 60 * 1000;

type StripeAutomationBinding = Pick<
  StripeInvoicePaidEventConfig,
  "connectorId" | "stripeAccountId" | "mode"
>;

type DormantMaterializationReservedHook = (args: {
  readonly definitionName: string;
  readonly workflowId: string;
  readonly automationId: string;
  readonly blueprintKey: string;
  readonly fingerprint: string;
}) => Promise<void>;

type AutomationStructureTransitionPreparedHook = (args: {
  readonly definitionName: string;
  readonly workflowId: string;
  readonly automationId: string;
  readonly blueprintKey: string;
  readonly fingerprint: string;
}) => Promise<void>;

const dormantMaterializationReservedHookForTest = testOverride<
  DormantMaterializationReservedHook | undefined
>(() => {
  return undefined;
});

const automationStructureTransitionPreparedHookForTest = testOverride<
  AutomationStructureTransitionPreparedHook | undefined
>(() => {
  return undefined;
});

export function setDormantMaterializationReservedHookForTest(
  hook: DormantMaterializationReservedHook,
): void {
  dormantMaterializationReservedHookForTest.set(hook);
}

export function clearDormantMaterializationReservedHookForTest(): void {
  dormantMaterializationReservedHookForTest.clear();
}

export function setAutomationStructureTransitionPreparedHookForTest(
  hook: AutomationStructureTransitionPreparedHook,
): void {
  automationStructureTransitionPreparedHookForTest.set(hook);
}

export function clearAutomationStructureTransitionPreparedHookForTest(): void {
  automationStructureTransitionPreparedHookForTest.clear();
}

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
  readonly googleFormsCursor: string | undefined;
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

async function lockOfficialAutomationAccountProjection(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
    readonly currentEventType: string | null;
    readonly nextEventType: string | null;
  },
  signal: AbortSignal,
): Promise<
  | { readonly kind: "not-required" }
  | {
      readonly kind: "locked";
      readonly connectorSlug: WorkflowAutomationAccountConnectorSlug | null;
      readonly eventConnectorId: string | null;
      readonly stripeBinding: StripeAutomationBinding | null;
    }
> {
  const currentConnectorSlug = workflowAutomationAccountConnectorSlug(
    args.currentEventType,
  );
  const nextConnectorSlug = workflowAutomationAccountConnectorSlug(
    args.nextEventType,
  );
  const connectorSlugs = [currentConnectorSlug, nextConnectorSlug]
    .filter((slug): slug is WorkflowAutomationAccountConnectorSlug => {
      return slug !== null;
    })
    .filter((slug, index, values) => {
      return values.indexOf(slug) === index;
    })
    .sort();
  if (connectorSlugs.length === 0) {
    return { kind: "not-required" };
  }
  for (const connectorSlug of connectorSlugs) {
    await lockConnectorAccountTarget(db, {
      orgId: args.orgId,
      userId: args.userId,
      target: { kind: "builtin", connectorSlug },
    });
  }
  const stripeReadiness =
    nextConnectorSlug === "stripe"
      ? await resolveStripeInvoicePaidAutomationBinding(
          {
            db,
            orgId: args.orgId,
            userId: args.userId,
            workflowId: args.workflowId,
          },
          signal,
        )
      : null;
  signal.throwIfAborted();
  const stripeBinding =
    stripeReadiness?.kind === "ok" ? stripeReadiness.binding : null;
  return {
    kind: "locked",
    connectorSlug: nextConnectorSlug,
    eventConnectorId:
      nextConnectorSlug === null
        ? null
        : stripeBinding
          ? stripeBinding.connectorId
          : await resolveWorkflowAutomationConnectorId(db, {
              orgId: args.orgId,
              userId: args.userId,
              workflowId: args.workflowId,
              connectorSlug: nextConnectorSlug,
            }),
    stripeBinding,
  };
}

function accountProjectionMatchesPatch(
  projection: Awaited<
    ReturnType<typeof lockOfficialAutomationAccountProjection>
  >,
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

async function acquireReconciliationLocks(
  db: Db,
  orgId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtext(${OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK}))`,
  );
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);
}

async function acceptedBlueprintIsCurrent(
  db: ReadonlyDb,
  args: {
    readonly definitionName: string;
    readonly blueprintKey: string;
    readonly fingerprint: string;
    readonly activeDefinitionOnly: boolean;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const catalog = await readAcceptedOfficialWorkflowCatalog(db, signal);
  const definition = catalog?.payload.definitions.find((candidate) => {
    return candidate.name === args.definitionName;
  });
  const blueprint = definition?.blueprints.find((candidate) => {
    return candidate.key === args.blueprintKey;
  });
  if (
    !definition ||
    (args.activeDefinitionOnly && definition.lifecycle !== "active") ||
    blueprint?.fingerprint !== args.fingerprint
  ) {
    return false;
  }
  const revision = await readAcceptedOfficialWorkflowRevision(
    db,
    { name: definition.name, revision: definition.revision },
    signal,
  );
  return (
    revision?.definition.blueprints.find((candidate) => {
      return candidate.key === args.blueprintKey;
    })?.fingerprint === args.fingerprint
  );
}

async function lockInstalledWorkflow(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
    readonly definitionName: string;
  },
): Promise<boolean> {
  const [workflow] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.id, args.workflowId),
        eq(workflows.orgId, args.orgId),
        eq(workflows.ownerUserId, args.userId),
        eq(workflows.officialDefinitionName, args.definitionName),
        eq(workflows.officialInstallationState, "installed"),
      ),
    )
    .for("update")
    .limit(1);
  return workflow !== undefined;
}

async function loadReconciliationContext(
  db: ReadonlyDb,
  args: ReconcileOfficialWorkflowInstallationArgs,
  signal: AbortSignal,
): Promise<ReconciliationContext | null> {
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
  const catalog = await readAcceptedOfficialWorkflowCatalog(db, signal);
  const definition = catalog?.payload.definitions.find((candidate) => {
    return candidate.name === workflow.definitionName;
  });
  if (!definition) {
    return null;
  }
  if (args.activeDefinitionOnly === true && definition.lifecycle !== "active") {
    return null;
  }
  const revision = await readAcceptedOfficialWorkflowRevision(
    db,
    { name: definition.name, revision: definition.revision },
    signal,
  );
  if (!revision) {
    throw new Error("Accepted Official Workflow revision is unavailable");
  }
  const [automations, identities] = await Promise.all([
    db
      .select()
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
}

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

async function upsertActiveIdentity(
  db: Db,
  automation: OfficialAutomationRow,
  currentTime: Date,
): Promise<void> {
  if (!automation.officialBlueprintKey) {
    throw new Error("Official Workflow automation identity is incomplete");
  }
  await db
    .insert(officialWorkflowAutomationIdentities)
    .values({
      id: automation.id,
      workflowId: automation.workflowId,
      automationId: automation.id,
      blueprintKey: automation.officialBlueprintKey,
      state: "active",
      retainedParameterBindings: null,
      retainedIntendedEnabled: null,
      retainedAppliedFingerprint: null,
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [
        officialWorkflowAutomationIdentities.workflowId,
        officialWorkflowAutomationIdentities.blueprintKey,
      ],
      set: {
        automationId: automation.id,
        state: "active",
        retainedParameterBindings: null,
        retainedIntendedEnabled: null,
        retainedAppliedFingerprint: null,
        updatedAt: currentTime,
      },
    });
}

async function lockActiveIdentityOwnership(
  db: Db,
  automation: OfficialAutomationRow,
): Promise<boolean> {
  if (!automation.officialBlueprintKey) {
    return false;
  }
  const [identity] = await db
    .select({ id: officialWorkflowAutomationIdentities.id })
    .from(officialWorkflowAutomationIdentities)
    .where(
      and(
        eq(officialWorkflowAutomationIdentities.id, automation.id),
        eq(
          officialWorkflowAutomationIdentities.workflowId,
          automation.workflowId,
        ),
        eq(officialWorkflowAutomationIdentities.automationId, automation.id),
        eq(
          officialWorkflowAutomationIdentities.blueprintKey,
          automation.officialBlueprintKey,
        ),
        eq(officialWorkflowAutomationIdentities.state, "active"),
      ),
    )
    .for("update")
    .limit(1);
  return identity !== undefined;
}

async function persistReconfigurationPatch(
  db: Db,
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
): Promise<PersistedReconfiguration | null> {
  return await db.transaction(async (tx) => {
    await acquireReconciliationLocks(tx, args.orgId);
    if (
      !(await acceptedBlueprintIsCurrent(
        tx,
        {
          definitionName: args.definitionName,
          blueprintKey: args.blueprint.key,
          fingerprint: args.blueprint.fingerprint,
          activeDefinitionOnly: args.activeDefinitionOnly,
        },
        signal,
      ))
    ) {
      return null;
    }
    const accountProjection = await lockOfficialAutomationAccountProjection(
      tx,
      {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.expected.workflowId,
        currentEventType: args.expected.eventType,
        nextEventType: args.patch.eventType,
      },
      signal,
    );
    if (
      !(await lockInstalledWorkflow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.expected.workflowId,
        definitionName: args.definitionName,
      }))
    ) {
      return null;
    }
    const [current] = await tx
      .select()
      .from(workflowAutomations)
      .where(eq(workflowAutomations.id, args.expected.id))
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
    const [formsCursor] = await tx
      .select({ cursor: googleFormsAutomationCursors.lastSeenSubmittedTime })
      .from(googleFormsAutomationCursors)
      .where(eq(googleFormsAutomationCursors.automationId, current.id))
      .limit(1);
    const currentTime = nowDate();
    const enabled = current.officialIntendedEnabled === true || current.enabled;
    const [updated] = await tx
      .update(workflowAutomations)
      .set(
        refreshOfficialAutomationPatch(
          current,
          { ...args.patch, enabled },
          currentTime,
        ),
      )
      .where(eq(workflowAutomations.id, current.id))
      .returning();
    if (!updated) {
      throw new Error("Official Workflow automation disappeared");
    }
    await upsertActiveIdentity(tx, updated, currentTime);
    return {
      previous: current,
      current: updated,
      googleFormsCursor: formsCursor?.cursor,
    };
  });
}

async function restoreFailedReconfiguration(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly definitionName: string;
    readonly persisted: PersistedReconfiguration;
  },
): Promise<void> {
  const cleanupSignal = new AbortController().signal;
  const restored = await db.transaction(async (tx) => {
    await acquireReconciliationLocks(tx, args.orgId);
    const accountProjection = await lockOfficialAutomationAccountProjection(
      tx,
      {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.persisted.previous.workflowId,
        currentEventType: args.persisted.current.eventType,
        nextEventType: args.persisted.previous.eventType,
      },
      cleanupSignal,
    );
    if (
      !(await lockInstalledWorkflow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.persisted.previous.workflowId,
        definitionName: args.definitionName,
      }))
    ) {
      return null;
    }
    const [current] = await tx
      .select()
      .from(workflowAutomations)
      .where(eq(workflowAutomations.id, args.persisted.previous.id))
      .for("update")
      .limit(1);
    if (
      !current ||
      current.updatedAt.getTime() !== args.persisted.current.updatedAt.getTime()
    ) {
      return null;
    }
    const restoredNotionConfig =
      accountProjection.kind === "locked" &&
      accountProjection.eventConnectorId !== null &&
      workflowAutomationAccountConnectorSlug(
        args.persisted.previous.eventType,
      ) === "notion"
        ? notionConfigWithConnectorId(
            args.persisted.previous.eventType,
            args.persisted.previous.eventConfig,
            accountProjection.eventConnectorId,
          )
        : null;
    const currentTime = nowDate();
    const restorePatch = officialAutomationRestorePatch(
      args.persisted.previous,
      args.persisted.previous.nextRunAt,
      currentTime,
    );
    const stripeBinding =
      accountProjection.kind === "locked"
        ? accountProjection.stripeBinding
        : null;
    const [row] = await tx
      .update(workflowAutomations)
      .set({
        ...restorePatch,
        ...(accountProjection.kind === "locked"
          ? {
              eventConnectorId: accountProjection.eventConnectorId,
              ...(restoredNotionConfig === null
                ? {}
                : { eventConfig: restoredNotionConfig }),
            }
          : {}),
        ...(stripeBinding
          ? {
              eventConfig: {
                ...stripeInvoicePaidEventConfigSchema.parse(
                  restorePatch.eventConfig,
                ),
                ...stripeBinding,
              },
            }
          : {}),
        enabled: args.persisted.previous.enabled,
        officialIntendedEnabled:
          args.persisted.previous.officialIntendedEnabled,
        officialReconciliationStatus: "failed",
      })
      .where(eq(workflowAutomations.id, current.id))
      .returning();
    if (!row) {
      return null;
    }
    await upsertActiveIdentity(tx, row, currentTime);
    return row;
  });
  if (!restored) {
    return;
  }
  await reconcileAutomationEventWatchReconfiguration(
    db,
    {
      previous: [args.persisted.current],
      current: [restored],
      googleForms:
        args.persisted.googleFormsCursor === undefined
          ? []
          : [
              {
                automationId: restored.id,
                seedCursor: args.persisted.googleFormsCursor,
              },
            ],
    },
    cleanupSignal,
  );
}

async function finalizeReconfiguration(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly definitionName: string;
    readonly blueprint: OfficialWorkflowAcceptedBlueprint;
    readonly activeDefinitionOnly: boolean;
    readonly persisted: PersistedReconfiguration;
  },
  signal: AbortSignal,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    await acquireReconciliationLocks(tx, args.orgId);
    if (
      !(await acceptedBlueprintIsCurrent(
        tx,
        {
          definitionName: args.definitionName,
          blueprintKey: args.blueprint.key,
          fingerprint: args.blueprint.fingerprint,
          activeDefinitionOnly: args.activeDefinitionOnly,
        },
        signal,
      )) ||
      !(await lockInstalledWorkflow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.persisted.current.workflowId,
        definitionName: args.definitionName,
      }))
    ) {
      return false;
    }
    const [current] = await tx
      .select()
      .from(workflowAutomations)
      .where(eq(workflowAutomations.id, args.persisted.current.id))
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
      .returning();
    if (!finalized) {
      return false;
    }
    await upsertActiveIdentity(tx, finalized, currentTime);
    await tx
      .update(workflows)
      .set({ updatedBy: args.userId, updatedAt: currentTime })
      .where(eq(workflows.id, finalized.workflowId));
    return true;
  });
}

async function pauseForReconfiguration(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly definitionName: string;
    readonly blueprint: OfficialWorkflowAcceptedBlueprint;
    readonly activeDefinitionOnly: boolean;
    readonly automation: OfficialAutomationRow;
    readonly bindings: readonly OfficialWorkflowParameterBinding[];
  },
  signal: AbortSignal,
): Promise<OfficialWorkflowReconciliationResult> {
  const persisted = await db.transaction(async (tx) => {
    await acquireReconciliationLocks(tx, args.orgId);
    if (
      !(await acceptedBlueprintIsCurrent(
        tx,
        {
          definitionName: args.definitionName,
          blueprintKey: args.blueprint.key,
          fingerprint: args.blueprint.fingerprint,
          activeDefinitionOnly: args.activeDefinitionOnly,
        },
        signal,
      )) ||
      !(await lockInstalledWorkflow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.automation.workflowId,
        definitionName: args.definitionName,
      }))
    ) {
      return null;
    }
    const [current] = await tx
      .select()
      .from(workflowAutomations)
      .where(eq(workflowAutomations.id, args.automation.id))
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
      .returning();
    if (!paused) {
      return null;
    }
    await upsertActiveIdentity(tx, paused, currentTime);
    return { previous: current, current: paused };
  });
  if (!persisted) {
    return {
      kind: "retry",
      workflowId: args.automation.workflowId,
      message: "Official Workflow reconciliation was superseded",
    };
  }
  const lifecycle = await settle(
    reconcileAutomationEventWatchReconfiguration(
      db,
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
    await restoreFailedReconfiguration(db, {
      orgId: args.orgId,
      userId: args.userId,
      definitionName: args.definitionName,
      persisted: { ...persisted, googleFormsCursor: undefined },
    });
    return {
      kind: "retry",
      workflowId: args.automation.workflowId,
      message: lifecycle.ok
        ? eventWatchFailureMessage(lifecycle.value)
        : "Official Workflow event-watch reconciliation failed",
    };
  }
  return {
    kind: "needs-reconfiguration",
    workflowId: args.automation.workflowId,
    message: `Official Workflow Blueprint requires configuration: ${args.blueprint.key}`,
  };
}

interface ExistingAutomationReconciliationArgs {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly definitionName: string;
  readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  readonly activeDefinitionOnly: boolean;
  readonly automation: OfficialAutomationRow;
  readonly overrides: readonly OfficialWorkflowParameterBinding[];
  readonly userTimezone: string | null;
  readonly prepareEvent: (
    automationId: string,
    input: CreateAutomationInput,
  ) => Promise<OfficialAutomationEventPreparationResult>;
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

async function prepareExistingAutomationReconfiguration(
  db: Db,
  args: ExistingAutomationReconciliationArgs,
  signal: AbortSignal,
): Promise<PreparedExistingAutomationReconfiguration> {
  const resolution = resolveOfficialWorkflowBlueprintForReconciliation(
    args.blueprint,
    args.automation.officialParameterBindings ?? [],
    args.overrides,
    args.userTimezone,
  );
  if (!resolution.ok) {
    return {
      kind: "result",
      result: await pauseForReconfiguration(
        db,
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
    const prepared = await args.prepareEvent(
      args.automation.id,
      createInput(
        {
          orgId: args.orgId,
          member: args.member,
          workflowId: args.automation.workflowId,
          definitionName: args.definitionName,
        },
        resolution.resolved,
        { enabled: args.automation.enabled },
      ),
    );
    signal.throwIfAborted();
    if (prepared.kind !== "ok") {
      await markActiveAutomationFailed(
        db,
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
      result: await pauseForReconfiguration(
        db,
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
}

function automationStructureChanged(
  automation: OfficialAutomationRow,
  patch: OfficialAutomationPatch,
): boolean {
  return (
    automation.kind !== patch.kind ||
    (patch.kind === "event" && automation.eventType !== patch.eventType)
  );
}

async function stageAutomationStructureTransition(
  db: Db,
  args: ExistingAutomationReconciliationArgs,
  signal: AbortSignal,
): Promise<PersistedReconfiguration | null> {
  return await db.transaction(async (tx) => {
    await acquireReconciliationLocks(tx, args.orgId);
    if (
      !(await acceptedBlueprintIsCurrent(
        tx,
        {
          definitionName: args.definitionName,
          blueprintKey: args.blueprint.key,
          fingerprint: args.blueprint.fingerprint,
          activeDefinitionOnly: args.activeDefinitionOnly,
        },
        signal,
      )) ||
      !(await lockInstalledWorkflow(tx, {
        orgId: args.orgId,
        userId: args.member.userId,
        workflowId: args.automation.workflowId,
        definitionName: args.definitionName,
      }))
    ) {
      return null;
    }
    const [current] = await tx
      .select()
      .from(workflowAutomations)
      .where(eq(workflowAutomations.id, args.automation.id))
      .for("update")
      .limit(1);
    if (
      !current ||
      !sameAutomationConfigurationBaseline(args.automation, current)
    ) {
      return null;
    }
    const [formsCursor] = await tx
      .select({ cursor: googleFormsAutomationCursors.lastSeenSubmittedTime })
      .from(googleFormsAutomationCursors)
      .where(eq(googleFormsAutomationCursors.automationId, current.id))
      .limit(1);
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
      .returning();
    if (!staged) {
      throw new Error("Official Workflow automation disappeared");
    }
    await upsertActiveIdentity(tx, staged, currentTime);
    return {
      previous: current,
      current: staged,
      googleFormsCursor: formsCursor?.cursor,
    };
  });
}

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

async function compensateAutomationStructureTransition(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly definitionName: string;
    readonly persisted: PersistedReconfiguration;
    readonly desired: OfficialAutomationRow;
  },
): Promise<void> {
  const cleanupSignal = new AbortController().signal;
  await settle(
    reconcileAutomationEventWatchReconfiguration(
      db,
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
    reconcileAutomationEventWatchInventoryForOwner(
      db,
      { orgId: args.orgId, userId: args.userId },
      cleanupSignal,
    ),
    cleanupSignal,
  );
  await restoreFailedReconfiguration(db, {
    orgId: args.orgId,
    userId: args.userId,
    definitionName: args.definitionName,
    persisted: args.persisted,
  });
}

async function prepareAutomationStructureTransitionWatch(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly persisted: PersistedReconfiguration;
    readonly desired: OfficialAutomationRow;
    readonly preparation: OfficialAutomationEventPreparation | undefined;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const oldWatch = await settle(
    reconcileAutomationEventWatchReconfiguration(
      db,
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
    reconcileAutomationEventWatchInventoryForOwner(
      db,
      { orgId: args.orgId, userId: args.userId },
      signal,
    ),
    signal,
  );
  if (!inventory.ok || !inventory.value) {
    return "Official Workflow event-watch inventory reconciliation failed";
  }
  const newWatch = await settle(
    ensureAutomationEventWatchReconfiguration(
      db,
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
}

type FinalizeAutomationStructureTransitionResult =
  | { readonly kind: "current" }
  | { readonly kind: "superseded" }
  | { readonly kind: "failed"; readonly message: string };

async function finalizeAutomationStructureTransition(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly definitionName: string;
    readonly blueprint: OfficialWorkflowAcceptedBlueprint;
    readonly activeDefinitionOnly: boolean;
    readonly persisted: PersistedReconfiguration;
    readonly patch: OfficialAutomationPatch;
    readonly preparation: OfficialAutomationEventPreparation | undefined;
  },
  signal: AbortSignal,
): Promise<FinalizeAutomationStructureTransitionResult> {
  return await db.transaction(async (tx) => {
    await acquireReconciliationLocks(tx, args.orgId);
    if (
      !(await acceptedBlueprintIsCurrent(
        tx,
        {
          definitionName: args.definitionName,
          blueprintKey: args.blueprint.key,
          fingerprint: args.blueprint.fingerprint,
          activeDefinitionOnly: args.activeDefinitionOnly,
        },
        signal,
      ))
    ) {
      return { kind: "superseded" };
    }
    const webhookTierEligible =
      args.patch.eventType !== "webhook-received" ||
      (await lockWorkflowWebhookAutomationTierEligibleForOrg(
        tx,
        { orgId: args.orgId },
        signal,
      ));
    const accountProjection = await lockOfficialAutomationAccountProjection(
      tx,
      {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.persisted.current.workflowId,
        currentEventType: args.persisted.current.eventType,
        nextEventType: args.patch.eventType,
      },
      signal,
    );
    if (
      !(await lockInstalledWorkflow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.persisted.current.workflowId,
        definitionName: args.definitionName,
      }))
    ) {
      return { kind: "superseded" };
    }
    const [current] = await tx
      .select()
      .from(workflowAutomations)
      .where(eq(workflowAutomations.id, args.persisted.current.id))
      .for("update")
      .limit(1);
    if (
      !current ||
      current.updatedAt.getTime() !==
        args.persisted.current.updatedAt.getTime() ||
      current.officialReconciliationStatus !== "reconciling" ||
      !(await lockActiveIdentityOwnership(tx, current))
    ) {
      return { kind: "superseded" };
    }
    if (!accountProjectionMatchesPatch(accountProjection, args.patch)) {
      return { kind: "superseded" };
    }
    const currentTime = nowDate();
    const desired = structureTransitionWatchAutomation(current, args.patch);
    const subtypeFailure = await syncOfficialAutomationSubtypeRows(
      tx,
      {
        current: desired,
        preparation: args.preparation,
        webhookTierEligible,
        currentTime,
      },
      signal,
    );
    if (subtypeFailure) {
      return {
        kind: "failed",
        message: failureMessage(subtypeFailure),
      };
    }
    if (desired.eventType !== "google-forms-response-submitted") {
      await tx
        .delete(googleFormsAutomationCursors)
        .where(eq(googleFormsAutomationCursors.automationId, current.id));
    }
    const [finalized] = await tx
      .update(workflowAutomations)
      .set({
        ...refreshOfficialAutomationPatch(current, args.patch, currentTime),
        officialReconciliationStatus: "current",
      })
      .where(eq(workflowAutomations.id, current.id))
      .returning();
    if (!finalized) {
      throw new Error("Official Workflow automation disappeared");
    }
    await upsertActiveIdentity(tx, finalized, currentTime);
    await tx
      .update(workflows)
      .set({ updatedBy: args.userId, updatedAt: currentTime })
      .where(eq(workflows.id, finalized.workflowId));
    return { kind: "current" };
  });
}

async function reconcileAutomationStructureTransition(
  db: Db,
  args: ExistingAutomationReconciliationArgs,
  prepared: Extract<
    PreparedExistingAutomationReconfiguration,
    { kind: "ready" }
  >,
  signal: AbortSignal,
): Promise<OfficialWorkflowReconciliationResult> {
  const persisted = await stageAutomationStructureTransition(db, args, signal);
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
  const watchFailure = await prepareAutomationStructureTransitionWatch(
    db,
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
    await compensateAutomationStructureTransition(db, {
      orgId: args.orgId,
      userId: args.member.userId,
      definitionName: args.definitionName,
      persisted,
      desired,
    });
    return {
      kind: "retry",
      workflowId: args.automation.workflowId,
      message: watchFailure,
    };
  }
  await automationStructureTransitionPreparedHookForTest.get()?.({
    definitionName: args.definitionName,
    workflowId: args.automation.workflowId,
    automationId: args.automation.id,
    blueprintKey: args.blueprint.key,
    fingerprint: args.blueprint.fingerprint,
  });
  signal.throwIfAborted();
  const finalization = await settle(
    finalizeAutomationStructureTransition(
      db,
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

  const cleanupSignal = new AbortController().signal;
  await reconcileAutomationEventWatchReconfiguration(
    db,
    {
      previous: [desired],
      current: [persisted.current],
      googleForms: [],
    },
    cleanupSignal,
  );
  await reconcileAutomationEventWatchInventoryForOwner(
    db,
    { orgId: args.orgId, userId: args.member.userId },
    cleanupSignal,
  );
  if (finalization.ok && finalization.value.kind === "superseded") {
    return {
      kind: "retry",
      workflowId: args.automation.workflowId,
      message: "Official Workflow reconciliation was superseded",
    };
  }
  await restoreFailedReconfiguration(db, {
    orgId: args.orgId,
    userId: args.member.userId,
    definitionName: args.definitionName,
    persisted,
  });
  return {
    kind: "retry",
    workflowId: args.automation.workflowId,
    message:
      finalization.ok && finalization.value.kind === "failed"
        ? finalization.value.message
        : "Official Workflow structure transition failed",
  };
}

async function reconcileExistingAutomation(
  db: Db,
  args: ExistingAutomationReconciliationArgs,
  signal: AbortSignal,
): Promise<OfficialWorkflowReconciliationResult> {
  const prepared = await prepareExistingAutomationReconfiguration(
    db,
    args,
    signal,
  );
  if (prepared.kind === "result") {
    return prepared.result;
  }
  if (
    automationStructureChanged(args.automation, prepared.patch) ||
    args.automation.officialReconciliationStatus === "reconciling" ||
    args.automation.officialReconciliationStatus === "failed"
  ) {
    return await reconcileAutomationStructureTransition(
      db,
      args,
      prepared,
      signal,
    );
  }
  const persisted = await persistReconfigurationPatch(
    db,
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
  const watch = await settle(
    reconcileAutomationEventWatchReconfiguration(
      db,
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
    await restoreFailedReconfiguration(db, {
      orgId: args.orgId,
      userId: args.member.userId,
      definitionName: args.definitionName,
      persisted,
    });
    return {
      kind: "retry",
      workflowId: args.automation.workflowId,
      message: watch.ok
        ? eventWatchFailureMessage(watch.value)
        : "Official Workflow event-watch reconciliation failed",
    };
  }
  const finalized = await finalizeReconfiguration(
    db,
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
    await restoreFailedReconfiguration(db, {
      orgId: args.orgId,
      userId: args.member.userId,
      definitionName: args.definitionName,
      persisted,
    });
    return {
      kind: "retry",
      workflowId: args.automation.workflowId,
      message: "Official Workflow reconciliation was superseded",
    };
  }
  return { kind: "current", workflowId: args.automation.workflowId };
}

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

async function markActiveAutomationFailed(
  db: Db,
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
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    await acquireReconciliationLocks(tx, args.orgId);
    if (
      !(await acceptedBlueprintIsCurrent(
        tx,
        {
          definitionName: args.definitionName,
          blueprintKey: args.blueprint.key,
          fingerprint: args.blueprint.fingerprint,
          activeDefinitionOnly: args.activeDefinitionOnly,
        },
        signal,
      )) ||
      !(await lockInstalledWorkflow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.workflowId,
        definitionName: args.definitionName,
      }))
    ) {
      return false;
    }
    const [current] = await tx
      .select()
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
      .returning();
    if (!failed) {
      return false;
    }
    await upsertActiveIdentity(tx, failed, currentTime);
    return true;
  });
}

interface DormantIdentityReservation {
  readonly kind: "reserved" | "busy" | "active";
  readonly id: string;
  readonly intendedEnabled: boolean;
}

async function reserveDormantIdentity(
  db: Db,
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
): Promise<DormantIdentityReservation | null> {
  return await db.transaction(async (tx) => {
    await acquireReconciliationLocks(tx, args.orgId);
    if (
      !(await acceptedBlueprintIsCurrent(
        tx,
        {
          definitionName: args.definitionName,
          blueprintKey: args.blueprint.key,
          fingerprint: args.blueprint.fingerprint,
          activeDefinitionOnly: args.activeDefinitionOnly,
        },
        signal,
      )) ||
      !(await lockInstalledWorkflow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.workflowId,
        definitionName: args.definitionName,
      }))
    ) {
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
          eq(officialWorkflowAutomationIdentities.workflowId, args.workflowId),
          eq(
            officialWorkflowAutomationIdentities.blueprintKey,
            args.blueprint.key,
          ),
        ),
      )
      .for("update")
      .limit(1);
    const currentTime = nowDate();
    const intendedEnabled =
      identity?.retainedIntendedEnabled ?? args.fallbackIntendedEnabled;
    if (
      identity?.state === "reconciling" &&
      currentTime.getTime() - identity.updatedAt.getTime() <
        DORMANT_CREATION_LEASE_MS
    ) {
      return { kind: "busy" as const, id: identity.id, intendedEnabled };
    }
    if (identity) {
      await tx
        .update(officialWorkflowAutomationIdentities)
        .set({
          automationId: null,
          state: "reconciling",
          retainedParameterBindings: [...args.bindings],
          retainedIntendedEnabled: intendedEnabled,
          retainedAppliedFingerprint: args.blueprint.fingerprint,
          updatedAt: currentTime,
        })
        .where(eq(officialWorkflowAutomationIdentities.id, identity.id));
      return { kind: "reserved" as const, id: identity.id, intendedEnabled };
    }
    const [inserted] = await tx
      .insert(officialWorkflowAutomationIdentities)
      .values({
        workflowId: args.workflowId,
        automationId: null,
        blueprintKey: args.blueprint.key,
        state: "reconciling",
        retainedParameterBindings: [...args.bindings],
        retainedIntendedEnabled: intendedEnabled,
        retainedAppliedFingerprint: args.blueprint.fingerprint,
        createdAt: currentTime,
        updatedAt: currentTime,
      })
      .returning({ id: officialWorkflowAutomationIdentities.id });
    if (!inserted) {
      throw new Error("Failed to reserve Official Automation identity");
    }
    return { kind: "reserved" as const, id: inserted.id, intendedEnabled };
  });
}

async function retainDormantIdentity(
  db: Db,
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
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    await acquireReconciliationLocks(tx, args.orgId);
    if (
      !(await acceptedBlueprintIsCurrent(
        tx,
        {
          definitionName: args.definitionName,
          blueprintKey: args.blueprint.key,
          fingerprint: args.blueprint.fingerprint,
          activeDefinitionOnly: args.activeDefinitionOnly,
        },
        signal,
      )) ||
      !(await lockInstalledWorkflow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.workflowId,
        definitionName: args.definitionName,
      }))
    ) {
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
          eq(officialWorkflowAutomationIdentities.workflowId, args.workflowId),
          eq(
            officialWorkflowAutomationIdentities.blueprintKey,
            args.blueprint.key,
          ),
        ),
      )
      .for("update")
      .limit(1);
    const currentTime = nowDate();
    const intendedEnabled =
      identity?.retainedIntendedEnabled ?? args.fallbackIntendedEnabled;
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
}

async function removeDormantCreationOrphan(
  db: Db,
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
): Promise<boolean> {
  const result = await db.transaction(async (tx) => {
    await acquireReconciliationLocks(tx, args.orgId);
    if (
      !(await acceptedBlueprintIsCurrent(
        tx,
        {
          definitionName: args.definitionName,
          blueprintKey: args.blueprint.key,
          fingerprint: args.blueprint.fingerprint,
          activeDefinitionOnly: args.activeDefinitionOnly,
        },
        signal,
      )) ||
      !(await lockInstalledWorkflow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.workflowId,
        definitionName: args.definitionName,
      }))
    ) {
      return { kind: "blocked" as const };
    }
    const [automation] = await tx
      .select()
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
          eq(officialWorkflowAutomationIdentities.workflowId, args.workflowId),
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
  if (result.kind === "blocked") {
    return false;
  }
  if (result.kind === "deleted") {
    const cleanup = await settle(
      reconcileAutomationEventWatches(
        { db, automations: [result.automation] },
        signal,
      ),
      signal,
    );
    return cleanup.ok;
  }
  return true;
}

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

async function lockDormantMaterializationOwnership(
  db: Db,
  args: DormantMaterializationOwnershipArgs,
): Promise<OfficialAutomationRow | null> {
  const rows = await lockDormantMaterializationRows(db, args);
  if (
    !rows ||
    rows.identity.state !== "reconciling" ||
    rows.automation.officialReconciliationStatus !== "reconciling"
  ) {
    return null;
  }
  return rows.automation;
}

async function lockDormantMaterializationRows(
  db: Db,
  args: DormantMaterializationOwnershipArgs,
): Promise<{
  readonly automation: OfficialAutomationRow;
  readonly identity: typeof officialWorkflowAutomationIdentities.$inferSelect;
} | null> {
  const [automation] = await db
    .select()
    .from(workflowAutomations)
    .where(eq(workflowAutomations.id, args.automationId))
    .for("update")
    .limit(1);
  const [identity] = await db
    .select()
    .from(officialWorkflowAutomationIdentities)
    .where(
      and(
        eq(officialWorkflowAutomationIdentities.id, args.automationId),
        eq(officialWorkflowAutomationIdentities.workflowId, args.workflowId),
        eq(
          officialWorkflowAutomationIdentities.blueprintKey,
          args.blueprintKey,
        ),
      ),
    )
    .for("update")
    .limit(1);
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

async function validateDormantMaterialization(
  db: Db,
  args: DormantMaterializationOwnershipArgs,
  signal: AbortSignal,
): Promise<OfficialAutomationRow | null> {
  return await db.transaction(async (tx) => {
    await acquireReconciliationLocks(tx, args.orgId);
    if (
      !(await acceptedBlueprintIsCurrent(
        tx,
        {
          definitionName: args.definitionName,
          blueprintKey: args.blueprintKey,
          fingerprint: args.fingerprint,
          activeDefinitionOnly: args.activeDefinitionOnly,
        },
        signal,
      )) ||
      !(await lockInstalledWorkflow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.workflowId,
        definitionName: args.definitionName,
      }))
    ) {
      return null;
    }
    return await lockDormantMaterializationOwnership(tx, args);
  });
}

async function finalizeDormantMaterialization(
  db: Db,
  args: DormantMaterializationOwnershipArgs,
  signal: AbortSignal,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    await acquireReconciliationLocks(tx, args.orgId);
    if (
      !(await acceptedBlueprintIsCurrent(
        tx,
        {
          definitionName: args.definitionName,
          blueprintKey: args.blueprintKey,
          fingerprint: args.fingerprint,
          activeDefinitionOnly: args.activeDefinitionOnly,
        },
        signal,
      )) ||
      !(await lockInstalledWorkflow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.workflowId,
        definitionName: args.definitionName,
      }))
    ) {
      return false;
    }
    const automation = await lockDormantMaterializationOwnership(tx, args);
    if (!automation || automation.enabled !== args.intendedEnabled) {
      return false;
    }
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
      .set({
        automationId: automation.id,
        state: "active",
        retainedParameterBindings: null,
        retainedIntendedEnabled: null,
        retainedAppliedFingerprint: null,
        updatedAt: currentTime,
      })
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
}

async function discardDormantMaterialization(
  db: Db,
  args: DormantMaterializationOwnershipArgs,
  signal: AbortSignal,
): Promise<boolean> {
  const persisted = await db.transaction(async (tx) => {
    await acquireReconciliationLocks(tx, args.orgId);
    const rows = await lockDormantMaterializationRows(tx, args);
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
      .returning();
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
  if (!persisted) {
    return false;
  }
  const watch = await settle(
    reconcileAutomationEventWatches(
      { db, automations: [persisted.previous] },
      signal,
    ),
    signal,
  );
  if (!watch.ok || !watch.value) {
    return false;
  }
  return await db.transaction(async (tx) => {
    await acquireReconciliationLocks(tx, args.orgId);
    const rows = await lockDormantMaterializationRows(tx, args);
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
}

interface DormantBlueprintReconciliationArgs {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly definitionName: string;
  readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  readonly activeDefinitionOnly: boolean;
  readonly identity:
    | typeof officialWorkflowAutomationIdentities.$inferSelect
    | undefined;
  readonly overrides: readonly OfficialWorkflowParameterBinding[];
  readonly userTimezone: string | null;
  readonly createAutomation: (
    input: CreateAutomationInput,
  ) => Promise<AutomationResult>;
  readonly enableAutomation: (
    automationId: string,
  ) => Promise<AutomationResult>;
  readonly enableMaterializingAutomation: (
    automationId: string,
  ) => Promise<AutomationResult>;
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

async function resumeDormantMaterialization(
  db: Db,
  args: DormantBlueprintReconciliationArgs,
  materialization: {
    readonly automationId: string;
    readonly bindings: readonly OfficialWorkflowParameterBinding[];
    readonly intendedEnabled: boolean;
  },
  signal: AbortSignal,
): Promise<OfficialWorkflowReconciliationResult> {
  const ownership = dormantMaterializationOwnershipArgs(args, materialization);
  const staged = await validateDormantMaterialization(db, ownership, signal);
  if (!staged) {
    await discardDormantMaterialization(db, ownership, signal);
    return {
      kind: "retry",
      workflowId: args.workflowId,
      message: "Official Workflow reconciliation was superseded",
    };
  }
  if (staged.enabled && !materialization.intendedEnabled) {
    await discardDormantMaterialization(db, ownership, signal);
    return {
      kind: "retry",
      workflowId: args.workflowId,
      message: "Official Workflow materialization state is inconsistent",
    };
  }
  if (materialization.intendedEnabled && !staged.enabled) {
    const enabled = await settle(
      args.enableMaterializingAutomation(materialization.automationId),
      signal,
    );
    signal.throwIfAborted();
    if (!enabled.ok || enabled.value.kind !== "ok") {
      await discardDormantMaterialization(db, ownership, signal);
      return {
        kind: "retry",
        workflowId: args.workflowId,
        message: enabled.ok
          ? failureMessage(enabled.value)
          : "Official Workflow materialization lifecycle failed",
      };
    }
  }
  if (await finalizeDormantMaterialization(db, ownership, signal)) {
    return { kind: "current", workflowId: args.workflowId };
  }
  await discardDormantMaterialization(db, ownership, signal);
  return {
    kind: "retry",
    workflowId: args.workflowId,
    message: "Official Workflow reconciliation was superseded",
  };
}

async function materializeReservedDormantAutomation(
  db: Db,
  args: DormantBlueprintReconciliationArgs,
  resolved: ResolvedBlueprint,
  reservation: { readonly id: string; readonly intendedEnabled: boolean },
  signal: AbortSignal,
): Promise<OfficialWorkflowReconciliationResult> {
  const created = await settle(
    args.createAutomation(
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
    ),
    signal,
  );
  if (!created.ok || created.value.kind !== "ok") {
    await removeDormantCreationOrphan(
      db,
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
    await retainDormantIdentity(
      db,
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
  return await resumeDormantMaterialization(
    db,
    args,
    {
      automationId: reservation.id,
      bindings: resolved.bindings,
      intendedEnabled: reservation.intendedEnabled,
    },
    signal,
  );
}

async function reconcileDormantBlueprint(
  db: Db,
  args: DormantBlueprintReconciliationArgs,
  signal: AbortSignal,
): Promise<OfficialWorkflowReconciliationResult> {
  const resolution = resolveOfficialWorkflowBlueprintForReconciliation(
    args.blueprint,
    args.identity?.retainedParameterBindings ?? [],
    args.overrides,
    args.userTimezone,
  );
  if (!resolution.ok) {
    const retained = await retainDormantIdentity(
      db,
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
  const reservation = await reserveDormantIdentity(
    db,
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
  const orphanRemoved = await removeDormantCreationOrphan(
    db,
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
  await dormantMaterializationReservedHookForTest.get()?.({
    definitionName: args.definitionName,
    workflowId: args.workflowId,
    automationId: reservation.id,
    blueprintKey: args.blueprint.key,
    fingerprint: args.blueprint.fingerprint,
  });
  signal.throwIfAborted();
  return await materializeReservedDormantAutomation(
    db,
    args,
    resolution.resolved,
    reservation,
    signal,
  );
}

interface RemoveAutomationConfigurationArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly definition: OfficialWorkflowAcceptedDefinition;
  readonly activeDefinitionOnly: boolean;
  readonly automation: OfficialAutomationRow;
}

async function acceptedDefinitionOmitsBlueprint(
  db: ReadonlyDb,
  definitionName: string,
  blueprintKey: string | null,
  activeDefinitionOnly: boolean,
  signal: AbortSignal,
): Promise<boolean> {
  const catalog = await readAcceptedOfficialWorkflowCatalog(db, signal);
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

async function pauseRemovedAutomationConfiguration(
  db: Db,
  args: RemoveAutomationConfigurationArgs,
  signal: AbortSignal,
): Promise<
  | {
      readonly previous: OfficialAutomationRow;
      readonly current: OfficialAutomationRow;
    }
  | undefined
> {
  return await db.transaction(async (tx) => {
    await acquireReconciliationLocks(tx, args.orgId);
    if (
      !(await acceptedDefinitionOmitsBlueprint(
        tx,
        args.definition.name,
        args.automation.officialBlueprintKey,
        args.activeDefinitionOnly,
        signal,
      )) ||
      !(await lockInstalledWorkflow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.automation.workflowId,
        definitionName: args.definition.name,
      }))
    ) {
      return undefined;
    }
    const [current] = await tx
      .select()
      .from(workflowAutomations)
      .where(eq(workflowAutomations.id, args.automation.id))
      .for("update")
      .limit(1);
    if (!current || !sameAutomationBaseline(args.automation, current)) {
      return undefined;
    }
    const [row] = await tx
      .update(workflowAutomations)
      .set({
        enabled: false,
        nextRunAt: null,
        officialReconciliationStatus: "reconciling",
        updatedAt: nowDate(),
      })
      .where(eq(workflowAutomations.id, current.id))
      .returning();
    return row ? { previous: current, current: row } : undefined;
  });
}

async function deleteRemovedAutomationConfiguration(
  db: Db,
  args: RemoveAutomationConfigurationArgs,
  paused: { readonly current: OfficialAutomationRow },
  signal: AbortSignal,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    await acquireReconciliationLocks(tx, args.orgId);
    if (
      !(await acceptedDefinitionOmitsBlueprint(
        tx,
        args.definition.name,
        paused.current.officialBlueprintKey,
        args.activeDefinitionOnly,
        signal,
      )) ||
      !(await lockInstalledWorkflow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: paused.current.workflowId,
        definitionName: args.definition.name,
      }))
    ) {
      return false;
    }
    const [current] = await tx
      .select()
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
}

async function removeAutomationConfiguration(
  db: Db,
  args: RemoveAutomationConfigurationArgs,
  signal: AbortSignal,
): Promise<OfficialWorkflowReconciliationResult> {
  const paused = await pauseRemovedAutomationConfiguration(db, args, signal);
  if (!paused) {
    return {
      kind: "retry",
      workflowId: args.automation.workflowId,
      message: "Official Workflow reconciliation was superseded",
    };
  }
  const watch = await settle(
    reconcileAutomationEventWatchReconfiguration(
      db,
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
    await restoreFailedReconfiguration(db, {
      orgId: args.orgId,
      userId: args.userId,
      definitionName: args.definition.name,
      persisted: { ...paused, googleFormsCursor: undefined },
    });
    return {
      kind: "retry",
      workflowId: args.automation.workflowId,
      message: watch.ok
        ? eventWatchFailureMessage(watch.value)
        : "Official Workflow event-watch removal failed",
    };
  }
  const removed = await deleteRemovedAutomationConfiguration(
    db,
    args,
    paused,
    signal,
  );
  if (!removed) {
    await restoreFailedReconfiguration(db, {
      orgId: args.orgId,
      userId: args.userId,
      definitionName: args.definition.name,
      persisted: { ...paused, googleFormsCursor: undefined },
    });
    return {
      kind: "retry",
      workflowId: args.automation.workflowId,
      message: "Official Workflow Blueprint removal was superseded",
    };
  }
  return { kind: "removed", workflowId: args.automation.workflowId };
}

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

interface ReconciliationOperations {
  readonly prepareEvent: (
    automationId: string,
    input: CreateAutomationInput,
  ) => Promise<OfficialAutomationEventPreparationResult>;
  readonly createAutomation: (
    input: CreateAutomationInput,
  ) => Promise<AutomationResult>;
  readonly enableAutomation: (
    automationId: string,
  ) => Promise<AutomationResult>;
  readonly enableMaterializingAutomation: (
    automationId: string,
  ) => Promise<AutomationResult>;
}

interface InstallationReconciliationExecution {
  readonly db: Db;
  readonly args: ReconcileOfficialWorkflowInstallationArgs;
  readonly context: ReconciliationContext;
  readonly indexes: ReconciliationIndexes;
  readonly overridesByKey: ReadonlyMap<
    string,
    readonly OfficialWorkflowParameterBinding[]
  >;
  readonly userTimezone: string | null;
  readonly operations: ReconciliationOperations;
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

async function reconcileReservedDormantMaterialization(
  execution: InstallationReconciliationExecution,
  blueprint: OfficialWorkflowAcceptedBlueprint,
  automation: OfficialAutomationRow,
  identity: typeof officialWorkflowAutomationIdentities.$inferSelect,
  signal: AbortSignal,
): Promise<OfficialWorkflowReconciliationResult | null> {
  const { args, context, db, operations, userTimezone } = execution;
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
    await discardDormantMaterialization(
      db,
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
  return await resumeDormantMaterialization(
    db,
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
      createAutomation: operations.createAutomation,
      enableAutomation: operations.enableAutomation,
      enableMaterializingAutomation: operations.enableMaterializingAutomation,
    },
    {
      automationId: automation.id,
      bindings: automation.officialParameterBindings,
      intendedEnabled: automation.officialIntendedEnabled,
    },
    signal,
  );
}

async function reconcileCurrentBlueprintLifecycleGap(
  execution: InstallationReconciliationExecution,
  blueprint: OfficialWorkflowAcceptedBlueprint,
  automation: OfficialAutomationRow,
  signal: AbortSignal,
): Promise<OfficialWorkflowReconciliationResult | null> {
  const { args, context, db, operations } = execution;
  const overrides = execution.overridesByKey.get(blueprint.key) ?? [];
  if (
    overrides.length !== 0 ||
    automation.officialAppliedFingerprint !== blueprint.fingerprint ||
    automation.officialReconciliationStatus !== "current"
  ) {
    return null;
  }
  if (automation.officialIntendedEnabled && !automation.enabled) {
    const enabled = await operations.enableAutomation(automation.id);
    signal.throwIfAborted();
    if (enabled.kind !== "ok") {
      await markActiveAutomationFailed(
        db,
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
}

async function reconcileDesiredBlueprint(
  execution: InstallationReconciliationExecution,
  blueprint: OfficialWorkflowAcceptedBlueprint,
  signal: AbortSignal,
): Promise<OfficialWorkflowReconciliationResult> {
  const { args, context, db, indexes, operations, userTimezone } = execution;
  const automation = indexes.automationByKey.get(blueprint.key);
  const identity = indexes.identityByKey.get(blueprint.key);
  const overrides = execution.overridesByKey.get(blueprint.key) ?? [];
  if (automation && identity) {
    const materialization = await reconcileReservedDormantMaterialization(
      execution,
      blueprint,
      automation,
      identity,
      signal,
    );
    if (materialization) {
      return materialization;
    }
  }
  if (automation) {
    const current = await reconcileCurrentBlueprintLifecycleGap(
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
    ? await reconcileExistingAutomation(
        db,
        {
          orgId: args.orgId,
          member: args.member,
          definitionName: context.definition.name,
          blueprint,
          activeDefinitionOnly: args.activeDefinitionOnly === true,
          automation,
          overrides,
          userTimezone,
          prepareEvent: operations.prepareEvent,
        },
        signal,
      )
    : await reconcileDormantBlueprint(
        db,
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
          createAutomation: operations.createAutomation,
          enableAutomation: operations.enableAutomation,
          enableMaterializingAutomation:
            operations.enableMaterializingAutomation,
        },
        signal,
      );
}

async function reconcileLoadedInstallation(
  execution: InstallationReconciliationExecution,
  target: OfficialAutomationRow | undefined,
  signal: AbortSignal,
): Promise<OfficialWorkflowReconciliationResult> {
  const { args, context, db, indexes } = execution;
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
      await removeAutomationConfiguration(
        db,
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
    results.push(await reconcileDesiredBlueprint(execution, blueprint, signal));
    signal.throwIfAborted();
  }
  return mergeResults(args.workflowId, results);
}

export const reconcileOfficialWorkflowInstallation$ = command(
  async (
    { set },
    args: ReconcileOfficialWorkflowInstallationArgs,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult> => {
    const db = set(writeDb$);
    const context = await loadReconciliationContext(db, args, signal);
    if (!context) {
      return { kind: "not-found" };
    }
    const indexes = buildReconciliationIndexes(context);
    const userTimezone = await loadOfficialWorkflowUserTimezone(db, {
      orgId: args.orgId,
      userId: args.member.userId,
    });
    signal.throwIfAborted();
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
    return await reconcileLoadedInstallation(
      {
        db,
        args,
        context,
        indexes,
        overridesByKey: overrides.overridesByKey,
        userTimezone,
        operations: {
          prepareEvent: async (automationId, input) => {
            return await set(
              prepareOfficialAutomationReconfiguration$,
              { automationId, input },
              signal,
            );
          },
          createAutomation: async (input) => {
            return await set(createWorkflowAutomation$, input, signal);
          },
          enableAutomation: async (automationId) => {
            return await set(
              enableWorkflowAutomation$,
              {
                orgId: args.orgId,
                member: args.member,
                automationId,
              },
              signal,
            );
          },
          enableMaterializingAutomation: async (automationId) => {
            return await set(
              enableWorkflowAutomation$,
              {
                orgId: args.orgId,
                member: args.member,
                automationId,
                allowReservedOfficialMaterialization: true,
              },
              signal,
            );
          },
        },
      },
      target,
      signal,
    );
  },
);
