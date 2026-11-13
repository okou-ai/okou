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
import { monotonicNow, now, nowDate } from "../../lib/time";
import { generateSandboxToken } from "../auth/tokens";
import { settle } from "../utils";
import type { ClaimExecutionContextRun } from "./claim-execution-context";
import type { ClaimNetworkPolicyInputs } from "./claim-runtime-context";
import {
  signClaimedContentBundle$,
  type ClaimedContentBundleSignature,
} from "./content-bundle-claim";
import type { ContentBundleUrlCacheContext } from "./content-bundle-presigned-url-cache";
import type { StoragePresignedUrlCacheWrite } from "./system-storage-presigned-url-cache.service";
import type {
  WorkflowClaimInput,
  ClaimedWorkflow,
} from "./workflow-claim.service";
import {
  activeNetworkPolicyRefreshesFromGrants,
  mergeNetworkPolicyRefreshes,
  networkPolicyRefreshesRecord,
} from "./user-permission-grants.service";

export interface ExecutionPublicationRun extends ClaimExecutionContextRun {
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly vars: unknown;
  readonly isFirstRun: boolean | null;
}

export interface ExecutionPackageSelection {
  readonly workflows: readonly ClaimedWorkflow[];
  readonly instructionsBundle: ContentBundle | null;
  readonly cachedBundleUrls: readonly {
    readonly sha256: string;
    readonly url: string;
    readonly expiresAtMs: number;
  }[];
}

const runVarsSchema = record(string(), string()).nullable();
type BaseClaimResponse = Omit<ExecutionContext, "contentBundles">;
type ExecutionPolicyRefreshPath = "claim_inputs" | "no_builtin_targets";

/** Only the legacy Claim transport supplies its own attribution collector. */
interface ExecutionPublicationTiming {
  recordDuration(
    action: string,
    durationMs: number,
    dimensions?: Readonly<Record<string, string>>,
  ): void;
  recordPolicyRefreshPhases(args: {
    readonly permissionSource: "member" | "agent";
    readonly policyEvaluateMs: number;
    readonly mergeMs: number;
  }): void;
  recordNetworkPolicyRefresh(
    startedAt: number,
    finishedAt: number,
    path: ExecutionPolicyRefreshPath | undefined,
  ): void;
}

