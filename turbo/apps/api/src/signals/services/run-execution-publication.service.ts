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
import { record, string } from "zod";
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
  readonly vars: unknown;
  readonly isFirstRun: boolean | null;
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

const runVarsSchema = record(string(), string()).nullable();
type BaseExecutionContext = Omit<ExecutionContext, "contentBundles">;

function mergeExecutionVars(args: {
  readonly runVars: Record<string, string> | null;
  readonly connectorVars: Record<string, string> | null | undefined;
}): Record<string, string> | null {
  const merged: Record<string, string> = {};
  if (args.runVars) {
    Object.assign(merged, args.runVars);
  }
  if (args.connectorVars) {
    Object.assign(merged, args.connectorVars);
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

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
      storageMounts: (
        executionContext.storageManifest?.storageMounts ?? []
      ).filter((mount) => {
        return (
          !mount.name.startsWith("custom-skill@") &&
          !bundledMountPaths.has(mount.mountPath)
        );
      }),
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
          ...(args.officialWorkflowBundles ?? []),
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
      (args.templateGuidanceBundles ?? []).map(async (reference) => {
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
const prepareExecutionNetworkPolicyRefreshes$ = command(
  async (
    _context,
    args: {
      readonly run: ExecutionPublicationRun;
      readonly preparedContext: PreparedExecutionContext;
      readonly networkPolicyInputs: ExecutionNetworkPolicyInputs | null;
    },
  ): Promise<
    Pick<ExecutionContext, "networkPolicies" | "networkPolicyRefreshes">
  > => {
    assertExecutionConnectorIdentity(args.run, args.preparedContext);
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
    if (args.run.agentId === null || args.networkPolicyInputs === null) {
      throw new Error(
        "Connector network policy refresh requires execution inputs and an Agent identity",
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

function assertExecutionConnectorIdentity(
  run: ExecutionPublicationRun,
  preparedContext: PreparedExecutionContext,
): void {
  if (
    run.agentId === null &&
    preparedContext.connectorRuntimeTargets.length > 0
  ) {
    throw new Error(
      "Runs without an agent cannot use connector runtime targets",
    );
  }
}

export function executionContextBody(args: {
  readonly run: ExecutionPublicationRun;
  readonly reuseKey: string | null;
  readonly preparedContext: PreparedExecutionContext;
  readonly secretValues: ExecutionContext["secretValues"];
  readonly refreshedPolicies: Pick<
    ExecutionContext,
    "networkPolicies" | "networkPolicyRefreshes"
  >;
}): BaseExecutionContext {
  const {
    secretValueEnvironmentKeys: _secretValueEnvironmentKeys,
    customWorkflowSelection: _customWorkflowSelection,
    officialWorkflowBundles: _officialWorkflowBundles,
    seedSkillBundles: _seedSkillBundles,
    templateGuidanceBundles: _templateGuidanceBundles,
    storageMounts: _storedStorageMounts,
    featureFlags: _featureFlags,
    ...runnerStoredContext
  } = args.preparedContext;
  return {
    ...runnerStoredContext,
    ...(args.run.isFirstRun === null
      ? {}
      : { isFirstRun: args.run.isFirstRun }),
    runId: args.run.id,
    reuseKey: args.reuseKey,
    prompt: args.run.prompt,
    appendSystemPrompt: args.run.appendSystemPrompt,
    vars: mergeExecutionVars({
      runVars: runVarsSchema.parse(args.run.vars),
      connectorVars: args.preparedContext.vars,
    }),
    storageManifest: {
      storageMounts: args.preparedContext.storageMounts.map((storedMount) => {
        const { orgId: _orgId, userId: _userId, ...mount } = storedMount;
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
      readonly run: ExecutionPublicationRun;
      readonly preparedContext: PreparedExecutionContext;
      readonly networkPolicyInputs: ExecutionNetworkPolicyInputs | null;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly secretValues: ExecutionContext["secretValues"];
    readonly refreshedPolicies: Pick<
      ExecutionContext,
      "networkPolicies" | "networkPolicyRefreshes"
    >;
  }> => {
    // Fallible preparation must finish before durable direct dispatch ownership.
    const secretValues = secretValuesForRunner(args.preparedContext);
    signal.throwIfAborted();
    const refreshedPolicies = await set(
      prepareExecutionNetworkPolicyRefreshes$,
      {
        run: args.run,
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
    ...(context.officialWorkflowBundles ?? []),
    ...context.seedSkillBundles,
    ...(context.templateGuidanceBundles ?? []),
  ].map((bundle) => {
    return bundle.sha256;
  });
}
