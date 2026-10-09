import type {
  OfficialWorkflowAcceptedRevision,
  OfficialWorkflowAcceptedDefinition,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { agents } from "@okouai/db/schema/agent";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import {
  officialWorkflowCatalogState,
  officialWorkflowCatalogReleases,
  officialWorkflowDefinitionRevisions,
} from "@okouai/db/schema/official-workflow-catalog";
import {
  workflows,
  workflowAutomations,
  workflowWebhookAutomations,
} from "@okouai/db/schema/workflow";
import { and, asc, eq, inArray, or, getTableColumns, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { isDeepStrictEqual } from "node:util";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { workflowAutomationColumns } from "../services/autonomy-budget-schema.service";
import {
  acceptedCatalogFromRow,
  acceptedRevisionFromRow,
  acceptedOfficialWorkflowCatalogReadPlan,
  acceptedOfficialWorkflowRevisionReadPlan,
} from "../services/official-workflow-catalog-read.service";
import { resolveOfficialWorkflowBlueprintForReconciliation } from "../services/official-workflow-installation.service";
import {
  visibleWorkflowCondition,
  type WorkflowRow,
  type WorkflowMember,
} from "../services/workflow-data.service";

export interface WorkflowCopySource {
  readonly revision: string | null;
  readonly sourceWorkflow: WorkflowRow;
  readonly sourceAutomations: readonly (typeof workflowAutomations.$inferSelect)[];
  readonly webhooks: readonly {
    readonly automationId: string;
    readonly encryptedSecret: string;
    readonly secretLastFour: string;
  }[];
  readonly files:
    | readonly {
        readonly path: string;
        readonly content: string;
      }[]
    | null;
  readonly storage: {
    readonly id: string;
    readonly headVersionId: string | null;
  } | null;
}

export interface WorkflowCopyInput {
  readonly orgId: string;
  readonly userId: string;
  readonly member: WorkflowMember;
  readonly sourceWorkflow: WorkflowRow;
  readonly targetAgentId: string;
  readonly sourceFiles: WorkflowCopySource["files"];
  readonly sourceStorage: WorkflowCopySource["storage"];
}

interface OfficialCopyMaterialization {
  readonly revision: string;
  readonly sourceWorkflow: WorkflowRow;
  readonly sourceAutomations: readonly (typeof workflowAutomations.$inferSelect)[];
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}
export const OFFICIAL_COPY_RECONFIGURE_MESSAGE =
  "Official Workflow cannot be copied from mixed or stale state; Reconfigure it and retry";

export const WORKFLOW_COPY_CHANGED_MESSAGE =
  "Workflow copy source or target changed during preparation; retry the copy";
export function workflowCopyConflict(message = WORKFLOW_COPY_CHANGED_MESSAGE) {
  return { kind: "conflict" as const, message };
}

/** SQL-only subqueries retain their inner locks and schema column decoders. */
export function copySourcePlans(args: WorkflowCopyInput) {
  const definitionName = args.sourceWorkflow.officialDefinitionName;
  const official = definitionName !== null;
  if (definitionName === "") {
    throw new Error(
      "Official copy materialization requires an Official source",
    );
  }
  const catalog = acceptedOfficialWorkflowCatalogReadPlan();
  return {
    official,
    definitionName,
    catalogLock: new QueryBuilder()
      .select({ authority: officialWorkflowCatalogState.authority })
      .from(officialWorkflowCatalogState)
      .where(catalog.condition)
      .for("share")
      .as("copy_catalog_lock"),
    catalog: new QueryBuilder()
      .select(catalog.columns)
      .from(officialWorkflowCatalogState)
      .innerJoin(officialWorkflowCatalogReleases, catalog.join)
      .where(catalog.condition)
      .limit(1)
      .as("copy_catalog"),
    parents: new QueryBuilder()
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, args.orgId),
          inArray(agents.id, [args.sourceWorkflow.agentId, args.targetAgentId]),
        ),
      )
      .orderBy(asc(agents.id))
      .for("share")
      .as("copy_parent_locks"),
    target: workflowCopyAgentQuery(args.orgId, args.targetAgentId),
    source: new QueryBuilder()
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.id, args.sourceWorkflow.id),
          eq(workflows.orgId, args.orgId),
          official ? eq(workflows.ownerUserId, args.userId) : undefined,
          definitionName !== null
            ? eq(workflows.officialDefinitionName, definitionName)
            : undefined,
          official
            ? eq(workflows.officialInstallationState, "installed")
            : undefined,
        ),
      )
      .for("update")
      .limit(1)
      .as("copy_source_lock"),
    visible: workflowCopyVisibleQuery({
      orgId: args.orgId,
      member: args.member,
      workflowId: args.sourceWorkflow.id,
    }),
    automations: new QueryBuilder()
      .select({
        ...workflowAutomationColumns(),
        observedUpdatedAt: sql`${workflowAutomations.updatedAt}::text`
          .mapWith(pgTextDecoder)
          .as("observed_updated_at"),
        observedXmin: sql`${workflowAutomations}.xmin::text`
          .mapWith(pgTextDecoder)
          .as("observed_xmin"),
      })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.orgId, args.orgId),
          eq(workflowAutomations.ownerUserId, args.userId),
          eq(workflowAutomations.workflowId, args.sourceWorkflow.id),
        ),
      )
      .orderBy(
        asc(
          official
            ? workflowAutomations.officialBlueprintKey
            : workflowAutomations.id,
        ),
      )
      .for("update")
      .as("copy_automation_locks"),
    storage: workflowCopyStorageQuery(args, true),
  };
}

