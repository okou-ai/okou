import type {
  ExecutionContext,
  PreparedExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { templateGuidanceMountPath } from "@okouai/api-contracts/contracts/template-guidance-bundle";
import { command } from "ccstate";
import { nowDate } from "../../lib/time";
import { generateFirewallToken, generateSandboxToken } from "../auth/tokens";
import type { ExecutionContextRun } from "./execution-runtime-context";
import type { ExecutionNetworkPolicyInputs } from "./admitted-execution-facts";
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

export const prepareExecutionNetworkPolicyRefreshes$ = command(
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

export function buildExecutionContext(args: {
  readonly run: ExecutionPublicationRun;
  readonly reuseKey: string;
  readonly preparedContext: PreparedExecutionContext;
  readonly refreshedPolicies: RefreshedExecutionPolicies;
  readonly contentBundles: ExecutionContext["contentBundles"];
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
    sandboxToken: generateSandboxToken(
      args.run.userId,
      args.run.id,
      args.run.orgId,
    ),
    firewallToken: generateFirewallToken(
      args.run.userId,
      args.run.id,
      args.run.orgId,
    ),
    secretValues: secretValuesForRunner(args.preparedContext),
    connectorRuntimeTargets: args.preparedContext.connectorRuntimeTargets,
    networkPolicies: args.refreshedPolicies.networkPolicies,
    networkPolicyRefreshes: args.refreshedPolicies.networkPolicyRefreshes,
  } satisfies ExecutionContext;
}
