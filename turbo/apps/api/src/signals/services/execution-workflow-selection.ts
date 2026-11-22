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
import type { OfficialWorkflowObservation } from "./official-workflow-run.service";
import {
  resolveRunSkillVolumes,
  type SkillVolume,
} from "./run-prompt-and-skills";
import { normalizeMountOverlay } from "./storage-mount-overlay";
import type { ThreadAutomationTarget } from "./thread-automation-context.service";

const log = logger("api:execution-workflows");

export interface CapturedExecutionPackages {
  readonly workflows: readonly {
    readonly name: string;
    readonly contentBundle: ContentBundle;
  }[];
  readonly instructionsBundle: ContentBundle;
}

export type ExecutionPackageMounts = Pick<
  PreparedExecutionContext,
  "officialWorkflowBundles" | "seedSkillBundles" | "templateGuidanceBundles"
>;

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
  input: {
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
    sources.memberInstructions,
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
    });
  }
  if (
    input.ordinaryAutomation &&
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

// Workflow packages mount under the skills root. Each framework reserves a
// separate Memory destination and applies it after the package mounts.
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
} as const;

export function prepareRunPackageMounts(args: {
  readonly framework: keyof typeof frameworkMountPaths;
  readonly skillVolumes: readonly SkillVolume[];
  readonly officialWorkflow: OfficialWorkflowObservation | undefined;
}) {
  const { skillRoot, memoryMountPath } = frameworkMountPaths[args.framework];
  const packageMounts = normalizeMountOverlay(
    resolveRunSkillVolumes(args.skillVolumes, skillRoot),
  ).filter(({ mountPath }) => {
    return mountPath !== memoryMountPath;
  });
  return {
    skillRoot,
    memoryMountPath,
    protectedMountPaths: packageMounts.flatMap((mount) => {
      return "templateGuidanceBundle" in mount ? [mount.mountPath] : [];
    }),
    mounts: {
      officialWorkflowBundles:
        args.officialWorkflow?.definitions.map(({ name, contentBundle }) => {
          return { ...contentBundle, mountPath: `${skillRoot}/${name}` };
        }) ?? [],
      seedSkillBundles: packageMounts.flatMap((mount) => {
        return "contentBundle" in mount
          ? [{ ...mount.contentBundle, mountPath: mount.mountPath }]
          : [];
      }),
      templateGuidanceBundles: packageMounts.flatMap((mount, index) => {
        if (!("templateGuidanceBundle" in mount)) {
          return [];
        }
        const laterPaths = packageMounts.slice(index + 1).map((later) => {
          return later.mountPath;
        });
        return [
          {
            ...mount.templateGuidanceBundle,
            beforeMountPaths: [...laterPaths, memoryMountPath],
          },
        ];
      }),
    } satisfies ExecutionPackageMounts,
  };
}
