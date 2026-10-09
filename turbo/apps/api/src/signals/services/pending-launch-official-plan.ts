import { z } from "zod";
import { asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { officialWorkflowCatalogState } from "@okouai/db/schema/official-workflow-catalog";
import { workflows, workflowAutomations } from "@okouai/db/schema/workflow";
import type { OfficialWorkflowAcceptedDefinition } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { conflict } from "../../lib/error";
import {
  OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
  type AcceptedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-read.service";
import {
  artifactMatches,
  blueprintIdentities,
  blueprintIdentitiesMatch,
  acceptedDefinitionForName,
  acceptedRevisionsMatchDefinitions,
  lockedInstallationMatches,
  exactMountsMatch,
  OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE,
} from "./official-workflow-run.service";
import {
  pendingCreditPlanSql,
  pendingCreditPlanRowSchema,
  pendingCreditPlanResult,
} from "./pending-launch-credit-plan";
import {
  pendingLaunchAdmissionStart,
  advancePendingLaunchAdmission,
  pendingAdmissionRecordSchema,
  type PendingAdmissionProgress,
} from "./pending-launch-admission-plan";
import type { PreparedCommitPreparedLaunchArgs } from "./thread-claim-run.service";

const officialRowSchema = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("catalog-lock"),
    authority: z.string(),
    releaseId: z.string(),
  }),
  z.object({
    phase: z.literal("installation"),
    id: z.string(),
    orgId: z.string(),
    agentId: z.string(),
    name: z.string(),
    visibility: z.string(),
    ownerUserId: z.string(),
    officialDefinitionName: z.string().nullable(),
    officialInstallationState: z.string().nullable(),
  }),
  z.object({
    phase: z.literal("automation"),
    id: z.string(),
    orgId: z.string(),
    workflowId: z.string(),
    ownerUserId: z.string(),
    blueprintKey: z.string().nullable(),
    appliedFingerprint: z.string().nullable(),
    reconciliationStatus: z.string().nullable(),
    definitionName: z.string().nullable(),
  }),
]);
export const pendingLaunchAdmissionRowSchema = z.union([
  officialRowSchema,
  pendingCreditPlanRowSchema,
  pendingAdmissionRecordSchema,
]);
type Record = z.output<typeof pendingLaunchAdmissionRowSchema>;
type OfficialRecord = z.output<typeof officialRowSchema>;
type OrdinaryRecord = z.output<typeof pendingAdmissionRecordSchema>;
interface OfficialStatement {
  readonly kind: "statement";
  readonly phase:
    "catalog-lock" | "credit-plan" | "installation" | "automation";
  readonly sql: SQL;
  readonly catalog: AcceptedOfficialWorkflowCatalog | null;
  readonly accepted: readonly OfficialWorkflowAcceptedDefinition[];
}
type PendingLaunchAdmissionProgress =
  PendingAdmissionProgress | OfficialStatement;
type Statement = Extract<
  PendingLaunchAdmissionProgress,
  { readonly kind: "statement" }
>;

/** Catalog SHARE -> credit-plan UPDATE -> installations UPDATE -> automation UPDATE.
 * Every phase occurs at most once, and all execution remains in the command. */
export function pendingOfficialAdmissionStart(
  args: PreparedCommitPreparedLaunchArgs,
): PendingLaunchAdmissionProgress {
  if (!args.context.officialWorkflowRun) {
    return pendingLaunchAdmissionStart(args);
  }
  return {
    kind: "statement",
    phase: "catalog-lock",
    catalog: null,
    accepted: [],
    sql: sql`SELECT 'catalog-lock' AS phase, ${officialWorkflowCatalogState.authority} AS authority, ${officialWorkflowCatalogState.acceptedReleaseId} AS "releaseId"
      FROM ${officialWorkflowCatalogState} WHERE ${eq(officialWorkflowCatalogState.authority, OFFICIAL_WORKFLOW_CATALOG_AUTHORITY)} FOR SHARE`,
  };
}