export function copyRevisionQuery(identity: {
  readonly name: string;
  readonly revision: string;
}) {
  const plan = acceptedOfficialWorkflowRevisionReadPlan(identity);
  // The legacy single-identity bulk reader has this order and no LIMIT.
  return new QueryBuilder()
    .select(plan.columns)
    .from(officialWorkflowDefinitionRevisions)
    .innerJoin(storages, plan.storageJoin)
    .innerJoin(storageVersions, plan.storageVersionJoin)
    .where(or(plan.condition))
    .orderBy(
      asc(officialWorkflowDefinitionRevisions.definitionName),
      asc(officialWorkflowDefinitionRevisions.revision),
    )
    .as("copy_revision");
}

export function workflowCopyAgentQuery(orgId: string, agentId: string) {
  return new QueryBuilder()
    .select({
      id: agents.id,
      owner: agents.owner,
      visibility: agents.visibility,
      name: agents.name,
      displayName: agents.displayName,
    })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)))
    .limit(1)
    .as("copy_target");
}

export function workflowCopyVisibleQuery(args: {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
}) {
  return new QueryBuilder()
    .select(getTableColumns(workflows))
    .from(workflows)
    .innerJoin(agents, eq(workflows.agentId, agents.id))
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.id, args.workflowId),
        visibleWorkflowCondition(args.member),
      ),
    )
    .limit(1)
    .as("copy_visible");
}

export function workflowCopyStorageQuery(
  args: { readonly orgId: string; readonly sourceWorkflow: WorkflowRow },
  lock: boolean,
) {
  const query = new QueryBuilder()
    .select({ id: storages.id, headVersionId: storages.headVersionId })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, getCustomSkillStorageName(args.sourceWorkflow.id)),
      ),
    )
    .limit(1);
  return (lock ? query.for("share") : query).as("copy_storage");
}

export function copyWebhooksQuery(
  rows: WorkflowCopySource["sourceAutomations"],
) {
  return new QueryBuilder()
    .select({
      automationId: workflowWebhookAutomations.automationId,
      encryptedSecret: workflowWebhookAutomations.encryptedSecret,
      secretLastFour: workflowWebhookAutomations.secretLastFour,
    })
    .from(workflowWebhookAutomations)
    .where(
      inArray(
        workflowWebhookAutomations.automationId,
        rows.map((row) => {
          return row.id;
        }),
      ),
    )
    .orderBy(asc(workflowWebhookAutomations.automationId))
    .for("share")
    .as("copy_webhook_locks");
}

export function requireCopyTarget(
  target:
    | { readonly owner: string; readonly visibility: "public" | "private" }
    | undefined,
  member: WorkflowMember,
): void {
  if (
    !target ||
    requireAgentPermission(
      target.owner,
      member,
      "copy workflows onto this agent",
      { visibility: target.visibility },
    )
  ) {
    throw new CopyPreparationConflict();
  }
}

