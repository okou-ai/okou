import {
  CANONICAL_CLAUDE_CONFIG_DIR,
  CANONICAL_CODEX_HOME_DIR,
  PI_SKILLS_ROOT,
  type PreparedExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import {
  contentBundleSchema,
  type ContentBundle,
} from "@okouai/api-contracts/contracts/content-bundle";
import { BUILT_IN_SKILLS } from "@okouai/core/built-in-skills";
import {
  STAFF_SINGLE_AGENT_ORG_ID,
  staffWorkflowCopyId,
} from "@okouai/core/single-agent-migration";
import { workflows } from "@okouai/db/schema/workflow";
import { and, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import { array, object, string, unknown, uuid, type infer as Infer } from "zod";
import { logger } from "../../lib/log";
import {
  memberInstructionsSelectionSql,
  type ExecutionPackageScope,
} from "./execution-instructions-selection";
import type { OfficialWorkflowObservation } from "./official-workflow-run.service";
import {
  resolveRunSkillVolumes,
  type SkillVolume,
} from "./run-prompt-and-skills";
import { normalizeMountOverlay } from "./storage-mount-overlay";
import type { ThreadAutomationTarget } from "./thread-automation-context.service";

const log = logger("api:execution-workflows");

export const executionPackageSourcesSchema = object({
  memberInstructions: unknown(),
  workflows: array(
    object({ id: uuid(), name: string(), contentBundle: unknown() }),
  ),
});
export type ExecutionPackageSources = Infer<
  typeof executionPackageSourcesSchema
>;

export interface CapturedExecutionPackages {
  readonly workflows: readonly {
    readonly name: string;
    readonly contentBundle: ContentBundle;
    readonly optional: true | undefined;
  }[];
  readonly instructionsBundle: ContentBundle;
}

/**
 * Shared projection for prompt picks and the Automation target statement.
 * Mount exclusions apply to the captured winner for each Workflow name.
 */
export function executionPackageSourcesSql(scope: ExecutionPackageScope) {
  return sql`(
    WITH selected_workflows AS (
      SELECT DISTINCT ON (${workflows.name}) ${workflows.id} AS id,
        ${workflows.name} AS name, ${workflows.contentBundle} AS "contentBundle"
      FROM ${workflows}
      WHERE ${and(
        eq(workflows.orgId, scope.orgId),
        eq(workflows.agentId, scope.agentId),
        isNull(workflows.officialDefinitionName),
        or(
          eq(workflows.visibility, "public"),
          eq(workflows.ownerUserId, scope.userId),
        ),
        notInArray(workflows.name, [...BUILT_IN_SKILLS]),
      )}
      ORDER BY ${workflows.name},
        (${workflows.visibility} = 'private' AND ${workflows.ownerUserId} = ${scope.userId}) DESC,
        ${workflows.createdAt}, ${workflows.id}
    )
    SELECT jsonb_build_object(
      'memberInstructions', ${memberInstructionsSelectionSql(scope)},
      'workflows', (SELECT COALESCE(jsonb_agg(to_jsonb(selected_workflows) ORDER BY name), '[]'::jsonb)
        FROM selected_workflows)
    )
  )`;
}

export function resolveOrdinaryAutomationWorkflowName(
  target: Pick<ThreadAutomationTarget, "automation" | "workflow">,
  scope: ExecutionPackageScope,
  sources: ExecutionPackageSources,
): string | null {
  const { automation, workflow } = target;
  if (
    automation.orgId !== scope.orgId ||
    automation.ownerUserId !== scope.userId ||
    workflow.orgId !== scope.orgId ||
    workflow.officialDefinitionName !== null
  ) {
    return null;
  }
  const selected = sources.workflows.find(({ id }) => {
    return id === workflow.id;
  });
  if (selected) {
    return selected.name;
  }
  // Pre-cutover queued input can still mount the authorized legacy winner
  // after its Automation has been moved to that Workflow's stable copy.
  if (scope.orgId !== STAFF_SINGLE_AGENT_ORG_ID) {
    return null;
  }
  const legacy = sources.workflows.find(({ id }) => {
    return staffWorkflowCopyId(id) === workflow.id;
  });
  return legacy?.name ?? null;
}

/** Choose and decode the packages for the Run from its first source observation. */
export function selectExecutionPackages(
  sources: ExecutionPackageSources | null,
  input: {
    readonly singleAgent: boolean;
    readonly agentInstructions: ContentBundle | null;
    readonly skillRoot: string;
    readonly protectedMountPaths: readonly string[];
    readonly ordinaryAutomation: Pick<
      ThreadAutomationTarget,
      "ordinaryWorkflowName"
    > | null;
  },
): CapturedExecutionPackages | { readonly error: string } {
  if (!sources) {
    return { error: "Run package source authorization is unavailable" };
  }
  const protectedPaths = new Set(input.protectedMountPaths);
  const isProtected = (name: string) => {
    return protectedPaths.has(`${input.skillRoot}/${name}`);
  };
  const requiredWorkflow = input.ordinaryAutomation?.ordinaryWorkflowName;
  const instructionsBundle = contentBundleSchema.safeParse(
    input.singleAgent ? sources.memberInstructions : input.agentInstructions,
  );
  if (!instructionsBundle.success) {
    return { error: "Run Instructions package is unavailable" };
  }
  const selectedWorkflows: CapturedExecutionPackages["workflows"][number][] =
    [];
  for (const workflow of sources.workflows) {
    if (isProtected(workflow.name)) {
      continue;
    }
    const contentBundle = contentBundleSchema.safeParse(workflow.contentBundle);
    if (!contentBundle.success) {
      log.warn("Workflow Skill bundle is unavailable", {
        workflowId: workflow.id,
      });
      continue;
    }
    selectedWorkflows.push({
      name: workflow.name,
      contentBundle: contentBundle.data,
      optional: workflow.name === requiredWorkflow ? undefined : true,
    });
  }
  if (
    input.ordinaryAutomation &&
    !selectedWorkflows.some(({ optional }) => {
      return !optional;
    })
  ) {
    return { error: "The Automation's Workflow package is unavailable" };
  }
  return {
    instructionsBundle: instructionsBundle.data,
    workflows: selectedWorkflows,
  };
}

/** Resolve package destinations for this Run's accepted launch framework. */
export function prepareRunPackageMounts(args: {
  readonly framework: PreparedExecutionContext["cliAgentType"];
  readonly skillVolumes: readonly SkillVolume[];
  readonly officialWorkflow: OfficialWorkflowObservation | undefined;
}) {
  const skillRoot =
    args.framework === "pi"
      ? PI_SKILLS_ROOT
      : args.framework === "codex"
        ? `${CANONICAL_CODEX_HOME_DIR}/skills`
        : `${CANONICAL_CLAUDE_CONFIG_DIR}/skills`;
  const skillMounts = normalizeMountOverlay(
    resolveRunSkillVolumes(args.skillVolumes, skillRoot),
  );
  return {
    skillRoot,
    skillMounts,
    protectedMountPaths: skillMounts.flatMap((mount) => {
      return "templateGuidanceBundle" in mount ? [mount.mountPath] : [];
    }),
    officialWorkflowBundles:
      args.officialWorkflow?.definitions.map(({ name, contentBundle }) => {
        return { ...contentBundle, mountPath: `${skillRoot}/${name}` };
      }) ?? [],
  };
}
