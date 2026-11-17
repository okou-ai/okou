import type {
  ExecutionContext,
  PreparedExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import {
  templateGuidanceMountPath,
  type TemplateGuidanceBundle,
} from "@okouai/api-contracts/contracts/template-guidance-bundle";
import { command } from "ccstate";
import { nowDate } from "../../lib/time";
import { generateSandboxToken } from "../auth/tokens";
import type { ExecutionContextRun } from "./execution-context";
import type { ExecutionNetworkPolicyInputs } from "./execution-runtime-context";
import {
  signExecutionContentBundle$,
  type ExecutionContentBundleSignature,
} from "./execution-content-bundle";
import type { ContentBundleUrlCacheContext } from "./content-bundle-presigned-url-cache";
import type { StoragePresignedUrlCacheWrite } from "./system-storage-presigned-url-cache.service";
import type {
  ExecutionWorkflowInput,
  ExecutionWorkflow,
} from "./execution-workflow-selection";
import {
  activeNetworkPolicyRefreshesFromGrants,
  mergeNetworkPolicyRefreshes,
  networkPolicyRefreshesRecord,
} from "./user-permission-grants.service";

export interface ExecutionPublicationRun extends ExecutionContextRun {
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly isFirstRun: boolean;
}

export interface ExecutionPackageSelection {
  readonly workflows: readonly ExecutionWorkflow[];
  readonly instructionsBundle: ContentBundle | null;
  readonly cachedBundleUrls: readonly {
    readonly sha256: string;
    readonly url: string;
    readonly expiresAtMs: number;
  }[];
}

type BaseExecutionContext = Omit<
  ExecutionContext,
  "contentBundles" | "storageManifest"
> & {
  readonly storageManifest: NonNullable<ExecutionContext["storageManifest"]>;
};

function withContentBundleMounts(
  executionContext: BaseExecutionContext,
  contentBundles: ExecutionContext["contentBundles"],
): ExecutionContext {
  const bundledMountPaths = new Set([
    ...contentBundles.skills.map((skill) => {
      return skill.mountPath;
    }),
    ...(contentBundles.templates ?? []).map(templateGuidanceMountPath),
  ]);
  return {
    ...executionContext,
    contentBundles,
    storageManifest: {
      storageMounts: executionContext.storageManifest.storageMounts.filter(
        (mount) => {
          return !bundledMountPaths.has(mount.mountPath);
        },
      ),
    },
  };
}

interface ExecutionContentBundlesInput {
  readonly executionContext: BaseExecutionContext;
  readonly packages: ExecutionPackageSelection;
  readonly workflowInput: ExecutionWorkflowInput;
  readonly officialWorkflowBundles: PreparedExecutionContext["officialWorkflowBundles"];
  readonly seedSkillBundles: PreparedExecutionContext["seedSkillBundles"];
  readonly templateGuidanceBundles: PreparedExecutionContext["templateGuidanceBundles"];
  readonly bundleUrlCache: ContentBundleUrlCacheContext;
}

const signExecutionContentBundles$ = command(
  async (
    { set },
    args: ExecutionContentBundlesInput,
    signal: AbortSignal,
  ): Promise<{
    readonly contentBundles: ExecutionContext["contentBundles"];
    readonly cacheWrites: readonly StoragePresignedUrlCacheWrite[];
  }> => {
    const cachedUrls = new Map(
      args.packages.cachedBundleUrls.map((row) => {
        return [row.sha256, row];
      }),
    );
    const signatures = new Map<
      string,
      Promise<ExecutionContentBundleSignature>
    >();
    const signBundle = (
      reference: ContentBundle | TemplateGuidanceBundle,
    ): Promise<ExecutionContentBundleSignature> => {
      const identity = `${reference.sha256}:${reference.archiveBytes}`;
      const pending = signatures.get(identity);
      if (pending) {
        return pending;
      }
      const signed = set(
        signExecutionContentBundle$,
        {
          reference,
          cache: args.bundleUrlCache,
          cached: cachedUrls.get(reference.sha256),
        },
        signal,
      );
      signatures.set(identity, signed);
      return signed;
    };
    const signedInstructions =
      args.packages.instructionsBundle === null
        ? undefined
        : await signBundle(args.packages.instructionsBundle);
    const instructions = signedInstructions?.bundle;
    const workflowMountPaths = new Set(
      args.packages.workflows.map((workflow) => {
        return `${args.workflowInput.skillRoot}/${workflow.name}`;
      }),
    );
    const skills = await Promise.all(
      [
        ...args.packages.workflows.map((workflow) => {
          return {
            contentBundle: workflow.contentBundle,
            mountPath: `${args.workflowInput.skillRoot}/${workflow.name}`,
          };
        }),
        ...[
          ...args.officialWorkflowBundles,
          // Selected Workflows take precedence over seed skills at the same path.
          ...args.seedSkillBundles.filter((bundle) => {
            return !workflowMountPaths.has(bundle.mountPath);
          }),
        ].map((bundle) => {
          return {
            contentBundle: bundle,
            mountPath: bundle.mountPath,
          };
        }),
      ].map(async (bundle) => {
        return {
          ...(await signBundle(bundle.contentBundle)).bundle,
          mountPath: bundle.mountPath,
        };
      }),
    );
    signal.throwIfAborted();
    const templates = await Promise.all(
      args.templateGuidanceBundles.map(async (reference) => {
        const { ownerKind, templateId, beforeMountPaths, ...bundle } =
          reference;
        return {
          ...(await signBundle(bundle)).bundle,
          ownerKind,
          templateId,
          beforeMountPaths,
        };
      }),
    );
    signal.throwIfAborted();
    const signingResults = await Promise.all(signatures.values());
    signal.throwIfAborted();
    const cacheWrites = signingResults.flatMap((result) => {
      return result.cacheWrite ? [result.cacheWrite] : [];
    });
    return {
      contentBundles: {
        format: "tar-gzip-v1",
        instructions,
        skills,
        ...(templates.length ? { templates } : {}),
      },
      cacheWrites,
    };
  },
);

export const withExecutionContentBundles$ = command(
  async ({ set }, args: ExecutionContentBundlesInput, signal: AbortSignal) => {
    const signed = await set(signExecutionContentBundles$, args, signal);
    signal.throwIfAborted();
    const executionContext = withContentBundleMounts(
      args.executionContext,
      signed.contentBundles,
    );
    return { executionContext, cacheWrites: signed.cacheWrites };
  },
);

function secretValuesForRunner(
  preparedContext: PreparedExecutionContext,
): string[] | null {
  const keys = preparedContext.secretValueEnvironmentKeys;
  if (keys === null) {
    return null;
  }

  const environment = {
    ...preparedContext.environment,
    ...preparedContext.platformEnvironment,
  };
  const secretValues: string[] = [];
  for (const key of keys) {
    const value = environment[key];
    if (!Object.hasOwn(environment, key) || typeof value !== "string") {
      throw new Error(
        "Execution secret index references an absent environment key",
      );
    }
    secretValues.push(value);
  }
  return secretValues;
}

type RefreshedExecutionPolicies = Pick<
  PreparedExecutionContext,
  "networkPolicies"
> &
  Pick<ExecutionContext, "networkPolicyRefreshes">;

const prepareExecutionNetworkPolicyRefreshes$ = command(
  async (
    _context,
    args: {
      readonly preparedContext: PreparedExecutionContext;
      readonly networkPolicyInputs: ExecutionNetworkPolicyInputs | null;
    },
  ): Promise<RefreshedExecutionPolicies> => {
    const builtinConnectorSlugs = [
      ...new Set(
        args.preparedContext.connectorRuntimeTargets.flatMap((target) => {
          return target.kind === "builtin" ? [target.connectorSlug] : [];
        }),
      ),
    ];
    if (builtinConnectorSlugs.length === 0) {
      return {
        networkPolicies: args.preparedContext.networkPolicies,
        networkPolicyRefreshes: undefined,
      };
    }
    if (args.networkPolicyInputs === null) {
      throw new Error(
        "Connector network policy refresh requires execution inputs",
      );
    }
    const refreshes = await activeNetworkPolicyRefreshesFromGrants(
      {
        ...args.networkPolicyInputs,
        connectorSlugs: builtinConnectorSlugs,
      },
      nowDate(),
    );
    return {
      networkPolicies: mergeNetworkPolicyRefreshes(
        args.preparedContext.networkPolicies,
        refreshes,
      ),
      networkPolicyRefreshes: networkPolicyRefreshesRecord(refreshes),
    };
  },
);

export function executionContextBody(args: {
  readonly run: ExecutionPublicationRun;
  readonly reuseKey: string;
  readonly preparedContext: PreparedExecutionContext;
  readonly secretValues: ExecutionContext["secretValues"];
  readonly refreshedPolicies: RefreshedExecutionPolicies;
}): BaseExecutionContext {
  const {
    secretValueEnvironmentKeys: _secretValueEnvironmentKeys,
    customWorkflowSelection: _customWorkflowSelection,
    officialWorkflowBundles: _officialWorkflowBundles,
    seedSkillBundles: _seedSkillBundles,
    templateGuidanceBundles: _templateGuidanceBundles,
    storageMounts: _storageMounts,
    featureFlags: _featureFlags,
    ...runnerContext
  } = args.preparedContext;
  return {
    ...runnerContext,
    isFirstRun: args.run.isFirstRun,
    runId: args.run.id,
    reuseKey: args.reuseKey,
    prompt: args.run.prompt,
    appendSystemPrompt: args.run.appendSystemPrompt,
    vars: { ...args.run.vars, ...args.preparedContext.vars },
    storageManifest: {
      storageMounts: args.preparedContext.storageMounts.map((storageMount) => {
        const { orgId: _orgId, userId: _userId, ...mount } = storageMount;
        return mount;
      }),
    },
    sandboxToken: generateSandboxToken(
      args.run.userId,
      args.run.id,
      args.run.orgId,
    ),
    secretValues: args.secretValues,
    connectorRuntimeTargets: args.preparedContext.connectorRuntimeTargets,
    networkPolicies: args.refreshedPolicies.networkPolicies,
    networkPolicyRefreshes: args.refreshedPolicies.networkPolicyRefreshes,
  };
}

export const prepareExecutionPublication$ = command(
  async (
    { set },
    args: {
      readonly preparedContext: PreparedExecutionContext;
      readonly networkPolicyInputs: ExecutionNetworkPolicyInputs | null;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly secretValues: ExecutionContext["secretValues"];
    readonly refreshedPolicies: RefreshedExecutionPolicies;
  }> => {
    // Fallible preparation must finish before durable direct dispatch ownership.
    const secretValues = secretValuesForRunner(args.preparedContext);
    signal.throwIfAborted();
    const refreshedPolicies = await set(
      prepareExecutionNetworkPolicyRefreshes$,
      {
        preparedContext: args.preparedContext,
        networkPolicyInputs: args.networkPolicyInputs,
      },
    );
    signal.throwIfAborted();
    return { secretValues, refreshedPolicies };
  },
);

export function executionBundleHashes(
  context: PreparedExecutionContext,
): string[] {
  return [
    ...context.officialWorkflowBundles,
    ...context.seedSkillBundles,
    ...context.templateGuidanceBundles,
  ].map((bundle) => {
    return bundle.sha256;
  });
}
