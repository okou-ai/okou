import type { OfficialWorkflowAcceptedBlueprint } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { googleFormsResponseSubmittedEventConfigSchema } from "@okouai/api-contracts/contracts/workflows";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import {
  officialWorkflowAutomationIdentities,
  workflowAutomations,
  workflows,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  googleFormsCursorMustReset,
  googleFormsCursorPublicationStatement,
} from "./google-forms-cursor-lifecycle";
import {
  ensureGoogleFormsWatchForUser$,
  reconcileGoogleFormsWatchesForUser$,
} from "./google-forms-automation-event.service";
import {
  readAcceptedOfficialWorkflowCatalog$,
  readAcceptedOfficialWorkflowRevision$,
} from "./official-workflow-catalog-read.service";
import {
  refreshOfficialAutomationPatch,
  type OfficialAutomationPatch,
  type OfficialAutomationRow,
} from "./official-workflow-installation.service";
import type { OfficialWorkflowReconciliationResult } from "./official-workflow-reconciliation-dispatch.service";

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
  ): Promise<boolean> => {
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
      return false;
    }
    const revision = await set(
      readAcceptedOfficialWorkflowRevision$,
      {
        name: definition.name,
        revision: definition.revision,
      },
      signal,
    );
    return (
      revision?.definition.blueprints.find((candidate) => {
        return candidate.key === args.blueprint.key;
      })?.fingerprint === args.blueprint.fingerprint
    );
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
    args: FormsReconfiguration,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const enabled =
      args.expected.officialIntendedEnabled === true || args.expected.enabled;
    const committed = await db.transaction(async (tx) => {
      const currentTime = nowDate();
      const [updated] = await tx
        .update(workflowAutomations)
        .set({
          ...refreshOfficialAutomationPatch(
            args.expected,
            { ...args.patch, enabled },
            currentTime,
          ),
          officialReconciliationStatus: "current",
        })
        .where(eq(workflowAutomations.id, args.expected.id))
        .returning(workflowAutomationColumns());
      if (!updated) {
        return false;
      }
      if (googleFormsCursorMustReset(args.expected, updated)) {
        await tx
          .delete(googleFormsAutomationCursors)
          .where(
            eq(googleFormsAutomationCursors.automationId, args.expected.id),
          );
      }
      const cursor = googleFormsCursorPublicationStatement(
        updated,
        args.seedCursor,
        currentTime,
      );
      if (cursor !== null) {
        await tx.execute(cursor);
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
      return true;
    });
    signal.throwIfAborted();
    return committed;
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
    if (!(await set(readFormsReconfigurationCatalog$, args, signal))) {
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
      args,
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
