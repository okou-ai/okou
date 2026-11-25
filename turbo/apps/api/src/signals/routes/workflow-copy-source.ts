import type { OfficialWorkflowAcceptedRevision } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  workflows,
  workflowWebhookAutomations,
} from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, asc, eq, inArray, getTableColumns, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { isDeepStrictEqual } from "node:util";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { workflowAutomationColumns } from "../services/autonomy-budget-schema.service";
import { canCopyInstalledBlueprint } from "./workflow-copy-blueprint";
import type {
  WorkflowRow,
  WorkflowMember,
} from "../services/workflow-data.service";
import { visibleWorkflowCondition } from "../services/workflow-visibility";
import type { installedOfficialWorkflow } from "../services/builtin-workflows";
import { workflowScheduleSchema } from "@okouai/api-contracts/contracts/workflows";
import { isValidTimeZone } from "@okouai/core/timezone";

interface WorkflowCopyObservation {
  readonly workflowXmin: string;
  readonly automations: readonly {
    readonly id: string;
    readonly xmin: string;
  }[];
}

export interface WorkflowCopySource {
  readonly observation: WorkflowCopyObservation;
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
}

export interface WorkflowCopyInput {
  readonly orgId: string;
  readonly userId: string;
  readonly member: WorkflowMember;
  readonly sourceWorkflow: WorkflowRow;
  readonly sourceFiles: WorkflowCopySource["files"];
}

interface OfficialCopyMaterialization {
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

/** Capture the source and native row versions before external preparation. */
export function copySourcePlans(args: WorkflowCopyInput) {
  const definitionName = args.sourceWorkflow.officialDefinitionName;
  const official = definitionName !== null;
  if (definitionName === "") {
    throw new Error(
      "Official copy materialization requires an Official source",
    );
  }
  const source = new QueryBuilder()
    .select({
      workflow: getTableColumns(workflows),
      observedXmin: sql`${workflows}.xmin::text`
        .mapWith(pgTextDecoder)
        .as("observed_xmin"),
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.id, args.sourceWorkflow.id),
        eq(workflows.orgId, args.orgId),
        official ? eq(workflows.ownerUserId, args.userId) : undefined,
        definitionName !== null
          ? eq(workflows.officialDefinitionName, definitionName)
          : undefined,
      ),
    );
  const automations = new QueryBuilder()
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
    );
  return {
    official,
    source: source.limit(1).as("copy_source"),
    visible: workflowCopyVisibleQuery({
      orgId: args.orgId,
      member: args.member,
      workflowId: args.sourceWorkflow.id,
    }),
    automations: automations.as("copy_automations"),
  };
}

export function workflowCopyVisibleQuery(args: {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
}) {
  return new QueryBuilder()
    .select(getTableColumns(workflows))
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.id, args.workflowId),
        visibleWorkflowCondition(args.member.userId),
      ),
    )
    .limit(1)
    .as("copy_visible");
}

export function copyWebhooksQuery(
  rows: WorkflowCopySource["sourceAutomations"],
) {
  const query = new QueryBuilder()
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
    .orderBy(asc(workflowWebhookAutomations.automationId));
  return query.as("copy_webhooks");
}

function archivedCopyAutomations(
  blueprints: OfficialWorkflowAcceptedRevision["definition"]["blueprints"],
  rows: WorkflowCopySource["sourceAutomations"],
) {
  if (rows.length !== blueprints.length) {
    throw new CopyPreparationConflict(OFFICIAL_COPY_RECONFIGURE_MESSAGE);
  }
  const rowsByBlueprint = new Map(
    rows.map((row) => {
      return [row.officialBlueprintKey, row] as const;
    }),
  );
  const sourceAutomations: (typeof workflowAutomations.$inferSelect)[] = [];
  for (const blueprint of blueprints) {
    const row = rowsByBlueprint.get(blueprint.key);
    if (
      !row ||
      row.officialAppliedFingerprint !== blueprint.fingerprint ||
      row.officialReconciliationStatus !== "current" ||
      row.officialParameterBindings === null
    ) {
      throw new CopyPreparationConflict(OFFICIAL_COPY_RECONFIGURE_MESSAGE);
    }
    if (
      !canCopyInstalledBlueprint(
        blueprint,
        row.officialParameterBindings,
        row.timezone,
      )
    ) {
      throw new CopyPreparationConflict(OFFICIAL_COPY_RECONFIGURE_MESSAGE);
    }
    sourceAutomations.push(row);
  }
  return sourceAutomations;
}

export function officialCopyMaterialization(
  sourceWorkflow: WorkflowRow,
  official: NonNullable<ReturnType<typeof installedOfficialWorkflow>>,
  rows: WorkflowCopySource["sourceAutomations"],
): OfficialCopyMaterialization {
  let sourceAutomations = rows;
  if (official.kind === "builtin") {
    const [row] = rows;
    if (
      rows.length !== 1 ||
      !row ||
      row.kind !== "schedule" ||
      row.scheduleType !== "cron" ||
      row.officialBlueprintKey !== official.builtin.blueprintKey ||
      row.officialAppliedFingerprint !== official.builtin.fingerprint ||
      row.officialReconciliationStatus !== "current" ||
      !isValidTimeZone(row.timezone) ||
      !workflowScheduleSchema.safeParse({
        type: "cron",
        cronExpression: row.cronExpression,
        timezone: row.timezone,
      }).success
    ) {
      throw new CopyPreparationConflict(OFFICIAL_COPY_RECONFIGURE_MESSAGE);
    }
  } else {
    sourceAutomations = archivedCopyAutomations(official.blueprints, rows);
  }
  return {
    sourceWorkflow: {
      ...sourceWorkflow,
      // An editable copy becomes an ordinary Workflow and owns its instructions.
      instruction: official.copyInstruction,
      displayName: official.workflow.displayName,
      description: official.workflow.description,
      archivedOfficialSnapshot: null,
      officialDefinitionName: null,
    },
    sourceAutomations,
    files: official.workflow.files,
  };
}

export function copySourceResult(
  args: WorkflowCopyInput,
  visible: WorkflowRow,
  materialization: OfficialCopyMaterialization | null,
  rows: WorkflowCopySource["sourceAutomations"],
  facts: Pick<WorkflowCopySource, "webhooks" | "observation">,
): { readonly kind: "ok"; readonly source: WorkflowCopySource } {
  return {
    kind: "ok" as const,
    source: {
      observation: facts.observation,
      sourceWorkflow: materialization?.sourceWorkflow ?? visible,
      sourceAutomations: materialization?.sourceAutomations ?? rows,
      webhooks: facts.webhooks,
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
