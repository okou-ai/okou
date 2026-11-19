import type { PaidToolId } from "@okouai/api-contracts/contracts/paid-tools";
import {
  preparedExecutionContextSchema,
  type PreparedExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import type { agentRuns } from "@okouai/db/runtime/agent-run";
import { computed, type Computed } from "ccstate";
import { billableFirewallsForPermissions } from "./built-in-route-pricing";
import type { AdmittedExecutionFacts } from "./admitted-execution-facts";
import { NATIVE_CONTEXT_RECOVERY_PROMPT } from "./chat-session-continuity.service";
import { dataRouterEnvironment } from "./data-router-environment";
import {
  createAcceptedExecutionStorage,
  type AcceptedMemoryMount,
} from "./execution-storage.service";
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
import { normalizeMountOverlay } from "./storage-mount-overlay";
import {
  createModelProviderEnvironmentSignals,
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
  readonly agentId: string;
  readonly chatThreadId: string;
  readonly framework: "claude-code" | "codex" | "pi";
  readonly vars: Record<string, string>;
};

type ExecutionInput = {
  readonly run: ExecutionContextRun;
  readonly facts: AdmittedExecutionFacts;
  readonly memoryMounts: readonly AcceptedMemoryMount[];
};

type ExecutionInput$ = Computed<Promise<ExecutionInput>>;
type ExecutionModel$ = ReturnType<typeof createExecutionModel>;
type ExecutionModel =
  ExecutionModel$ extends Computed<infer T> ? Awaited<T> : never;
type DisabledTools$ = Computed<Promise<readonly PaidToolId[]>>;

/** Assemble accepted source contributions with this Run's execution operations. */
export function createExecutionRuntimeContext(input$: ExecutionInput$) {
  const disabledTools$ = computed(async (get) => {
    return (await get(input$)).facts.disabledPaidTools;
  });
  const runVariables$ = computed(async (get) => {
    return (await get(input$)).run.vars;
  });
  const model$ = createExecutionModel(input$);
  const modelRoute$ = computed(async (get) => {
    return (await get(model$)).provider;
  });
  const modelEnvironment$ = createModelProviderEnvironmentSignals(
    runVariables$,
    modelRoute$,
    computed(async (get) => {
      return (await get(input$)).facts.modelProviderPermissions;
    }),
  );
  const storage$ = createAcceptedExecutionStorage(
    computed(async (get) => {
      return (await get(input$)).memoryMounts;
    }),
  );
  const packages$ = createExecutionPackages(input$);
  const platform$ = createExecutionPlatform(input$, model$, disabledTools$);
  const environment$ = createExecutionEnvironment(
    input$,
    modelEnvironment$,
    platform$,
  );
  const prepared$ = createExecutionPreparedContext(input$, {
    model$,
    packages$,
    environment$,
    storage$,
  });
  return { prepared$, packageContext$: packages$ };
}

function createExecutionModel(input$: ExecutionInput$) {
  return computed(async (get) => {
    const { modelProvider } = (await get(input$)).facts;
    return {
      provider: modelProvider,
      piModelConfig: modelProvider.piModelConfig,
    };
  });
}

function createExecutionPackages(input$: ExecutionInput$) {
  return computed(async (get) => {
    const { facts, memoryMounts } = await get(input$);
    const { skillRoot, skillMounts, officialWorkflowBundles } = facts;
    const storageMounts = memoryMounts.map(({ mount }) => {
      return mount;
    });
    const winners = normalizeMountOverlay([...skillMounts, ...storageMounts]);
    const seedSkillBundles = winners.flatMap((volume) => {
      return "contentBundle" in volume
        ? [{ ...volume.contentBundle, mountPath: volume.mountPath }]
        : [];
    });
    const templateGuidanceBundles = winners.flatMap((volume, index) => {
      return "templateGuidanceBundle" in volume
        ? [
            {
              ...volume.templateGuidanceBundle,
              beforeMountPaths: winners.slice(index + 1).map((later) => {
                return later.mountPath;
              }),
            },
          ]
        : [];
    });
    return {
      skillRoot,
      officialWorkflowBundles,
      seedSkillBundles,
      templateGuidanceBundles,
    };
  });
}

function createExecutionPlatform(
  input$: ExecutionInput$,
  model$: ExecutionModel$,
  disabledTools$: DisabledTools$,
) {
  return computed(async (get) => {
    const [{ run, facts }, model, disabledTools] = await Promise.all([
      get(input$),
      get(model$),
      get(disabledTools$),
    ]);
    const framework = run.framework;
    const integration = facts.integration;
    return {
      ...emptyEnvironment(),
      platformEnvironment: {
        ...runPlatformEnvironment(run),
        ...paidToolPlatformEnvironment({
          disabledTools,
          framework,
          modelProviderType: model.provider.type,
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
  });
}

function createExecutionEnvironment(
  input$: ExecutionInput$,
  modelEnvironment$: ReturnType<typeof createModelProviderEnvironmentSignals>,
  platform$: ReturnType<typeof createExecutionPlatform>,
) {
  return computed(async (get) => {
    const { facts } = await get(input$);
    const { connectorEnvironment } = facts;
    const [modelEnvironment, platform] = await Promise.all([
      get(modelEnvironment$),
      get(platform$),
    ]);
    const data = dataRouterEnvironment();
    const token = facts.okouToken;
    const tokenEnvironment = {
      ...emptyEnvironment(),
      platformEnvironment: { OKOU_TOKEN: token },
      reservedSecretAliases: ["OKOU_TOKEN"],
    };
    const environment = mergeEnvironments(
      [
        connectorEnvironment,
        modelEnvironment,
        platform,
        data,
        tokenEnvironment,
      ],
      [
        data,
        modelEnvironment,
        connectorEnvironment,
        platform,
        tokenEnvironment,
      ],
    );
    const untrustedEnvironment = Object.fromEntries(
      Object.entries(environment.environment ?? {}).filter(([key]) => {
        return !key.startsWith("OKOU_") && !key.startsWith("ZERO_");
      }),
    );
    return { environment, untrustedEnvironment };
  });
}

function createExecutionPreparedContext(
  input$: ExecutionInput$,
  dependencies: {
    readonly model$: ExecutionModel$;
    readonly packages$: ReturnType<typeof createExecutionPackages>;
    readonly environment$: ReturnType<typeof createExecutionEnvironment>;
    readonly storage$: ReturnType<typeof createAcceptedExecutionStorage>;
  },
) {
  return computed(async (get) => {
    const { run, facts } = await get(input$);
    const [model, packages, resolved, storage] = await Promise.all([
      get(dependencies.model$),
      get(dependencies.packages$),
      get(dependencies.environment$),
      get(dependencies.storage$),
    ]);
    const { environment, untrustedEnvironment } = resolved;
    const prepared: PreparedExecutionContext = {
      ...executionModelConfiguration(
        run,
        model,
        packages.officialWorkflowBundles.length > 0,
      ),
      featureFlags: facts.featureFlags,
      realAgentInPreview: facts.realAgentInPreview,
      apiStartTime: facts.apiStartTime,
      storageMounts: storage.storageMounts,
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
      storageCacheWrites: storage.cacheWrites,
      networkPolicyInputs: facts.connectorNetworkPolicyInputs,
    };
  });
}

function executionModelConfiguration(
  run: ExecutionContextRun,
  model: ExecutionModel,
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