export function officialCopyMaterialization(
  sourceWorkflow: WorkflowRow,
  revision: OfficialWorkflowAcceptedRevision,
  rows: WorkflowCopySource["sourceAutomations"],
): OfficialCopyMaterialization {
  if (rows.length !== revision.definition.blueprints.length) {
    throw new CopyPreparationConflict(OFFICIAL_COPY_RECONFIGURE_MESSAGE);
  }
  const rowsByBlueprint = new Map(
    rows.map((row) => {
      return [row.officialBlueprintKey, row] as const;
    }),
  );
  const sourceAutomations: (typeof workflowAutomations.$inferSelect)[] = [];
  for (const blueprint of revision.definition.blueprints) {
    const row = rowsByBlueprint.get(blueprint.key);
    if (
      !row ||
      row.officialAppliedFingerprint !== blueprint.fingerprint ||
      row.officialReconciliationStatus !== "current" ||
      row.officialParameterBindings === null
    ) {
      throw new CopyPreparationConflict(OFFICIAL_COPY_RECONFIGURE_MESSAGE);
    }
    const resolved = resolveOfficialWorkflowBlueprintForReconciliation(
      blueprint,
      row.officialParameterBindings,
      [],
      row.timezone,
    );
    if (!resolved.ok) {
      throw new CopyPreparationConflict(OFFICIAL_COPY_RECONFIGURE_MESSAGE);
    }
    sourceAutomations.push(row);
  }
  return {
    revision: revision.definition.revision,
    sourceWorkflow: {
      ...sourceWorkflow,
      instruction: revision.definition.workflow.instruction,
      displayName: revision.definition.workflow.displayName,
      description: revision.definition.workflow.description,
      officialDefinitionName: null,
      officialInstallationState: null,
    },
    sourceAutomations,
    files: revision.definition.workflow.files,
  };
}

export function copySourceResult(
  args: WorkflowCopyInput,
  visible: WorkflowRow,
  materialization: OfficialCopyMaterialization | null,
  rows: WorkflowCopySource["sourceAutomations"],
  facts: Pick<WorkflowCopySource, "storage" | "webhooks">,
) {
  if (
    !materialization &&
    !isDeepStrictEqual(facts.storage, args.sourceStorage)
  ) {
    throw new CopyPreparationConflict();
  }
  return {
    kind: "ok" as const,
    source: {
      revision: materialization?.revision ?? null,
      sourceWorkflow: materialization?.sourceWorkflow ?? visible,
      sourceAutomations: materialization?.sourceAutomations ?? rows,
      webhooks: facts.webhooks,
      storage: facts.storage,
      files: materialization?.files ?? args.sourceFiles,
    },
  };
}

/** Expected preparation conflicts occur before any publication write. */
export class CopyPreparationConflict extends Error {
  constructor(message = WORKFLOW_COPY_CHANGED_MESSAGE) {
    super(message);
  }
}
export function copyTransactionResult<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
) {
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof CopyPreparationConflict) {
    return workflowCopyConflict(result.error.message);
  }
  throw result.error;
}
export function requireCopySource(
  row: WorkflowRow | undefined,
  official: boolean,
): WorkflowRow {
  if (!row) {
    throw new CopyPreparationConflict(
      official
        ? OFFICIAL_COPY_RECONFIGURE_MESSAGE
        : WORKFLOW_COPY_CHANGED_MESSAGE,
    );
  }
  return row;
}
export function requireCopyDefinition(
  row: Parameters<typeof acceptedCatalogFromRow>[0],
  name: string | null,
): OfficialWorkflowAcceptedDefinition {
  const definition = acceptedCatalogFromRow(row)?.payload.definitions.find(
    (candidate) => {
      return candidate.name === name;
    },
  );
  if (!definition) {
    throw new CopyPreparationConflict(OFFICIAL_COPY_RECONFIGURE_MESSAGE);
  }
  return definition;
}
export function requireCopyRevision(
  row: Parameters<typeof acceptedRevisionFromRow>[0] | undefined,
) {
  if (!row) {
    throw new CopyPreparationConflict(OFFICIAL_COPY_RECONFIGURE_MESSAGE);
  }
  return acceptedRevisionFromRow(row);
}
export function requireCopyVisibility(
  row: WorkflowRow | undefined,
  args: WorkflowCopyInput,
  official: boolean,
): WorkflowRow {
  if (!row || (!official && !isDeepStrictEqual(row, args.sourceWorkflow))) {
    throw new CopyPreparationConflict();
  }
  return row;
}

export function requirePreparedCopyUnchanged(
  current: WorkflowCopySource,
  prepared: WorkflowCopySource,
): void {
  if (!isDeepStrictEqual(current, prepared)) {
    throw new CopyPreparationConflict();
  }
}
