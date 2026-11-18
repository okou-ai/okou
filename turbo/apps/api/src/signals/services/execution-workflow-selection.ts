import { and, eq, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import {
  object as zObject,
  uuid as zUuid,
  string as zString,
  type infer as zInfer,
} from "zod";
import type { PreparedExecutionContext } from "@okouai/api-contracts/contracts/runners";
import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { agents } from "@okouai/db/schema/agent";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { contentBundleAvailableCondition } from "./execution-content-bundle";
import {
  STAFF_SINGLE_AGENT_ORG_ID,
  STAFF_WORKFLOW_COPY_NAMESPACE,
} from "@okouai/core/single-agent-migration";

export const executionWorkflowSchema = zObject({
  id: zUuid(),
  name: zString(),
  contentBundle: contentBundleSchema,
});
export type ExecutionWorkflow = zInfer<typeof executionWorkflowSchema>;

/**
 * Temporary compatibility for legacy Runs admitted before the staff cutover.
 * Their captured Agent and source Workflow remain authorized and immutable; the
 * live Automation now points at the stable copy. Never broaden source access.
 * Retire after all pre-cutover pending/active Runs have drained.
 */
function retainedStaffWorkflowAdmission(): SQL {
  return sql`(admitted_run."orgId" = ${STAFF_SINGLE_AGENT_ORG_ID}
    AND EXISTS (SELECT 1 FROM workflows AS legacy_workflow
      JOIN selected_workflows AS selected ON selected.id = legacy_workflow.id
      WHERE legacy_workflow.org_id = admitted_run."orgId"
        AND legacy_workflow.agent_id = admitted_run."agentId"
        AND overlay(overlay(md5(${STAFF_WORKFLOW_COPY_NAMESPACE} || legacy_workflow.id::text)
          placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid = ${workflows.id}))`;
}

export interface ExecutionWorkflowInput {
  readonly selection: PreparedExecutionContext["customWorkflowSelection"];
  readonly skillRoot: string;
}

export function assertOfficialWorkflowMounts(
  officialBundles: readonly { readonly mountPath: string }[],
  storageMounts: readonly { readonly mountPath: string }[],
  skillRoot: string,
): void {
  const officialPaths = officialBundles.map((bundle) => {
    return bundle.mountPath;
  });
  if (
    new Set(officialPaths).size !== officialPaths.length ||
    officialPaths.some((path) => {
      return (
        !path.startsWith(`${skillRoot}/`) ||
        storageMounts.some((mount) => {
          return mount.mountPath === path;
        })
      );
    })
  ) {
    throw new Error("Official Workflow bundle destinations are inconsistent");
  }
}

export function executionSkillRoot(
  framework: PreparedExecutionContext["cliAgentType"],
): string {
  return framework === "pi"
    ? "/home/user/.pi/agent/skills"
    : framework === "codex"
      ? "/home/user/.codex/skills"
      : "/home/user/.claude/skills";
}

function workflowEligibilitySql(input: ExecutionWorkflowInput): SQL {
  const protectedPaths = input.selection.protectedMountPaths;
  return sql`${eq(workflows.orgId, sql`admitted_run."orgId"`)}
    AND ${eq(workflows.agentId, sql`admitted_run."agentId"`)}
    AND ${eq(agents.orgId, sql`admitted_run."orgId"`)}
    AND (${eq(agents.visibility, "public")} OR ${eq(agents.owner, sql`admitted_run."userId"`)})
    AND ${isNull(workflows.officialDefinitionName)}
    AND (${eq(workflows.visibility, "public")} OR ${eq(workflows.ownerUserId, sql`admitted_run."userId"`)})
    AND ${notInArray(workflows.name, [...SEED_SKILLS])}
    AND NOT (${JSON.stringify(protectedPaths)}::jsonb ? (${input.skillRoot} || '/' || ${workflows.name}))`;
}

/** Select authorized Workflow packages from the Run's initial source unit. */
export function executionWorkflowSelectionSql(
  input: ExecutionWorkflowInput,
): SQL {
  const selection = input.selection;
  const eligible = workflowEligibilitySql(input);
  return sql`selected_workflows AS MATERIALIZED (
      SELECT DISTINCT ON (${workflows.name}) ${workflows.id} AS id, ${workflows.name} AS name,
        ${workflows.contentBundle} AS "contentBundle"
      FROM ${workflows} INNER JOIN ${agents} ON ${eq(agents.id, workflows.agentId)} CROSS JOIN admitted_run
      WHERE ${eligible}
      ORDER BY ${workflows.name}, (${workflows.visibility} = 'private' AND ${workflows.ownerUserId} = admitted_run."userId") DESC, ${workflows.createdAt}, ${workflows.id}
    ), workflow_selection AS MATERIALIZED (
      SELECT COALESCE(jsonb_agg(to_jsonb(selected_workflows)), '[]'::jsonb) AS documents,
        COALESCE(bool_and(${contentBundleAvailableCondition(sql`selected_workflows."contentBundle"`)}), true) AS "bundlesAvailable"
      FROM selected_workflows
    ), workflow_admission AS MATERIALIZED (
      SELECT * FROM workflow_selection, admitted_run
      WHERE admitted_run."agentId" = ${selection.agentId}::uuid
        AND EXISTS (SELECT 1 FROM selected_agent)
        AND (admitted_run."workflowAutomationId" IS NULL OR EXISTS (
          SELECT 1 FROM ${workflowAutomations} INNER JOIN ${workflows} ON ${eq(workflows.id, workflowAutomations.workflowId)}
          WHERE ${and(eq(workflowAutomations.id, sql`admitted_run."workflowAutomationId"`), eq(workflowAutomations.orgId, sql`admitted_run."orgId"`), eq(workflowAutomations.ownerUserId, sql`admitted_run."userId"`), eq(workflows.orgId, sql`admitted_run."orgId"`))}
            AND ((${workflows.agentId} = admitted_run."agentId" AND ((${workflows.officialDefinitionName} IS NOT NULL AND ${workflows.officialInstallationState} = 'installed') OR EXISTS (SELECT 1 FROM selected_workflows WHERE id = ${workflows.id})))
              OR ${retainedStaffWorkflowAdmission()})
        ))
    )`;
}
