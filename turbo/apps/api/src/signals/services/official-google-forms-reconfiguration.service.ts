import type { OfficialWorkflowAcceptedBlueprint } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { googleFormsResponseSubmittedEventConfigSchema } from "@okouai/api-contracts/contracts/workflows";
import { connectors } from "@okouai/db/schema/connector";
import {
  googleFormsAutomationCursors,
  googleFormsWatchStates,
} from "@okouai/db/schema/google-forms-event";
import { officialWorkflowCatalogState } from "@okouai/db/schema/official-workflow-catalog";
import {
  officialWorkflowAutomationIdentities,
  workflowAutomations,
  workflows,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { builtinConnectorStateLockStatement } from "./auth-state-lock.service";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  googleFormsCursorMustReset,
  googleFormsCursorPublicationStatement,
} from "./google-forms-cursor-lifecycle";
import {
  ensureGoogleFormsWatchForUser$,
  googleFormsSelectedAccountCondition,
  reconcileGoogleFormsWatchesForUser$,
} from "./google-forms-automation-event.service";
import {
  OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
  readAcceptedOfficialWorkflowCatalog$,
  readAcceptedOfficialWorkflowRevision$,
} from "./official-workflow-catalog-read.service";
import {
  refreshOfficialAutomationPatch,
  type OfficialAutomationPatch,
  type OfficialAutomationRow,
} from "./official-workflow-installation.service";
import type { OfficialWorkflowReconciliationResult } from "./official-workflow-reconciliation-dispatch.service";
import { observedWorkflowAutomationCondition } from "./workflow-automation-snapshot";

interface FormsReconfiguration {
  readonly orgId: string;
  readonly userId: string;
  readonly definitionName: string;
  readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  readonly activeDefinitionOnly: boolean;
  readonly expected: OfficialAutomationRow;
  readonly patch: OfficialAutomationPatch;
  readonly seedCursor: string;
}

const readFormsReconfigurationCatalog$ = command(
  async (
    { set },
    args: FormsReconfiguration,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const catalog = await set(readAcceptedOfficialWorkflowCatalog$, signal);
    const definition = catalog?.payload.definitions.find((candidate) => {
      return candidate.name === args.definitionName;
    });
    if (
      !definition ||
      (args.activeDefinitionOnly && definition.lifecycle !== "active") ||
      definition.blueprints.find((candidate) => {
        return candidate.key === args.blueprint.key;
      })?.fingerprint !== args.blueprint.fingerprint
    ) {
      return null;
    }
    const revision = await set(
      readAcceptedOfficialWorkflowRevision$,
      {
        name: definition.name,
        revision: definition.revision,
      },
      signal,
    );
    return revision?.definition.blueprints.find((candidate) => {
      return candidate.key === args.blueprint.key;
    })?.fingerprint === args.blueprint.fingerprint
      ? (catalog?.releaseId ?? null)
      : null;
  },
);

