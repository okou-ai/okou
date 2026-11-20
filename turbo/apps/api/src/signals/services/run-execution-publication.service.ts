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
import { generateFirewallToken, generateSandboxToken } from "../auth/tokens";
import type { ExecutionContextRun } from "./execution-runtime-context";
import type { ExecutionNetworkPolicyInputs } from "./admitted-execution-facts";
import {
  signExecutionContentBundle$,
  type ExecutionContentBundleSignature,
} from "./execution-content-bundle";
import type { ContentBundleUrlCacheContext } from "./content-bundle-presigned-url-cache";
import type { StoragePresignedUrlCacheWrite } from "./system-storage-presigned-url-cache.service";
import type { CapturedExecutionPackages } from "./execution-workflow-selection";
import {
  activeNetworkPolicyRefreshesFromGrants,
  mergeNetworkPolicyRefreshes,
  networkPolicyRefreshesRecord,
} from "./connector-network-policy-refresh.service";

export interface ExecutionPublicationRun extends ExecutionContextRun {
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly isFirstRun: boolean;
}

interface ExecutionPackageSelection extends CapturedExecutionPackages {
  readonly cachedBundleUrls: readonly {
    readonly sha256: string;
    readonly url: string;
    readonly expiresAtMs: number;
  }[];
}

interface ExecutionPublicationInput {
  readonly run: ExecutionPublicationRun;
  readonly reuseKey: string;
  readonly preparedContext: PreparedExecutionContext;
  readonly networkPolicyInputs: ExecutionNetworkPolicyInputs | null;
  readonly packages: ExecutionPackageSelection;
  readonly skillRoot: string;
  readonly bundleUrlCache: ContentBundleUrlCacheContext;
}

const signExecutionContentBundles$ = command(
  async (
    { set },
    args: Pick<
      ExecutionPublicationInput,
      "preparedContext" | "packages" | "skillRoot" | "bundleUrlCache"
    >,
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
    const { bundle: instructions } = await signBundle(
      args.packages.instructionsBundle,
    );
    signal.throwIfAborted();
    const workflowMountPaths = new Set(
      args.packages.workflows.map((workflow) => {
        return `${args.skillRoot}/${workflow.name}`;
      }),
    );
    const skills = await Promise.all(
      [
        ...args.packages.workflows.map((workflow) => {
          return {
            contentBundle: workflow.contentBundle,
            mountPath: `${args.skillRoot}/${workflow.name}`,
          };
        }),
        ...[
          ...args.preparedContext.officialWorkflowBundles,
          // Selected Workflows take precedence over seed skills at the same path.
          ...args.preparedContext.seedSkillBundles.filter((bundle) => {
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
      args.preparedContext.templateGuidanceBundles.map(async (reference) => {
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

function secretValuesForRunner(
  preparedContext: PreparedExecutionContext,
): string[] {
  const token = preparedContext.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("API execution requires its Guest OKOU_TOKEN");
  }
  return [token];
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

function executionContextBody(args: {
  readonly run: ExecutionPublicationRun;
  readonly reuseKey: string;
  readonly preparedContext: PreparedExecutionContext;
  readonly secretValues: string[];
  readonly refreshedPolicies: RefreshedExecutionPolicies;
  readonly contentBundles: ExecutionContext["contentBundles"];
  readonly sandboxToken: string;
  readonly firewallToken: string;
}) {
  const {
    officialWorkflowBundles: _officialWorkflowBundles,
    seedSkillBundles: _seedSkillBundles,
    templateGuidanceBundles: _templateGuidanceBundles,
    storageMounts: _storageMounts,
    featureFlags: _featureFlags,
    ...runnerContext
  } = args.preparedContext;
  const bundledMountPaths = new Set([
    ...args.contentBundles.skills.map((skill) => {
      return skill.mountPath;
    }),
    ...(args.contentBundles.templates ?? []).map(templateGuidanceMountPath),
  ]);
  return {
    ...runnerContext,
    contentBundles: args.contentBundles,
    isFirstRun: args.run.isFirstRun,
    runId: args.run.id,
    reuseKey: args.reuseKey,
    prompt: args.run.prompt,
    appendSystemPrompt: args.run.appendSystemPrompt,
    vars: { ...args.run.vars, ...args.preparedContext.vars },
    storageManifest: {
      storageMounts: args.preparedContext.storageMounts
        .filter((mount) => {
          return !bundledMountPaths.has(mount.mountPath);
        })
        .map((storageMount) => {
          const { orgId: _orgId, userId: _userId, ...mount } = storageMount;
          return mount;
        }),
    },
    sandboxToken: args.sandboxToken,
    firewallToken: args.firewallToken,
    secretValues: args.secretValues,
    connectorRuntimeTargets: args.preparedContext.connectorRuntimeTargets,
    networkPolicies: args.refreshedPolicies.networkPolicies,
    networkPolicyRefreshes: args.refreshedPolicies.networkPolicyRefreshes,
  } satisfies ExecutionContext;
}

/** Produce one complete Runner request before durable dispatch ownership. */
export const prepareExecutionPublication$ = command(
  async ({ set }, args: ExecutionPublicationInput, signal: AbortSignal) => {
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
    const sandboxToken = generateSandboxToken(
      args.run.userId,
      args.run.id,
      args.run.orgId,
    );
    const signed = await set(signExecutionContentBundles$, args, signal);
    signal.throwIfAborted();
    return {
      executionContext: executionContextBody({
        run: args.run,
        reuseKey: args.reuseKey,
        preparedContext: args.preparedContext,
        secretValues,
        refreshedPolicies,
        contentBundles: signed.contentBundles,
        sandboxToken,
        firewallToken: generateFirewallToken(
          args.run.userId,
          args.run.id,
          args.run.orgId,
        ),
      }),
      cacheWrites: signed.cacheWrites,
    };
  },
);

export function executionBundleHashes(
  context: Pick<
    PreparedExecutionContext,
    "officialWorkflowBundles" | "seedSkillBundles" | "templateGuidanceBundles"
  >,
): string[] {
  return [
    ...context.officialWorkflowBundles,
    ...context.seedSkillBundles,
    ...context.templateGuidanceBundles,
  ].map((bundle) => {
    return bundle.sha256;
  });
}