function failedOfficial() {
  return conflict(OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE);
}

function installationRead(
  args: PreparedCommitPreparedLaunchArgs,
  step: OfficialStatement,
): OfficialStatement {
  const observation = args.context.officialWorkflowRun;
  if (!observation) {
    throw new Error("Official admission requires captured provenance");
  }
  return {
    ...step,
    phase: "installation",
    sql: sql`SELECT 'installation' AS phase,
    ${workflows.id} AS id, ${workflows.orgId} AS "orgId", ${workflows.agentId} AS "agentId", ${workflows.name} AS name,
    ${workflows.visibility} AS visibility, ${workflows.ownerUserId} AS "ownerUserId", ${workflows.officialDefinitionName} AS "officialDefinitionName", ${workflows.officialInstallationState} AS "officialInstallationState"
    FROM ${workflows} WHERE ${inArray(
      workflows.id,
      observation.definitions.map((definition) => {
        return definition.workflowId;
      }),
    )}
    ORDER BY ${asc(workflows.id)} FOR UPDATE`,
  };
}

function acceptedInstallations(
  args: PreparedCommitPreparedLaunchArgs,
  step: OfficialStatement,
  rows: readonly OfficialRecord[],
) {
  const observation = args.context.officialWorkflowRun;
  const catalog = step.catalog;
  if (!observation || !catalog) {
    throw new Error("Official admission requires accepted catalog facts");
  }
  const installed = rows.filter((row) => {
    return row.phase === "installation";
  });
  if (installed.length !== observation.definitions.length) {
    return null;
  }
  const byId = new Map(
    installed.map((row) => {
      return [row.id, row] as const;
    }),
  );
  const accepted: OfficialWorkflowAcceptedDefinition[] = [];
  for (const expected of observation.definitions) {
    const row = byId.get(expected.workflowId);
    const definition = acceptedDefinitionForName(
      catalog.payload.definitions,
      expected.name,
    );
    if (
      !row ||
      !lockedInstallationMatches(expected, row, {
        orgId: args.createArgs.orgId,
        userId: args.createArgs.userId,
        agentId: args.context.resolved.agentId,
      }) ||
      !definition ||
      definition.revision !== expected.revision ||
      !artifactMatches(expected.artifact, definition.artifact) ||
      !blueprintIdentitiesMatch(
        expected.blueprints,
        blueprintIdentities(definition),
      )
    ) {
      return null;
    }
    accepted.push(definition);
  }
  return accepted;
}

function finishRevisions(
  args: PreparedCommitPreparedLaunchArgs,
  step: OfficialStatement,
): PendingLaunchAdmissionProgress {
  const revisions = args.context.officialWorkflowFacts?.revisions;
  if (!revisions) {
    return failedOfficial();
  }
  const ordered = step.accepted.map((definition) => {
    return (
      revisions.get(JSON.stringify([definition.name, definition.revision])) ??
      null
    );
  });
  const observation = args.context.officialWorkflowRun;
  if (
    !observation ||
    !acceptedRevisionsMatchDefinitions(step.accepted, ordered) ||
    !exactMountsMatch(observation, args.launch.runStorageMounts)
  ) {
    return failedOfficial();
  }
  const id = args.createArgs.agentRunMetadata?.workflowAutomationId;
  if (!id) {
    return pendingLaunchAdmissionStart(args);
  }
  return {
    ...step,
    phase: "automation",
    sql: sql`SELECT 'automation' AS phase,
    ${workflowAutomations.id} AS id, ${workflowAutomations.orgId} AS "orgId", ${workflowAutomations.workflowId} AS "workflowId", ${workflowAutomations.ownerUserId} AS "ownerUserId", ${workflowAutomations.officialBlueprintKey} AS "blueprintKey",
    ${workflowAutomations.officialAppliedFingerprint} AS "appliedFingerprint", ${workflowAutomations.officialReconciliationStatus} AS "reconciliationStatus", ${workflows.officialDefinitionName} AS "definitionName"
    FROM ${workflowAutomations} INNER JOIN ${workflows} ON ${eq(workflows.id, workflowAutomations.workflowId)} WHERE ${eq(workflowAutomations.id, id)} LIMIT 1 FOR UPDATE`,
  };
}

