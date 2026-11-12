import { and, eq, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
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
import { contentBundleAvailableCondition } from "./content-bundle-claim";
import {
  STAFF_SINGLE_AGENT_ORG_ID,
  STAFF_WORKFLOW_COPY_NAMESPACE,
} from "@okouai/core/staff-single-agent-migration";

export const claimedWorkflowSchema = zObject({
  id: zUuid(),
  name: zString(),
  contentBundle: contentBundleSchema,
});
export type ClaimedWorkflow = zInfer<typeof claimedWorkflowSchema>;

/**
 * Temporary compatibility for legacy Runs admitted before the staff cutover.
 * Their captured Agent and source Workflow remain authorized and immutable; the
 * live Automation now points at the stable copy. Never broaden source access.
 * Retire after all pre-cutover pending/active Runs have drained.
 */
function retainedStaffWorkflowAdmission(): SQL {
  return sql`(locked_run."orgId" = ${STAFF_SINGLE_AGENT_ORG_ID}
    AND EXISTS (SELECT 1 FROM workflows AS legacy_workflow
      JOIN selected_workflows AS selected ON selected.id = legacy_workflow.id
      WHERE legacy_workflow.org_id = locked_run."orgId"
        AND legacy_workflow.agent_id = locked_run."agentId"
        AND overlay(overlay(md5(${STAFF_WORKFLOW_COPY_NAMESPACE} || legacy_workflow.id::text)
          placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid = ${workflows.id}))`;
}

export interface WorkflowClaimInput {
  readonly selection: PreparedExecutionContext["customWorkflowSelection"];
  readonly skillRoot: string;
  readonly ambiguousMountPaths: readonly string[];
}

function officialWorkflowClaimSelection(
  context: PreparedExecutionContext,
  skillRoot: string,
): WorkflowClaimInput["selection"] {
  const officialPaths = (context.officialWorkflowBundles ?? []).map(
    (bundle) => {
      return bundle.mountPath;
    },
  );
  if (
    new Set(officialPaths).size !== officialPaths.length ||
    officialPaths.some((path) => {
      return (
        !path.startsWith(`${skillRoot}/`) ||
        context.storageMounts.some((mount) => {
          return mount.mountPath === path;
        })
      );
    })
  ) {
    throw new Error("Official Workflow bundle destinations are inconsistent");
  }
  return context.customWorkflowSelection && officialPaths.length > 0
    ? {
        ...context.customWorkflowSelection,
        protectedMountPaths: [
          ...(context.customWorkflowSelection.protectedMountPaths ?? []),
          ...officialPaths,
        ],
      }
    : context.customWorkflowSelection;
}

export function workflowClaimInput(
  context: PreparedExecutionContext,
): WorkflowClaimInput {
  const skillRoot =
    context.cliAgentType === "pi"
      ? "/home/user/.pi/agent/skills"
      : context.cliAgentType === "codex"
        ? "/home/user/.codex/skills"
        : "/home/user/.claude/skills";
  const selection = officialWorkflowClaimSelection(context, skillRoot);
  const ordinaryMount = /^custom-skill@[a-f0-9-]{36}$/u;
  for (const mount of context.storageMounts) {
    if (
      mount.name.startsWith("custom-skill@") &&
      !ordinaryMount.test(mount.name)
    ) {
      throw new Error("Unsupported legacy Workflow identity");
    }
  }
  const otherMounts = context.storageMounts.filter((mount) => {
    return !ordinaryMount.test(mount.name);
  });
  return {
    selection,
    skillRoot,
    // Stage 1 captured Agent identity, but not source precedence. A collision
    // with an unclassified old mount is rejected rather than guessed by slug.
    ambiguousMountPaths:
      context.customWorkflowSelection?.protectedMountPaths === undefined
        ? otherMounts.map((mount) => {
            return mount.mountPath;
          })
        : [],
  };
}

/**
 * Data only: consumed by the existing successful Run/thread claim statement.
 * The outgoing Stage 1 writer commits body + reservation before its package.
 * Its exact pending token blocks a mixed-generation claim during API drain.
 * Remove that token read with the Stage 3 publication bridge retirement.
 */
export function workflowClaimSelectionSql(input: WorkflowClaimInput): SQL {
  const selection = input.selection;
  const automationId = selection?.automationId ?? null;
  const protectedPaths = selection?.protectedMountPaths ?? [];
  const eligible = and(
    eq(workflows.orgId, sql`locked_run."orgId"`),
    eq(workflows.agentId, sql`locked_run."agentId"`),
    eq(agents.orgId, sql`locked_run."orgId"`),
    or(
      eq(agents.visibility, "public"),
      eq(agents.owner, sql`locked_run."userId"`),
    ),
    isNull(workflows.officialDefinitionName),
    or(
      eq(workflows.visibility, "public"),
      eq(workflows.ownerUserId, sql`locked_run."userId"`),
    ),
    notInArray(workflows.name, [...SEED_SKILLS]),
    sql`NOT (${JSON.stringify(protectedPaths)}::jsonb ? (${input.skillRoot} || '/' || ${workflows.name}))`,
  );
  return sql`selected_workflows AS MATERIALIZED (
      SELECT DISTINCT ON (${workflows.name}) ${workflows.id} AS id, ${workflows.name} AS name,
        ${workflows.contentBundle} AS "contentBundle"
      FROM ${workflows} INNER JOIN ${agents} ON ${eq(agents.id, workflows.agentId)} CROSS JOIN locked_run
      WHERE ${eligible}
      ORDER BY ${workflows.name}, (${workflows.visibility} = 'private' AND ${workflows.ownerUserId} = locked_run."userId") DESC, ${workflows.createdAt}, ${workflows.id}
    ), workflow_selection AS MATERIALIZED (
      SELECT COALESCE(jsonb_agg(to_jsonb(selected_workflows)), '[]'::jsonb) AS documents,
        COALESCE(bool_and(NOT (${JSON.stringify(input.ambiguousMountPaths)}::jsonb ? (${input.skillRoot} || '/' || name))), true) AS available,
        COALESCE(bool_and(${contentBundleAvailableCondition(sql`selected_workflows."contentBundle"`)}), true) AS "bundlesAvailable"
      FROM selected_workflows
    ), workflow_admission AS MATERIALIZED (
      SELECT * FROM workflow_selection, locked_run
      WHERE workflow_selection.available AND (
        locked_run."agentId" IS NULL OR (
          locked_run."agentId" = ${selection?.agentId ?? null}::uuid
          AND (NOT ${selection?.protectedMountPaths === undefined}
            OR locked_run."triggerSource" NOT IN ('automation-schedule', 'automation-event')
            OR locked_run."workflowAutomationId" IS NOT NULL)
          AND EXISTS (SELECT 1 FROM selected_agent)
          AND (COALESCE(${automationId}::uuid, locked_run."workflowAutomationId") IS NULL OR EXISTS (
            SELECT 1 FROM ${workflowAutomations} INNER JOIN ${workflows} ON ${eq(workflows.id, workflowAutomations.workflowId)}
            WHERE ${and(eq(workflowAutomations.id, sql`COALESCE(${automationId}::uuid, locked_run."workflowAutomationId")`), eq(workflowAutomations.orgId, sql`locked_run."orgId"`), eq(workflowAutomations.ownerUserId, sql`locked_run."userId"`), eq(workflows.orgId, sql`locked_run."orgId"`))}
              AND ((${workflows.agentId} = locked_run."agentId" AND ((${workflows.officialDefinitionName} IS NOT NULL AND ${workflows.officialInstallationState} = 'installed') OR EXISTS (SELECT 1 FROM selected_workflows WHERE id = ${workflows.id})))
                OR ${retainedStaffWorkflowAdmission()})
          ))
        )
      )
    )`;
}
