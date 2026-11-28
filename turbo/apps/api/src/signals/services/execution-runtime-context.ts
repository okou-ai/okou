import { ANTIGRAVITY_FIREWALL_PLACEHOLDER } from "@okouai/api-contracts/contracts/model-provider-firewalls";
import {
  preparedExecutionContextSchema,
  type PreparedExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import type { agentRuns } from "@okouai/db/runtime/agent-run";
import { command } from "ccstate";
import { monotonicNow } from "../../lib/time";
import { joinAllInOrder } from "../utils";
import { billableFirewallsForPermissions } from "./built-in-route-pricing";
import type { AdmittedExecutionFacts } from "./admitted-execution-facts";
import { NATIVE_CONTEXT_RECOVERY_PROMPT } from "./chat-session-continuity.service";
import { dataRouterEnvironment } from "./data-router-environment";
import type { ExecutionMemoryMount } from "./execution-storage.service";
import type { ExecutionPackageMounts } from "./execution-workflow-selection";
import type { ModelFirstPin } from "./model-selection.service";
import {
  emptyEnvironment,
  environmentPermissionManifest,
  mergeEnvironments,
} from "./run-environment";
import {
  DEFAULT_DISALLOWED_TOOLS,
  runPlatformEnvironment,
} from "./run-execution-defaults";
import type { prepareExecutionNetworkPolicy$ } from "./run-execution-publication.service";
import {
  modelProviderEnvironment,
  paidToolPlatformEnvironment,
} from "./thread-environment.signals";

/** Captured inputs for one admitted Thread Run. */
export type ExecutionContextRun = Pick<
  typeof agentRuns.$inferSelect,
  | "id"
  | "orgId"
  | "userId"
  | "triggerSource"
  | "modelUsageProvider"
  | "modelLongContextMinTotalInputTokens"
  | "reasoningEffort"
  | "codexServiceTier"
> & {
  readonly modelProvider: ModelFirstPin["modelProviderType"];
  readonly selectedModel: string;
  readonly chatThreadId: string;
  readonly framework: "claude-code" | "codex" | "pi" | "antigravity";
  readonly vars: Record<string, string>;
};

type ExecutionInput = {
  readonly run: ExecutionContextRun;
  readonly facts: AdmittedExecutionFacts;
};

export interface ExecutionRuntimeResources {
  readonly memory: Promise<ExecutionMemoryMount>;
  readonly networkPolicyInputs: ReturnType<
    (typeof prepareExecutionNetworkPolicy$)["write"]
  >;
}

function executionPlatform({ run, facts }: ExecutionInput) {
  const framework = run.framework;
  const integration = facts.integration;
  return {
    ...emptyEnvironment(),
    platformEnvironment: {
      ...runPlatformEnvironment(run),
      ...paidToolPlatformEnvironment({
        disabledTools: facts.disabledPaidTools,
        framework,
        modelProviderType: facts.modelProvider.type,
        piExecution: framework === "pi",
      }),
      ...(integration ? { OKOU_CURRENT_INTEGRATION: integration } : {}),
      ...(run.reasoningEffort
        ? { OKOU_REASONING_EFFORT: run.reasoningEffort }
        : {}),
      ...(run.codexServiceTier
        ? { OKOU_CODEX_SERVICE_TIER: run.codexServiceTier }
        : {}),
    },
  };
}

function antigravityEnvironment(
  facts: ExecutionInput["facts"],
): ReturnType<typeof emptyEnvironment> {
  if (facts.modelProvider.type !== "antigravity") {
    return emptyEnvironment();
  }
  if (!facts.modelProvider.id) {
    throw new Error("An Antigravity run requires its member account");
  }
  // The native CLI reads this local marker before it makes any request.
  // The firewall owns the real token lifetime. The synthetic refresh value also
  // satisfies the existing Guest validator during a mixed-version rollout.
  const antigravityPlaceholderToken = {
    access_token: ANTIGRAVITY_FIREWALL_PLACEHOLDER,
    refresh_token: "okou-antigravity-local-refresh-placeholder",
    token_type: "Bearer",
    expiry: "2099-01-01T00:00:00Z",
  };
  const antigravityPlaceholder = JSON.stringify({
    ...antigravityPlaceholderToken,
    token: antigravityPlaceholderToken,
    auth_method: "consumer",
  });
  return {
    ...emptyEnvironment(),
    platformEnvironment: {
      OKOU_ANTIGRAVITY_MODEL: facts.modelProvider.upstreamModel,
      OKOU_ANTIGRAVITY_OAUTH_TOKEN: antigravityPlaceholder,
    },
    reservedSecretAliases: ["OKOU_ANTIGRAVITY_OAUTH_TOKEN"],
  };
}

function executionEnvironment(input: ExecutionInput) {
  const { run, facts } = input;
  const { connectorEnvironment } = facts;
  const modelEnvironment = modelProviderEnvironment(
    facts.modelProvider,
    run.vars,
    facts.modelProviderPermissions,
  );
  const platform = executionPlatform(input);
  const data = dataRouterEnvironment();
  const token = facts.okouToken;
  const tokenEnvironment = {
    ...emptyEnvironment(),
    platformEnvironment: { OKOU_TOKEN: token },
    reservedSecretAliases: ["OKOU_TOKEN"],
  };
  const antigravity = antigravityEnvironment(facts);
  const environment = mergeEnvironments(
    [
      connectorEnvironment,
      modelEnvironment,
      platform,
      data,
      tokenEnvironment,
      antigravity,
    ],
    [
      data,
      modelEnvironment,
      connectorEnvironment,
      platform,
      tokenEnvironment,
      antigravity,
    ],
  );
  const untrustedEnvironment = Object.fromEntries(
    Object.entries(environment.environment ?? {}).filter(([key]) => {
      return !key.startsWith("OKOU_") && !key.startsWith("ZERO_");
    }),
  );
  return { environment, untrustedEnvironment };
}

export const prepareExecutionRuntimeContext$ = command(
  async (
    _context,
    input: ExecutionInput,
    packages: ExecutionPackageMounts,
    resources: ExecutionRuntimeResources,
    signal: AbortSignal,
  ) => {
    const { run, facts } = input;
    const model = {
      provider: facts.modelProvider,
      piModelConfig: facts.modelProvider.piModelConfig,
    };
    const { environment, untrustedEnvironment } = executionEnvironment(input);
    const connectorRuntimeTargets = [...environment.runtimeTargets];
    const [prepared, networkPolicyInputs] = await joinAllInOrder(
      [
        (async () => {
          const memory = await resources.memory;
          signal.throwIfAborted();
          const prepared: PreparedExecutionContext = {
            ...executionModelConfiguration(
              run,
              model,
              run.triggerSource === "proactive",
            ),
            featureFlags: facts.featureFlags,
            realAgentInPreview: facts.realAgentInPreview,
            apiStartTime: facts.apiStartTime,
            storageMounts: [memory.mount],
            nativeContinuation: {
              ...facts.nativeContinuation,
              recoveryPrompt:
                facts.nativeContinuation.recoveryPrompt === null
                  ? null
                  : NATIVE_CONTEXT_RECOVERY_PROMPT,
            },
            environment:
              Object.keys(untrustedEnvironment).length === 0
                ? null
                : untrustedEnvironment,
            platformEnvironment: environment.platformEnvironment ?? {},
            vars: environment.vars ?? null,
            firewalls: [...environment.firewalls],
            networkPolicies: environment.networkPolicies,
            secretConnectorMap: environment.secretConnectorMap ?? null,
            secretConnectorMetadataMap:
              environment.secretConnectorMetadataMap ?? null,
            connectorRuntimeTargets,
            billableFirewalls: billableFirewallsForPermissions({
              modelProvider: model.provider,
              permissions: environmentPermissionManifest(environment),
            }),
            disallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
            userTimezone: facts.userTimezone,
            captureNetworkBodies: facts.captureNetworkBodies ? true : undefined,
            seedSkillBundles: packages.seedSkillBundles.map(({ mount }) => {
              return mount;
            }),
            officialWorkflowBundles: [],
            templateGuidanceBundles: packages.templateGuidanceBundles,
          };
          return {
            context: preparedExecutionContextSchema.parse(prepared),
            storageCacheWrites: memory.cacheWrites,
            readyAt: monotonicNow(),
          };
        })(),
        resources.networkPolicyInputs,
      ],
      signal,
    );
    signal.throwIfAborted();
    return { ...prepared, networkPolicyInputs };
  },
);

function executionModelConfiguration(
  run: ExecutionContextRun,
  model: {
    readonly provider: AdmittedExecutionFacts["modelProvider"];
    readonly piModelConfig: AdmittedExecutionFacts["modelProvider"]["piModelConfig"];
  },
  useRunSession: boolean,
): Pick<
  PreparedExecutionContext,
  | "cliAgentType"
  | "modelUsageProvider"
  | "modelUsageLongContextMinTotalInputTokens"
  | "codexRuntimeConfig"
  | "piModelConfig"
  | "piLaunchConfig"
  | "piSessionId"
> {
  const framework = run.framework;
  return {
    cliAgentType: framework,
    modelUsageProvider:
      run.modelProvider === "built-in"
        ? (run.modelUsageProvider ?? undefined)
        : run.selectedModel,
    modelUsageLongContextMinTotalInputTokens:
      run.modelProvider === "built-in"
        ? (run.modelLongContextMinTotalInputTokens ?? undefined)
        : 0,
    codexRuntimeConfig: model.provider.codexRuntimeConfig ?? null,
    piModelConfig: model.piModelConfig,
    piLaunchConfig: framework === "pi" ? { schemaVersion: 2 } : undefined,
    piSessionId:
      framework === "pi"
        ? useRunSession
          ? run.id
          : run.chatThreadId
        : undefined,
  };
}
