import {
  preparedExecutionContextSchema,
  type PreparedExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import type { agentRuns } from "@okouai/db/runtime/agent-run";
import { command } from "ccstate";
import { billableFirewallsForPermissions } from "./built-in-route-pricing";
import type { AdmittedExecutionFacts } from "./admitted-execution-facts";
import { NATIVE_CONTEXT_RECOVERY_PROMPT } from "./chat-session-continuity.service";
import { dataRouterEnvironment } from "./data-router-environment";
import { type AcceptedMemoryMount } from "./execution-storage.service";
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
  | "modelUsageProvider"
  | "modelLongContextMinTotalInputTokens"
  | "reasoningEffort"
  | "codexServiceTier"
> & {
  readonly modelProvider: ModelFirstPin["modelProviderType"];
  readonly selectedModel: string;
  readonly chatThreadId: string;
  readonly framework: "claude-code" | "codex" | "pi";
  readonly vars: Record<string, string>;
};

type ExecutionInput = {
  readonly run: ExecutionContextRun;
  readonly facts: AdmittedExecutionFacts;
  readonly memoryMount: AcceptedMemoryMount;
};

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
  const environment = mergeEnvironments(
    [connectorEnvironment, modelEnvironment, platform, data, tokenEnvironment],
    [data, modelEnvironment, connectorEnvironment, platform, tokenEnvironment],
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
    { set },
    input: ExecutionInput,
    packages: ExecutionPackageMounts,
    signal: AbortSignal,
  ) => {
    const { run, facts } = input;
    const model = {
      provider: facts.modelProvider,
      piModelConfig: facts.modelProvider.piModelConfig,
    };
    const { environment, untrustedEnvironment } = executionEnvironment(input);
    const memory = await set(
      prepareExecutionMemoryMount$,
      input.memoryMount,
      signal,
    );
    signal.throwIfAborted();
    const prepared: PreparedExecutionContext = {
      ...executionModelConfiguration(
        run,
        model,
        packages.officialWorkflowBundles.length > 0,
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
      connectorRuntimeTargets: [...environment.runtimeTargets],
      billableFirewalls: billableFirewallsForPermissions({
        modelProvider: model.provider,
        permissions: environmentPermissionManifest(environment),
      }),
      disallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
      userTimezone: facts.userTimezone,
      captureNetworkBodies: facts.captureNetworkBodies ? true : undefined,
      seedSkillBundles: packages.seedSkillBundles,
      officialWorkflowBundles: packages.officialWorkflowBundles,
      templateGuidanceBundles: packages.templateGuidanceBundles,
    };
    return {
      context: preparedExecutionContextSchema.parse(prepared),
      storageCacheWrites: memory.cacheWrites,
      networkPolicyInputs: facts.connectorNetworkPolicyInputs,
    };
  },
);

function executionModelConfiguration(
  run: ExecutionContextRun,
  model: {
    readonly provider: AdmittedExecutionFacts["modelProvider"];
    readonly piModelConfig: AdmittedExecutionFacts["modelProvider"]["piModelConfig"];
  },
  isOfficialWorkflow: boolean,
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
        ? isOfficialWorkflow
          ? run.id
          : run.chatThreadId
        : undefined,
  };
}
