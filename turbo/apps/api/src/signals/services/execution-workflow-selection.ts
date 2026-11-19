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
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import {
  STAFF_SINGLE_AGENT_ORG_ID,
  staffWorkflowCopyId,
} from "@okouai/core/single-agent-migration";
import { workflows } from "@okouai/db/schema/workflow";
import { and, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import { array, object, string, unknown, uuid, type infer as Infer } from "zod";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import {
  agentInstructionsSelectionSql,
  type ExecutionPackageScope,
} from "./execution-instructions-selection";
import type { OfficialWorkflowObservation } from "./official-workflow-run.service";
import {
  resolveRunSkillVolumes,
  type SkillVolume,
} from "./run-prompt-and-skills";
import { normalizeMountOverlay } from "./storage-mount-overlay";
import type { ThreadAutomationTarget } from "./thread-context.signals";

export const executionPackageSourcesSchema = object({
  agentInstructions: unknown(),
  memberInstructions: unknown(),
  workflows: array(
    object({ id: uuid(), name: string(), contentBundle: unknown() }),
  ),
});
export type ExecutionPackageSources = Infer<
  typeof executionPackageSourcesSchema
>;

export const executionPackageSourcesDecoder = zodDriverValueDecoder(
  executionPackageSourcesSchema,
);

export interface ExecutionWorkflow {
  readonly id: string;
  readonly name: string;
  readonly contentBundle: ContentBundle;
}

export interface CapturedExecutionPackages {
  readonly workflows: readonly ExecutionWorkflow[];
  readonly instructionsBundle: ContentBundle;
}

/**
 * Shared projection for prompt picks and the Automation target statement.
 * Capture both Instructions references so the read can start before mode
 * selection. Mount exclusions depend on the name and can be applied to the
 * captured winner without reading the other rows of that name again.
 */
export function executionPackageSourcesSql(scope: ExecutionPackageScope) {
  return sql`(
    WITH ${agentInstructionsSelectionSql(scope)}, selected_workflows AS (
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
        notInArray(workflows.name, [...SEED_SKILLS]),
      )}
      ORDER BY ${workflows.name},
        (${workflows.visibility} = 'private' AND ${workflows.ownerUserId} = ${scope.userId}) DESC,
        ${workflows.createdAt}, ${workflows.id}
    )
    SELECT jsonb_build_object(
      'agentInstructions', selected_agent."agentInstructions",
      'memberInstructions', selected_agent."memberInstructions",
      'workflows', (SELECT COALESCE(jsonb_agg(to_jsonb(selected_workflows) ORDER BY name), '[]'::jsonb)
        FROM selected_workflows)
    ) FROM selected_agent
  )`;
}

export function resolveOrdinaryAutomationWorkflowName(
  target: Pick<ThreadAutomationTarget, "automation" | "workflow">,
  scope: ExecutionPackageScope,
  sources: ExecutionPackageSources | null,
): string | null {
  const { automation, workflow } = target;
  if (
    !sources ||
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
    readonly skillRoot: string;
    readonly protectedMountPaths: readonly string[];
    readonly ordinaryAutomation: Pick<
      ThreadAutomationTarget,
      "ordinaryWorkflowName"
    > | null;
  },
): CapturedExecutionPackages | null {
  if (!sources) {
    return null;
  }
  const protectedPaths = new Set(input.protectedMountPaths);
  const isProtected = (name: string) => {
    return protectedPaths.has(`${input.skillRoot}/${name}`);
  };
  if (input.ordinaryAutomation) {
    const name = input.ordinaryAutomation.ordinaryWorkflowName;
    if (name === null || isProtected(name)) {
      return null;
    }
  }
  const instructionsBundle = contentBundleSchema.safeParse(
    input.singleAgent ? sources.memberInstructions : sources.agentInstructions,
  );
  if (!instructionsBundle.success) {
    return null;
  }
  const selectedWorkflows: ExecutionWorkflow[] = [];
  for (const workflow of sources.workflows) {
    if (isProtected(workflow.name)) {
      continue;
    }
    const contentBundle = contentBundleSchema.safeParse(workflow.contentBundle);
    if (!contentBundle.success) {
      return null;
    }
    selectedWorkflows.push({ ...workflow, contentBundle: contentBundle.data });
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