function mergeClaimVars(args: {
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
  responseBody: BaseClaimResponse,
  contentBundles: ExecutionContext["contentBundles"],
): ExecutionContext {
  const bundledMountPaths = new Set([
    ...contentBundles.skills.map((skill) => {
      return skill.mountPath;
    }),
    ...(contentBundles.templates ?? []).map(templateGuidanceMountPath),
  ]);
  return {
    ...responseBody,
    contentBundles,
    storageManifest: {
      storageMounts: (responseBody.storageManifest?.storageMounts ?? []).filter(
        (mount) => {
          return (
            !mount.name.startsWith("custom-skill@") &&
            !bundledMountPaths.has(mount.mountPath)
          );
        },
      ),
    },
  };
}

interface ClaimedContentBundlesInput {
  readonly responseBody: BaseClaimResponse;
  readonly claim: ExecutionPackageSelection;
  readonly workflowInput: WorkflowClaimInput;
  readonly officialWorkflowBundles: PreparedExecutionContext["officialWorkflowBundles"];
  readonly seedSkillBundles: PreparedExecutionContext["seedSkillBundles"];
  readonly templateGuidanceBundles: PreparedExecutionContext["templateGuidanceBundles"];
  readonly bundleUrlCache: ContentBundleUrlCacheContext;
  readonly timing?: ExecutionPublicationTiming;
}

const signClaimedContentBundles$ = command(
  async (
    { set },
    args: ClaimedContentBundlesInput,
    signal: AbortSignal,
  ): Promise<{
    readonly contentBundles: ExecutionContext["contentBundles"];
    readonly cacheWrites: readonly StoragePresignedUrlCacheWrite[];
    readonly uniqueBundleCount: number;
  }> => {
    const cachedUrls = new Map(
      args.claim.cachedBundleUrls.map((row) => {
        return [row.sha256, row];
      }),
    );
    const signatures = new Map<
      string,
      Promise<ClaimedContentBundleSignature>
    >();
    const signBundle = (
      reference: ContentBundle | TemplateGuidanceBundle,
    ): Promise<ClaimedContentBundleSignature> => {
      const identity = `${reference.sha256}:${reference.archiveBytes}`;
      const pending = signatures.get(identity);
      if (pending) {
        return pending;
      }
      const signed = set(
        signClaimedContentBundle$,
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
    const instructionsStartedAt = monotonicNow();
    const signedInstructions =
      args.claim.instructionsBundle === null
        ? undefined
        : await signBundle(args.claim.instructionsBundle);
    const instructions = signedInstructions?.bundle;
    if (instructions !== undefined) {
      args.timing?.recordDuration(
        "claim_route_content_bundle_instructions_sign",
        monotonicNow() - instructionsStartedAt,
      );
    }
    // One wall interval for the concurrent group, not a sum of per-URL timers.
    const skillsStartedAt = monotonicNow();
    const workflowMountPaths = new Set(
      args.claim.workflows.map((workflow) => {
        return `${args.workflowInput.skillRoot}/${workflow.name}`;
      }),
    );
    const skills = await Promise.all(
      [
        ...args.claim.workflows.map((workflow) => {
          return {
            contentBundle: workflow.contentBundle,
            mountPath: `${args.workflowInput.skillRoot}/${workflow.name}`,
          };
        }),
        ...[
          ...(args.officialWorkflowBundles ?? []),
          // Workflow claims previously replaced Connector Storage mounts at
          // the same path. Preserve that precedence for captured bundles too.
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
    args.timing?.recordDuration(
      "claim_route_content_bundle_skills_sign",
      monotonicNow() - skillsStartedAt,
    );
    const templatesStartedAt = monotonicNow();
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
    if (templates.length) {
      args.timing?.recordDuration(
        "claim_route_content_bundle_templates_sign",
        monotonicNow() - templatesStartedAt,
      );
    }
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
      uniqueBundleCount: signatures.size,
    };
  },
);

export const withExecutionContentBundles$ = command(
  async ({ set }, args: ClaimedContentBundlesInput, signal: AbortSignal) => {
    const startedAt = monotonicNow();
    const signed = await set(signClaimedContentBundles$, args, signal);
    signal.throwIfAborted();
    const assemblyStartedAt = monotonicNow();
    const responseBody = withContentBundleMounts(
      args.responseBody,
      signed.contentBundles,
    );
    args.timing?.recordDuration(
      "claim_route_content_bundle_response_assembly",
      monotonicNow() - assemblyStartedAt,
    );
    const { skills, instructions, templates = [] } = signed.contentBundles;
    // Only aggregate counts escape this request; no hash, mount or URL is logged.
    args.timing?.recordDuration(
      "claim_route_content_bundles",
      monotonicNow() - startedAt,
      {
        bundle_count: String(
          skills.length + templates.length + (instructions ? 1 : 0),
        ),
        template_guidance_bundle_count: String(templates.length),
        unique_bundle_count: String(signed.uniqueBundleCount),
        instruction_bundle_count: instructions ? "1" : "0",
        workflow_bundle_count: String(args.claim.workflows.length),
        official_workflow_bundle_count: String(
          args.officialWorkflowBundles?.length ?? 0,
        ),
        seed_skill_bundle_count: String(args.seedSkillBundles.length),
        cache_hit_count: String(
          signed.uniqueBundleCount - signed.cacheWrites.length,
        ),
        cache_miss_count: String(signed.cacheWrites.length),
        cache_write_path: "background",
      },
    );
    return { responseBody, cacheWrites: signed.cacheWrites };
  },
);

function secretValuesForRunner(
  storedContext: PreparedExecutionContext,
): string[] | null {
  const keys = storedContext.secretValueEnvironmentKeys;
  if (keys === null) {
    return null;
  }

  const environment = {
    ...storedContext.environment,
    ...storedContext.platformEnvironment,
  };
  const secretValues: string[] = [];
  for (const key of keys) {
    const value = environment[key];
    if (!Object.hasOwn(environment, key) || typeof value !== "string") {
      throw new Error(
        "Claim secret index references an absent environment key",
      );
    }
    secretValues.push(value);
  }
  return secretValues;
}

const prepareClaimNetworkPolicyRefreshes$ = command(
  async (
    _context,
    args: {
      readonly run: ExecutionPublicationRun;
      readonly storedContext: PreparedExecutionContext;
      readonly networkPolicyInputs: ClaimNetworkPolicyInputs | null;
      readonly timing?: ExecutionPublicationTiming;
    },
  ): Promise<
    Pick<ExecutionContext, "networkPolicies" | "networkPolicyRefreshes">
  > => {
    const storedNetworkPolicies = args.storedContext.networkPolicies ?? {};
    assertClaimConnectorIdentity(args.run, args.storedContext);
    const builtinConnectorSlugs = [
      ...new Set(
        args.storedContext.connectorRuntimeTargets.flatMap((target) => {
          return target.kind === "builtin" ? [target.connectorSlug] : [];
        }),
      ),
    ];

    if (
      builtinConnectorSlugs.length === 0 &&
      Object.keys(storedNetworkPolicies).length === 0
    ) {
      return {
        networkPolicies: args.storedContext.networkPolicies,
        networkPolicyRefreshes: undefined,
      };
    }

    const startedAt = now();
    // Finish evaluation before the durable transition and retain its elapsed
    // timing even if a captured input cannot be evaluated.
    const result = await settle(
      (async (): Promise<{
        readonly value: Pick<
          ExecutionContext,
          "networkPolicies" | "networkPolicyRefreshes"
        >;
        readonly path: ExecutionPolicyRefreshPath;
      }> => {
        if (builtinConnectorSlugs.length === 0) {
          return {
            value: {
              networkPolicies: args.storedContext.networkPolicies,
              networkPolicyRefreshes: undefined,
            },
            path: "no_builtin_targets",
          };
        }
        if (args.run.agentId === null || args.networkPolicyInputs === null) {
          throw new Error(
            "Connector network policy refresh requires Claim inputs and an Agent identity",
          );
        }
        const policyEvaluateStartedAt = monotonicNow();
        const refreshes = await activeNetworkPolicyRefreshesFromGrants(
          {
            ...args.networkPolicyInputs,
            connectorSlugs: builtinConnectorSlugs,
          },
          nowDate(),
        );
        const policyEvaluateMs = monotonicNow() - policyEvaluateStartedAt;
        const mergeStartedAt = monotonicNow();
        const networkPolicies = mergeNetworkPolicyRefreshes(
          args.storedContext.networkPolicies,
          refreshes,
        );
        const networkPolicyRefreshes = networkPolicyRefreshesRecord(refreshes);
        args.timing?.recordPolicyRefreshPhases({
          permissionSource: args.networkPolicyInputs.permissionSource,
          policyEvaluateMs,
          mergeMs: monotonicNow() - mergeStartedAt,
        });
        return {
          value: { networkPolicies, networkPolicyRefreshes },
          path: "claim_inputs",
        };
      })(),
    );
    const finishedAt = now();
    args.timing?.recordNetworkPolicyRefresh(
      startedAt,
      finishedAt,
      result.ok ? result.value.path : undefined,
    );
    if (!result.ok) {
      throw result.error;
    }
    return result.value.value;
  },
);

function assertClaimConnectorIdentity(
  run: ExecutionPublicationRun,
  storedContext: PreparedExecutionContext,
): void {
  if (
    run.agentId === null &&
    storedContext.connectorRuntimeTargets.length > 0
  ) {
    throw new Error(
      "Runs without an agent cannot use connector runtime targets",
    );
  }
}

export function executionResponseBody(args: {
  readonly run: ExecutionPublicationRun;
  readonly reuseKey: string | null;
  readonly storedContext: PreparedExecutionContext;
  readonly secretValues: ExecutionContext["secretValues"];
  readonly refreshedPolicies: Pick<
    ExecutionContext,
    "networkPolicies" | "networkPolicyRefreshes"
  >;
}): BaseClaimResponse {
  const {
    secretValueEnvironmentKeys: _secretValueEnvironmentKeys,
    customWorkflowSelection: _customWorkflowSelection,
    officialWorkflowBundles: _officialWorkflowBundles,
    seedSkillBundles: _seedSkillBundles,
    templateGuidanceBundles: _templateGuidanceBundles,
    storageMounts: _storedStorageMounts,
    featureFlags: _featureFlags,
    ...runnerStoredContext
  } = args.storedContext;
  return {
    ...runnerStoredContext,
    ...(args.run.isFirstRun === null
      ? {}
      : { isFirstRun: args.run.isFirstRun }),
    runId: args.run.id,
    reuseKey: args.reuseKey,
    prompt: args.run.prompt,
    appendSystemPrompt: args.run.appendSystemPrompt,
    vars: mergeClaimVars({
      runVars: runVarsSchema.parse(args.run.vars),
      connectorVars: args.storedContext.vars,
    }),
    storageManifest: {
      storageMounts: args.storedContext.storageMounts.map((storedMount) => {
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
    connectorRuntimeTargets: args.storedContext.connectorRuntimeTargets,
    networkPolicies: args.refreshedPolicies.networkPolicies,
    networkPolicyRefreshes: args.refreshedPolicies.networkPolicyRefreshes,
  };
}

export const prepareExecutionResponse$ = command(
  async (
    { set },
    args: {
      readonly run: ExecutionPublicationRun;
      readonly storedContext: PreparedExecutionContext;
      readonly networkPolicyInputs: ClaimNetworkPolicyInputs | null;
      readonly timing?: ExecutionPublicationTiming;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly secretValues: ExecutionContext["secretValues"];
    readonly refreshedPolicies: Pick<
      ExecutionContext,
      "networkPolicies" | "networkPolicyRefreshes"
    >;
  }> => {
    // Fallible preparation must finish before durable claim ownership.
    const secretValues = secretValuesForRunner(args.storedContext);
    signal.throwIfAborted();
    const refreshedPolicies = await set(prepareClaimNetworkPolicyRefreshes$, {
      run: args.run,
      storedContext: args.storedContext,
      networkPolicyInputs: args.networkPolicyInputs,
      timing: args.timing,
    });
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