function activeIdentityValues(
  automation: OfficialAutomationRow,
  currentTime: Date,
) {
  if (automation.officialBlueprintKey === null) {
    throw new Error("Official Forms automation identity is incomplete");
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

function installedWorkflowCondition(args: FormsReconfiguration) {
  return and(
    eq(workflows.id, args.expected.workflowId),
    eq(workflows.orgId, args.orgId),
    eq(workflows.ownerUserId, args.userId),
    eq(workflows.officialDefinitionName, args.definitionName),
    eq(workflows.officialInstallationState, "installed"),
  );
}

function acceptedCatalogCondition(releaseId: string) {
  return and(
    eq(
      officialWorkflowCatalogState.authority,
      OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
    ),
    eq(officialWorkflowCatalogState.acceptedReleaseId, releaseId),
  );
}

function preparedWatchCondition(
  args: FormsReconfiguration & { readonly watchStateId: string | null },
) {
  if (args.watchStateId === null) {
    throw new Error("Official Forms publication requires its prepared watch");
  }
  const config = googleFormsResponseSubmittedEventConfigSchema.parse(
    args.patch.eventConfig,
  );
  return and(
    eq(googleFormsWatchStates.id, args.watchStateId),
    eq(googleFormsWatchStates.orgId, args.orgId),
    eq(googleFormsWatchStates.userId, args.userId),
    eq(googleFormsWatchStates.connectorId, config.connectorId),
    eq(googleFormsWatchStates.formId, config.form.id),
  );
}

function activeIdentityUpdate(automationId: string, updatedAt: Date) {
  return {
    automationId,
    state: "active" as const,
    retainedParameterBindings: null,
    retainedIntendedEnabled: null,
    retainedAppliedFingerprint: null,
    updatedAt,
  };
}

const commitOfficialFormsReconfiguration$ = command(
  async (
    { set },
    args: FormsReconfiguration & {
      readonly catalogReleaseId: string;
      readonly watchStateId: string | null;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const config = googleFormsResponseSubmittedEventConfigSchema.parse(
      args.patch.eventConfig,
    );
    return await db.transaction(async (tx) => {
      const [catalog] = await tx
        .select({ id: officialWorkflowCatalogState.acceptedReleaseId })
        .from(officialWorkflowCatalogState)
        .where(acceptedCatalogCondition(args.catalogReleaseId))
        .for("share")
        .limit(1);
      if (!catalog) {
        return false;
      }
      await tx.execute(
        builtinConnectorStateLockStatement({
          ...args,
          connectorSlug: "google-forms",
        }),
      );
      const [account] = await tx
        .select({ id: connectors.id })
        .from(connectors)
        .where(
          googleFormsSelectedAccountCondition({
            ...args,
            workflowId: args.expected.workflowId,
            connectorId: config.connectorId,
          }),
        )
        .for("key share")
        .limit(1);
      const [workflow] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(installedWorkflowCondition(args))
        .for("update")
        .limit(1);
      const [current] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(observedWorkflowAutomationCondition(args.expected))
        .for("update")
        .limit(1);
      if (!account || !workflow || !current) {
        return false;
      }
      const enabled =
        current.officialIntendedEnabled === true || current.enabled;
      if (enabled) {
        const [watch] = await tx
          .select({ id: googleFormsWatchStates.id })
          .from(googleFormsWatchStates)
          .where(preparedWatchCondition(args))
          .for("key share")
          .limit(1);
        if (!watch) {
          return false;
        }
      }
      const currentTime = nowDate();
      const [updated] = await tx
        .update(workflowAutomations)
        .set({
          ...refreshOfficialAutomationPatch(
            current,
            { ...args.patch, enabled },
            currentTime,
          ),
          officialReconciliationStatus: "current",
        })
        .where(observedWorkflowAutomationCondition(current))
        .returning(workflowAutomationColumns());
      if (!updated) {
        throw new Error(
          "Official Forms publication lost its locked observation",
        );
      }
      if (googleFormsCursorMustReset(current, updated)) {
        await tx
          .delete(googleFormsAutomationCursors)
          .where(eq(googleFormsAutomationCursors.automationId, current.id));
      }
      const cursor = googleFormsCursorPublicationStatement(
        updated,
        args.seedCursor,
        currentTime,
      );
      if (cursor !== null && (await tx.execute(cursor)).rowCount !== 1) {
        throw new Error("Official Forms publication lost its prepared watch");
      }
      await tx
        .insert(officialWorkflowAutomationIdentities)
        .values(activeIdentityValues(updated, currentTime))
        .onConflictDoUpdate({
          target: [
            officialWorkflowAutomationIdentities.workflowId,
            officialWorkflowAutomationIdentities.blueprintKey,
          ],
          set: activeIdentityUpdate(updated.id, currentTime),
        });
      await tx
        .update(workflows)
        .set({ updatedBy: args.userId, updatedAt: currentTime })
        .where(eq(workflows.id, updated.workflowId));
      signal.throwIfAborted();
      return true;
    });
  },
);

export const reconcileOfficialGoogleFormsConfiguration$ = command(
  async (
    { set },
    args: FormsReconfiguration,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult> => {
    const retry = {
      kind: "retry" as const,
      workflowId: args.expected.workflowId,
      message: "Official Workflow reconciliation was superseded",
    };
    const catalogReleaseId = await set(
      readFormsReconfigurationCatalog$,
      args,
      signal,
    );
    if (catalogReleaseId === null) {
      return retry;
    }
    const config = googleFormsResponseSubmittedEventConfigSchema.parse(
      args.patch.eventConfig,
    );
    const enabled =
      args.expected.officialIntendedEnabled === true || args.expected.enabled;
    const prepared = enabled
      ? await set(
          ensureGoogleFormsWatchForUser$,
          {
            orgId: args.orgId,
            userId: args.userId,
            connectorId: config.connectorId,
            formId: config.form.id,
            allowStagedOfficialTarget: true,
          },
          signal,
        )
      : null;
    if (prepared !== null && prepared.kind !== "ok") {
      return { ...retry, message: prepared.message };
    }
    const committed = await set(
      commitOfficialFormsReconfiguration$,
      {
        ...args,
        catalogReleaseId,
        watchStateId: prepared?.watchStateId ?? null,
      },
      signal,
    );
    if (!committed) {
      return retry;
    }
    // Source and cursor are already committed. Reconcile resource inventory only
    // afterward; a remote gap must not roll back the newer configuration.
    await set(
      reconcileGoogleFormsWatchesForUser$,
      { orgId: args.orgId, userId: args.userId },
      signal,
    );
    return { kind: "current", workflowId: args.expected.workflowId };
  },
);