function automationMatches(
  args: PreparedCommitPreparedLaunchArgs,
  row: Extract<OfficialRecord, { readonly phase: "automation" }> | undefined,
) {
  if (
    !row ||
    row.orgId !== args.createArgs.orgId ||
    row.ownerUserId !== args.createArgs.userId
  ) {
    return false;
  }
  if (row.blueprintKey === null) {
    return row.definitionName === null;
  }
  const definition = args.context.officialWorkflowRun?.definitions.find(
    (candidate) => {
      return candidate.workflowId === row.workflowId;
    },
  );
  if (
    !definition ||
    row.definitionName !== definition.name ||
    row.appliedFingerprint === null ||
    row.reconciliationStatus !== "current"
  ) {
    return false;
  }
  return (
    definition.blueprints.find((candidate) => {
      return candidate.key === row.blueprintKey;
    })?.fingerprint === row.appliedFingerprint
  );
}

function ordinaryStep(
  step: Statement,
): step is Extract<PendingAdmissionProgress, { readonly kind: "statement" }> {
  return (
    step.phase === "thread" ||
    step.phase === "session" ||
    step.phase === "subscription" ||
    step.phase === "head" ||
    step.phase === "claim"
  );
}
function ordinaryRecord(row: Record): row is OrdinaryRecord {
  return (
    !("caps" in row) &&
    (!("phase" in row) ||
      row.phase === "thread" ||
      row.phase === "session" ||
      row.phase === "subscription" ||
      row.phase === "head")
  );
}
function officialRecord(row: Record): row is OfficialRecord {
  return (
    "phase" in row &&
    (row.phase === "catalog-lock" ||
      row.phase === "installation" ||
      row.phase === "automation")
  );
}

export function advancePendingOfficialAdmission(
  args: PreparedCommitPreparedLaunchArgs,
  step: Statement,
  records: readonly Record[],
): PendingLaunchAdmissionProgress {
  if (ordinaryStep(step)) {
    return advancePendingLaunchAdmission(
      args,
      step,
      records.filter(ordinaryRecord),
    );
  }
  const rows = records.filter(officialRecord);
  switch (step.phase) {
    case "catalog-lock": {
      const row = rows.find((candidate) => {
        return candidate.phase === "catalog-lock";
      });
      const catalog = args.context.officialWorkflowFacts?.catalog;
      if (
        !row ||
        !catalog ||
        row.releaseId !== catalog.releaseId ||
        catalog.releaseId !== args.context.officialWorkflowRun?.releaseId
      ) {
        return failedOfficial();
      }
      const acceptedStep = { ...step, catalog };
      return args.enforceBuiltInCredits
        ? {
            ...acceptedStep,
            phase: "credit-plan",
            sql: pendingCreditPlanSql(args.createArgs.orgId),
          }
        : installationRead(args, acceptedStep);
    }
    case "credit-plan": {
      pendingCreditPlanResult(
        records.filter((row) => {
          return "caps" in row;
        }),
        args.createArgs.orgId,
      );
      return installationRead(args, step);
    }
    case "installation": {
      const accepted = acceptedInstallations(args, step, rows);
      return accepted
        ? finishRevisions(args, { ...step, accepted })
        : failedOfficial();
    }
    case "automation": {
      return automationMatches(
        args,
        rows.find((row) => {
          return row.phase === "automation";
        }),
      )
        ? pendingLaunchAdmissionStart(args)
        : failedOfficial();
    }
  }
}
