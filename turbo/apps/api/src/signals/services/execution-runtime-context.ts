import { getFrameworkForType } from "@okouai/api-contracts/contracts/model-providers";
import type { PaidToolId } from "@okouai/api-contracts/contracts/paid-tools";
import {
  preparedExecutionContextSchema,
  type PreparedExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { AUTO_RUN_PROVIDER } from "@okouai/core/auto-run-model";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { agentRuns } from "@okouai/db/runtime/agent-run";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import type { PersistedStorageMount } from "@okouai/db/types";
import { computed, type Computed } from "ccstate";
import { eq } from "drizzle-orm";
import { previewAutomationBypassSecret } from "../../lib/preview-automation-bypass";
import { db$ } from "../external/db";
import { billableFirewallsForPermissions } from "./built-in-route-pricing";
import { createExecutionConnectorSources } from "./agent-run-context.signals";
import type { ResolvedModelProviderEnvironment } from "./agent-run-contracts";
import type { AdmittedExecutionFacts } from "./admitted-execution-facts";
import { NATIVE_CONTEXT_RECOVERY_PROMPT } from "./chat-session-continuity.service";
import type { ConnectorServerFirewallMetadataCatalog } from "./connector-server-firewall-catalog.service";
import { createConnectorSkillVolumes } from "./connectors-context.service";
import { dataRouterEnvironment } from "./data-router-environment";
import { createAcceptedExecutionStorageObjects } from "./execution-storage.service";
import { createUserFeatureSwitchContext } from "./feature-switches.service";
import {
  createRunModelSources,
  managedSourceFromSnapshot,
  memberAccountSourceFromSnapshot,
} from "./model-source-context.service";
import {
  prepareManagedModelEnvironment,
  prepareSubscriptionModelEnvironment,
} from "./model-provider.service";
import { personalSubscriptionAccountIdentity } from "./personal-subscription-recovery.service";
import type { ModelFirstPin } from "./model-selection.service";
import {
  emptyEnvironment,
  environmentPermissionManifest,
  mergeEnvironments,
} from "./run-environment";
import {
  mergeRunSkillVolumes,
  resolveRunSkillVolumes,
} from "./run-prompt-and-skills";
import { storedMountFromPrepared } from "./run-storage-manifest.service";
import {
  DEFAULT_DISALLOWED_TOOLS,
  runPlatformEnvironment,
} from "./run-execution-defaults";
import { normalizeMountOverlay } from "./storage-mount-overlay";
import { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import { createExecutionConnectedAccounts } from "./thread-connected-accounts.signals";
import { createConnectorEnvironmentSignals } from "./thread-connector-environment.signals";
import {
  createModelProviderEnvironmentSignals,
  paidToolPlatformEnvironment,
} from "./thread-environment.signals";
import type { ResolvedPermissionGrant } from "./user-permission-grants.service";

/** Captured inputs for one admitted Thread Run. */
export type ExecutionContextRun = Pick<
  typeof agentRuns.$inferSelect,
  | "id"
  | "orgId"
  | "userId"
  | "modelProviderId"
  | "modelProviderAccountIdentity"
  | "modelRuntimeProvider"
  | "modelRuntimeModel"
  | "builtInModelKeyId"
  | "modelUsageProvider"
  | "modelLongContextMinTotalInputTokens"
  | "reasoningEffort"
  | "codexServiceTier"
  | "officialWorkflowProvenance"
> & {
  readonly modelProvider: ModelFirstPin["modelProviderType"];
  readonly selectedModel: string;
  readonly agentId: string;
  readonly chatThreadId: string;
  readonly framework: "claude-code" | "codex" | "pi";
  readonly vars: Record<string, string>;
  readonly storageMounts: readonly PersistedStorageMount[];
};

/** Internal to one execution; never part of its persisted or Runner context. */
export interface ExecutionNetworkPolicyInputs {
  readonly catalog: ConnectorServerFirewallMetadataCatalog;
  readonly grants: readonly ResolvedPermissionGrant[];
}

type ExecutionInput = {
  readonly run: ExecutionContextRun;
  readonly facts: AdmittedExecutionFacts;
};

type ExecutionInput$ = Computed<Promise<ExecutionInput>>;
type ExecutionIdentities = ReturnType<typeof createExecutionIdentities>;
type ExecutionSources = ReturnType<typeof createExecutionConnectorSources>;
type ExecutionModel$ = ReturnType<typeof createExecutionModel>;
type ExecutionModel =
  ExecutionModel$ extends Computed<infer T> ? Awaited<T> : never;
type DisabledTools$ = Computed<Promise<readonly PaidToolId[]>>;

/** Assemble accepted contributions with this Run's required current sources. */
export function createExecutionRuntimeContext(input$: ExecutionInput$) {
  const identities = createExecutionIdentities(input$);
  const { identity$, features$ } = identities;
  const sources = createExecutionConnectorSources(identity$, features$);
  const networkPolicyInputs$ = computed(
    async (get): Promise<ExecutionNetworkPolicyInputs> => {
      const [catalog, grants] = await Promise.all([
        get(sources.signals.catalog$),
        get(sources.signals.permissionGrants$),
      ]);
      if (!catalog) {
        throw new Error("Execution builtin targets require a scoped catalog");
      }
      return {
        catalog: catalog.serverFirewalls,
        grants,
      };
    },
  );
  const disabledTools$ = computed(async (get) => {
    return (await get(input$)).facts.disabledPaidTools;
  });
  const connectors = createExecutionConnectorContext(
    input$,
    identities,
    sources,
  );
  const model$ = createExecutionModel(input$);
  const modelRoute$ = computed(async (get) => {
    return (await get(model$)).provider;
  });
  const modelEnvironment$ = createModelProviderEnvironmentSignals(
    connectors.runVariables$,
    modelRoute$,
    computed(async (get) => {
      return (await get(input$)).facts.modelProviderPermissions;
    }),
  );
  const storage$ = createExecutionStorage(input$);
  const packages$ = createExecutionPackages(input$, sources, storage$);
  const platform$ = createExecutionPlatform(input$, model$, disabledTools$);
  const environment$ = createExecutionEnvironment(
    input$,
    connectors.connectorEnvironment$,
    modelEnvironment$,
    platform$,
  );
  const prepared$ = createExecutionPreparedContext(input$, {
    model$,
    packages$,
    environment$,
    storage$,
    connectorTiming$: connectors.timing$,
    networkPolicyInputs$,
  });
  return { prepared$, packageContext$: packages$ };
}

function createExecutionStorage(input$: ExecutionInput$) {
  const mounts$ = computed(async (get) => {
    return (await get(input$)).run.storageMounts;
  });
  const objects = createAcceptedExecutionStorageObjects(mounts$);
  return computed(async (get) => {
    const [mounts, prepared] = await Promise.all([
      get(mounts$),
      get(objects.preparedMounts$),
    ]);
    const byPath = new Map(
      mounts.map((mount) => {
        return [mount.mountPath, mount];
      }),
    );
    return {
      storageMounts: prepared.map((mount) => {
        const accepted = byPath.get(mount.mountPath);
        if (!accepted) {
          throw new Error("Prepared Storage mount has no accepted identity");
        }
        return storedMountFromPrepared(
          mount,
          accepted.missingRootPolicy !== undefined,
        );
      }),
      cacheWrites: prepared.flatMap((mount) => {
        return "presignedUrlCacheWrite" in mount && mount.presignedUrlCacheWrite
          ? [mount.presignedUrlCacheWrite]
          : [];
      }),
    };
  });
}

function createExecutionIdentities(input$: ExecutionInput$) {
  const run$ = computed(async (get) => {
    return (await get(input$)).run;
  });
  const memberIdentity$ = computed(async (get) => {
    const { orgId, userId } = await get(run$);
    return { orgId, userId };
  });
  const identity$ = computed(async (get) => {
    const run = await get(run$);
    return { orgId: run.orgId, userId: run.userId, agentId: run.agentId };
  });
  const currentFeatures$ = createUserFeatureSwitchContext(memberIdentity$);
  const features$ = computed(async (get) => {
    const { run, facts } = await get(input$);
    // Only custom connector network bindings consume unpinned overrides.
    const currentOverrides = facts.connectorRuntimeTargets.some((target) => {
      return target.kind === "custom";
    })
      ? (await get(currentFeatures$)).overrides
      : undefined;
    return {
      userId: run.userId,
      orgId: run.orgId,
      overrides: {
        ...currentOverrides,
        [FeatureSwitchKey.SingleAgent]:
          facts.featureFlags[FeatureSwitchKey.SingleAgent],
        [FeatureSwitchKey.ConnectorChatAccountAccess]:
          facts.featureFlags[FeatureSwitchKey.ConnectorChatAccountAccess],
      },
    };
  });
  return { run$, identity$, features$ };
}

function createExecutionConnectorContext(
  input$: ExecutionInput$,
  identities: ExecutionIdentities,
  sources: ExecutionSources,
) {
  const { run$, identity$, features$ } = identities;
  const targets$ = computed(async (get) => {
    return (await get(input$)).facts.connectorRuntimeTargets;
  });
  const connectorIdentity$ = computed(async (get) => {
    const [identity, run] = await Promise.all([get(identity$), get(run$)]);
    return { ...identity, chatThreadId: run.chatThreadId };
  });
  const timing$ = computed(() => {
    return new ApiDispatchTimingCollector();
  });
  const connected = createExecutionConnectedAccounts({
    identity$: connectorIdentity$,
    targets$,
    scope$: sources.signals.connectorScope$,
    catalog$: sources.signals.catalog$,
    definitions$: sources.signals.customConnectorDefinitions$,
    connectors$: sources.signals.connectors$,
    policies$: sources.signals.permissionPolicies$,
    features$,
    timing$,
  });
  const runVariables$ = computed(async (get) => {
    return (await get(input$)).run.vars;
  });
  const connectorEnvironment$ = createConnectorEnvironmentSignals(
    {
      runVariables$,
      permissionPolicies$: sources.signals.permissionPolicies$,
    },
    {
      connectorSelection$: connected.connectorSelection$,
      connectorSnapshot$: connected.connectorSnapshot$,
      dispatchTiming$: timing$,
    },
  );
  return { runVariables$, connectorEnvironment$, timing$ };
}

function createExecutionModel(input$: ExecutionInput$) {
  const memberIdentity$ = computed(async (get) => {
    const { run } = await get(input$);
    return {
      orgId: run.orgId,
      userId: run.userId,
      runId: run.id,
      accountId: run.modelProviderId,
    };
  });
  const memberModels$ = createRunModelSources(memberIdentity$);
  return computed(async (get) => {
    const { run, facts } = await get(input$);
    if (
      !run.selectedModel ||
      !run.modelRuntimeModel ||
      !run.modelRuntimeProvider
    ) {
      throw new Error("Admitted Run is missing its pinned model route");
    }
    const piExecution = run.framework === "pi";
    let provider: ResolvedModelProviderEnvironment | null;
    if (run.modelProvider === "built-in") {
      if (
        !run.builtInModelKeyId ||
        run.modelRuntimeProvider !== AUTO_RUN_PROVIDER ||
        run.modelUsageProvider === null ||
        run.modelLongContextMinTotalInputTokens === null
      ) {
        throw new Error("Admitted managed model route is unavailable");
      }
      const [key] = await get(db$)
        .select({
          id: builtInModelKeys.id,
          vendor: builtInModelKeys.vendor,
        })
        .from(builtInModelKeys)
        .where(eq(builtInModelKeys.id, run.builtInModelKeyId));
      const source = managedSourceFromSnapshot(key);
      if (!source) {
        throw new Error("Run execution sources are unavailable");
      }
      provider = prepareManagedModelEnvironment(source, {
        framework: getFrameworkForType(AUTO_RUN_PROVIDER),
        selectedModel: run.selectedModel,
        builtInModelRuntimeRoute: {
          selectedModel: run.selectedModel,
          providerType: AUTO_RUN_PROVIDER,
          upstreamModel: run.modelRuntimeModel,
          modelKeyId: run.builtInModelKeyId,
        },
      });
    } else {
      const members = await get(memberModels$);
      const account = members.accounts.find((candidate) => {
        return candidate.id === run.modelProviderId;
      });
      if (
        !account ||
        account.type !== run.modelProvider ||
        (run.modelProviderAccountIdentity !== null &&
          personalSubscriptionAccountIdentity(account) !==
            run.modelProviderAccountIdentity)
      ) {
        throw new Error("Run execution sources are unavailable");
      }
      const source = memberAccountSourceFromSnapshot(members, account.id);
      if (!source) {
        throw new Error("Run execution sources are unavailable");
      }
      provider = prepareSubscriptionModelEnvironment(
        source,
        run.selectedModel,
        {
          userId: run.userId,
          sourceId: account.id,
          piExecution,
          upstreamModel: run.modelRuntimeModel,
        },
      );
    }
    if (!provider) {
      throw new Error("Run execution sources are unavailable");
    }
    const piModelConfig = facts.piModelConfig;
    return {
      provider: { ...provider, piModelConfig },
      piModelConfig,
    };
  });
}

function createExecutionPackages(
  input$: ExecutionInput$,
  sources: ExecutionSources,
  storage$: ReturnType<typeof createExecutionStorage>,
) {
  const connectorSkills$ = createConnectorSkillVolumes(
    sources.signals.authorizedConnectors$,
  );
  return computed(async (get) => {
    const { run, facts } = await get(input$);
    const framework = run.framework;
    const skillRoot =
      framework === "pi"
        ? "/home/user/.pi/agent/skills"
        : framework === "codex"
          ? "/home/user/.codex/skills"
          : "/home/user/.claude/skills";
    const [connectors, storage] = await Promise.all([
      get(connectorSkills$),
      get(storage$),
    ]);
    const volumes = resolveRunSkillVolumes(
      mergeRunSkillVolumes([
        connectors,
        facts.seedSkillVolumes,
        facts.templateSkillVolumes,
      ]),
      skillRoot,
    );
    const winners = normalizeMountOverlay([
      ...volumes,
      ...storage.storageMounts,
    ]);
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
      cliAgentType: framework,
      customWorkflowSelection: facts.customWorkflowSelection,
      storageMounts: storage.storageMounts,
      officialWorkflowBundles: executionOfficialBundles(run, skillRoot),
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
    const bypass = facts.previewBypassAuthorized
      ? previewAutomationBypassSecret()
      : undefined;
    return {
      ...emptyEnvironment(),
      secrets: bypass ? { VERCEL_AUTOMATION_BYPASS_SECRET: bypass } : undefined,
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
        ...(bypass ? { VERCEL_AUTOMATION_BYPASS_SECRET: bypass } : {}),
      },
    };
  });
}

function createExecutionEnvironment(
  input$: ExecutionInput$,
  connectorEnvironment$: ReturnType<
    typeof createExecutionConnectorContext
  >["connectorEnvironment$"],
  modelEnvironment$: ReturnType<typeof createModelProviderEnvironmentSignals>,
  platform$: ReturnType<typeof createExecutionPlatform>,
) {
  return computed(async (get) => {
    const { facts } = await get(input$);
    const [modelEnvironment, platform, connectorEnvironment] =
      await Promise.all([
        get(modelEnvironment$),
        get(platform$),
        get(connectorEnvironment$),
      ]);
    if ("status" in connectorEnvironment) {
      throw new Error("Run execution sources are unavailable");
    }
    const data = dataRouterEnvironment();
    const token = facts.okouToken;
    const tokenEnvironment = {
      ...emptyEnvironment(),
      platformEnvironment: { OKOU_TOKEN: token },
      secrets: { OKOU_TOKEN: token },
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
    const effective = {
      ...untrustedEnvironment,
      ...environment.platformEnvironment,
    };
    const keys = new Map<string, string>();
    for (const [key, value] of Object.entries(effective)) {
      if (!keys.has(value)) {
        keys.set(value, key);
      }
    }
    const secretKeys = environment.secrets
      ? Object.values(environment.secrets).flatMap((value) => {
          const key = keys.get(value);
          return key === undefined ? [] : [key];
        })
      : null;
    return { environment, untrustedEnvironment, secretKeys };
  });
}

function createExecutionPreparedContext(
  input$: ExecutionInput$,
  dependencies: {
    readonly model$: ExecutionModel$;
    readonly packages$: ReturnType<typeof createExecutionPackages>;
    readonly environment$: ReturnType<typeof createExecutionEnvironment>;
    readonly storage$: ReturnType<typeof createExecutionStorage>;
    readonly connectorTiming$: ReturnType<
      typeof createExecutionConnectorContext
    >["timing$"];
    readonly networkPolicyInputs$: Computed<
      Promise<ExecutionNetworkPolicyInputs>
    >;
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
    const { environment, untrustedEnvironment, secretKeys } = resolved;
    const prepared: PreparedExecutionContext = {
      ...executionModelConfiguration(run, model),
      customWorkflowSelection: facts.customWorkflowSelection,
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
      secretValueEnvironmentKeys: secretKeys,
      encryptedSecrets: null,
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
    const connectorOperationTimings = get(
      dependencies.connectorTiming$,
    ).snapshot();
    const networkPolicyInputs = prepared.connectorRuntimeTargets.some(
      (target) => {
        return target.kind === "builtin";
      },
    )
      ? await get(dependencies.networkPolicyInputs$)
      : null;
    return {
      context: preparedExecutionContextSchema.parse(prepared),
      secrets: environment.secrets ?? null,
      storageCacheWrites: storage.cacheWrites,
      connectorOperationTimings,
      networkPolicyInputs,
    };
  });
}

function executionModelConfiguration(
  run: ExecutionContextRun,
  model: ExecutionModel,
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
        ? run.officialWorkflowProvenance
          ? run.id
          : run.chatThreadId
        : undefined,
  };
}

function executionOfficialBundles(run: ExecutionContextRun, skillRoot: string) {
  return run.officialWorkflowProvenance?.schemaVersion === 2
    ? run.officialWorkflowProvenance.definitions.map((definition) => {
        return {
          ...definition.contentBundle,
          mountPath: `${skillRoot}/${definition.name}`,
        };
      })
    : [];
}
