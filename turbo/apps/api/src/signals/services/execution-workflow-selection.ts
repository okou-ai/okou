import {
  CANONICAL_CLAUDE_CONFIG_DIR,
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  CANONICAL_CODEX_HOME_DIR,
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  CANONICAL_PI_MEMORY_MOUNT_PATH,
  PI_SKILLS_ROOT,
  type PreparedExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import {
  contentBundleSchema,
  type ContentBundle,
} from "@okouai/api-contracts/contracts/content-bundle";
import { logger } from "../../lib/log";
import type {
  ExecutionPackageScope,
  ExecutionPackageSources,
} from "./execution-package-sources";
import type { NamedSkillBundle } from "./run-prompt-and-skills";
import type { ThreadAutomationTarget } from "./thread-automation-context.service";

const log = logger("api:execution-workflows");

export interface CapturedExecutionPackages {
  readonly workflows: readonly NamedSkillBundle[];
  readonly instructionsBundle: ContentBundle;
}

type SelectedSkillBundle = {
  readonly name: string;
  readonly mount: PreparedExecutionContext["seedSkillBundles"][number];
};

export interface ExecutionPackageMounts {
  readonly seedSkillBundles: readonly SelectedSkillBundle[];
  readonly templateGuidanceBundles: PreparedExecutionContext["templateGuidanceBundles"];
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
  return selected?.name ?? null;
}

/** Choose and decode the packages for the Run from its first source observation. */
export function selectExecutionPackages(
  sources: ExecutionPackageSources | null,
  ordinaryAutomation: Pick<
    ThreadAutomationTarget,
    "ordinaryWorkflowName"
  > | null,
): CapturedExecutionPackages | { readonly error: string } {
  if (!sources) {
    return { error: "Run package source authorization is unavailable" };
  }
  const requiredWorkflow = ordinaryAutomation?.ordinaryWorkflowName;
  const instructionsBundle = contentBundleSchema.safeParse(
    sources.memberInstructions,
  );
  if (!instructionsBundle.success) {
    return { error: "Run Instructions package is unavailable" };
  }
  const selectedWorkflows: CapturedExecutionPackages["workflows"][number][] =
    [];
  for (const workflow of sources.workflows) {
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
    });
  }
  if (
    ordinaryAutomation &&
    !selectedWorkflows.some(({ name }) => {
      return name === requiredWorkflow;
    })
  ) {
    return { error: "The Automation's Workflow package is unavailable" };
  }
  return {
    instructionsBundle: instructionsBundle.data,
    workflows: selectedWorkflows,
  };
}

// Workflow, Skill and Memory paths are recorded for Run diagnostics.
const frameworkMountPaths = {
  "claude-code": {
    skillRoot: `${CANONICAL_CLAUDE_CONFIG_DIR}/skills`,
    memoryMountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  },
  codex: {
    skillRoot: `${CANONICAL_CODEX_HOME_DIR}/skills`,
    memoryMountPath: CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  },
  pi: {
    skillRoot: PI_SKILLS_ROOT,
    memoryMountPath: CANONICAL_PI_MEMORY_MOUNT_PATH,
  },
  // agy has no skill loader; packages and Memory keep the Claude locations
  // that the Claude-compatible run prompt describes.
  antigravity: {
    skillRoot: `${CANONICAL_CLAUDE_CONFIG_DIR}/skills`,
    memoryMountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  },
} as const;

export function prepareRunPackageMounts(args: {
  readonly framework: keyof typeof frameworkMountPaths;
  readonly sources: {
    readonly customConnectorSkills: readonly NamedSkillBundle[];
    readonly systemSkills: readonly NamedSkillBundle[];
    readonly builtinConnectorSkills: readonly NamedSkillBundle[];
    readonly templateGuidanceBundles: ExecutionPackageMounts["templateGuidanceBundles"];
  };
}) {
  const { skillRoot, memoryMountPath } = frameworkMountPaths[args.framework];
  const { sources } = args;
  const seedSkills = new Map<string, NamedSkillBundle>();
  // Built-in connector Skills win over system Skills, then custom connector
  // Skills. Reinsert a winner to keep its position in the source order.
  for (const group of [
    sources.customConnectorSkills,
    sources.systemSkills,
    sources.builtinConnectorSkills,
  ]) {
    for (const bundle of group) {
      seedSkills.delete(bundle.name);
      seedSkills.set(bundle.name, bundle);
    }
  }
  const describeMount = ({ name, contentBundle }: NamedSkillBundle) => {
    return {
      name,
      mount: { ...contentBundle, mountPath: `${skillRoot}/${name}` },
    };
  };
  return {
    memoryMountPath,
    mounts: {
      seedSkillBundles: [...seedSkills.values()].map(describeMount),
      templateGuidanceBundles: sources.templateGuidanceBundles,
    } satisfies ExecutionPackageMounts,
  };
}
