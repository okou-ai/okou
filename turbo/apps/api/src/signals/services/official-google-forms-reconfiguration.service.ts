import type { OfficialWorkflowAcceptedBlueprint } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { googleFormsResponseSubmittedEventConfigSchema } from "@okouai/api-contracts/contracts/workflows";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import {
  officialWorkflowAutomationIdentities,
  workflows,
} from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import { and, count, eq, exists, gte, notExists, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  googleFormsCursorMustReset,
  googleFormsCursorPublicationStatement,
} from "./google-forms-cursor-lifecycle";
import {
  ensureGoogleFormsWatchForUser$,
  reconcileGoogleFormsWatchesForUser$,
} from "./google-forms-automation-watch.service";
import {
  readAcceptedOfficialWorkflowCatalog$,
  readAcceptedOfficialWorkflowRevision$,
} from "./official-workflow-catalog-read.service";
import {
  refreshOfficialAutomationPatch,
  type OfficialAutomationPatch,
  type OfficialAutomationRow,
} from "./official-workflow-installation.service";
import type { OfficialWorkflowReconciliationResult } from "./official-workflow-reconciliation.types";
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

function formsIdentityPublicationSource(
  automation: OfficialAutomationRow,
  currentTime: Date,
) {
  const values = activeIdentityValues(automation, currentTime);
  const identity = officialWorkflowAutomationIdentities;
  return {
    id: sql`${values.id}::uuid`.mapWith(identity.id).as("id"),
    workflowId: sql`${values.workflowId}::uuid`
      .mapWith(identity.workflowId)
      .as("workflow_id"),
    automationId: sql`${values.automationId}::uuid`
      .mapWith(identity.automationId)
      .as("automation_id"),
    blueprintKey: sql`${values.blueprintKey}`
      .mapWith(identity.blueprintKey)
      .as("blueprint_key"),
    state: sql`${values.state}`.mapWith(identity.state).as("state"),
    retainedParameterBindings: sql`NULL::jsonb`
      .mapWith(identity.retainedParameterBindings)
      .as("retained_parameter_bindings"),
    retainedIntendedEnabled: sql`NULL::boolean`
      .mapWith(identity.retainedIntendedEnabled)
      .as("retained_intended_enabled"),
    retainedAppliedFingerprint: sql`NULL::varchar`
      .mapWith(identity.retainedAppliedFingerprint)
      .as("retained_applied_fingerprint"),
    createdAt:
      sql`${sql.param(values.createdAt, identity.createdAt)}::timestamp`
        .mapWith(identity.createdAt)
        .as("created_at"),
    updatedAt:
      sql`${sql.param(values.updatedAt, identity.updatedAt)}::timestamp`
        .mapWith(identity.updatedAt)
        .as("updated_at"),
  };
}

/** Only the existing snapshot UPDATE can admit the dependent publications. */
function formsReconfigurationValues(args: FormsReconfiguration, at: Date) {
  const enabled =
    args.expected.officialIntendedEnabled === true || args.expected.enabled;
  const patch = {
    ...refreshOfficialAutomationPatch(
      args.expected,
      { ...args.patch, enabled },
      at,
    ),
    officialReconciliationStatus: "current" as const,
  };
  const next = { ...args.expected, ...patch };
  const identitySource = formsIdentityPublicationSource(next, at);
  const reset = googleFormsCursorMustReset(args.expected, next);
  return { patch, next, identitySource, reset };
}

const commitOfficialFormsReconfiguration$ = command(
  async (
    { set },
    args: FormsReconfiguration,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const at = nowDate();
    const { patch, next, identitySource, reset } = formsReconfigurationValues(
      args,
      at,
    );
    const updated = db
      .$with("reconfigured_forms_automation")
      .as(
        db
          .update(workflowAutomations)
          .set(patch)
          .where(observedWorkflowAutomationCondition(args.expected))
          .returning({ id: workflowAutomations.id }),
      );
    const admitted = exists(db.select({ id: updated.id }).from(updated));
    const cursorStatement = googleFormsCursorPublicationStatement(
      next,
      args.seedCursor,
      at,
      { gate: admitted, reset },
    );
    const cursor = db
      .$with("published_forms_cursor", {
        automationId: googleFormsAutomationCursors.automationId,
      })
      .as(
        cursorStatement ??
          db
            .select({
              automationId: sql`${updated.id}`
                .mapWith(googleFormsAutomationCursors.automationId)
                .as("automation_id"),
            })
            .from(updated)
            .where(sql`false`)
            .getSQL(),
      );
    // Reset an old interval even when its new watch is absent. A successful
    // upsert already replaced the interval, so these writes never share a row.
    const removedCursor = db.$with("removed_forms_cursor").as(
      db
        .delete(googleFormsAutomationCursors)
        .where(
          and(
            eq(googleFormsAutomationCursors.automationId, args.expected.id),
            reset ? admitted : sql`false`,
            notExists(db.select().from(cursor)),
          ),
        )
        .returning({ automationId: googleFormsAutomationCursors.automationId }),
    );
    const identity = db.$with("published_forms_identity").as(
      db
        .insert(officialWorkflowAutomationIdentities)
        .select(
          db
            .select({
              id: identitySource.id,
              workflowId: identitySource.workflowId,
              automationId: identitySource.automationId,
              blueprintKey: identitySource.blueprintKey,
              state: identitySource.state,
              retainedParameterBindings:
                identitySource.retainedParameterBindings,
              retainedIntendedEnabled: identitySource.retainedIntendedEnabled,
              retainedAppliedFingerprint:
                identitySource.retainedAppliedFingerprint,
              createdAt: identitySource.createdAt,
              updatedAt: identitySource.updatedAt,
            })
            .from(updated)
            .where(
              and(
                gte(db.select({ value: count() }).from(cursor), 0),
                gte(db.select({ value: count() }).from(removedCursor), 0),
              ),
            ),
        )
        .onConflictDoUpdate({
          target: [
            officialWorkflowAutomationIdentities.workflowId,
            officialWorkflowAutomationIdentities.blueprintKey,
          ],
          set: activeIdentityUpdate(next.id, at),
        })
        .returning({ id: officialWorkflowAutomationIdentities.id }),
    );
    const installation = db.$with("touched_forms_installation").as(
      db
        .update(workflows)
        .set({ updatedBy: args.userId, updatedAt: at })
        .where(
          and(
            eq(workflows.id, next.workflowId),
            exists(db.select({ id: identity.id }).from(identity)),
          ),
        )
        .returning({ id: workflows.id }),
    );
    const [committed] = await db
      .with(updated, cursor, removedCursor, identity, installation)
      .select({ id: updated.id })
      .from(updated);
    signal.throwIfAborted();
    return committed !== undefined;
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
