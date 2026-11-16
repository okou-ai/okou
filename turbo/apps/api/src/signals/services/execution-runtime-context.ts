import { getFrameworkForType } from "@okouai/api-contracts/contracts/model-providers";
import {
  DISABLED_PAID_TOOLS_ENV_VAR,
  paidToolIdSchema,
} from "@okouai/api-contracts/contracts/paid-tools";
import type {
  ExecutionInput as AdmittedExecutionInput,
  PreparedExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { AUTO_RUN_PROVIDER } from "@okouai/core/auto-run-model";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { computed, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { array, record, string } from "zod";
import { previewAutomationBypassSecret } from "../../lib/preview-automation-bypass";
import { db$ } from "../external/db";
import { safeJsonParse } from "../utils";
import { billableFirewallsForPermissions } from "./built-in-route-pricing";
import { createExecutionConnectorSources } from "./agent-run-context.signals";
import type { ResolvedModelProviderEnvironment } from "./agent-run-contracts";
import type { AdmittedExecutionFacts } from "./admitted-execution-facts";
import { NATIVE_CONTEXT_RECOVERY_PROMPT } from "./chat-session-continuity.service";
import type { ExecutionContextRun } from "./execution-context";
import type { ConnectorServerFirewallMetadataCatalog } from "./connector-server-firewall-catalog.service";
import { createConnectorSkillVolumes } from "./connectors-context.service";
import { dataRouterEnvironment } from "./data-router-environment";
import { createExecutionSeedSkills } from "./execution-global-model-context.service";
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
import {
  emptyEnvironment,
  environmentPermissionManifest,
  mergeEnvironments,
} from "./run-environment";
import {
  mergeRunSkillVolumes,
  resolveRunSkillVolumes,
} from "./run-prompt-and-skills";
import { createRunTemplatePackages } from "./run-templates.service";
import { storedMountFromPrepared } from "./run-storage-manifest.service";
import {
  DEFAULT_DISALLOWED_TOOLS,
  runPlatformEnvironment,
} from "./run-execution-defaults";
import { normalizeMountOverlay } from "./storage-mount-overlay";
import { createSystemSkillsContext } from "./system-skills-context.service";
import { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import { createExecutionConnectedAccounts } from "./thread-connected-accounts.signals";
import { createConnectorEnvironmentSignals } from "./thread-connector-environment.signals";
import {
  createModelProviderEnvironmentSignals,
  paidToolPlatformEnvironment,
} from "./thread-environment.signals";
import type { ResolvedPermissionGrant } from "./user-permission-grants.service";

/** Internal to one execution; never part of its persisted or Runner context. */
export interface ExecutionNetworkPolicyInputs {
  readonly catalog: ConnectorServerFirewallMetadataCatalog;
  readonly grants: readonly ResolvedPermissionGrant[];
  readonly permissionSource: "member" | "agent";
}

type ExecutionInput = {
  readonly run: ExecutionContextRun;
  readonly context: AdmittedExecutionInput;
  readonly facts: AdmittedExecutionFacts;
};

const variablesSchema = record(string(), string()).nullable();
type ExecutionInput$ = Computed<Promise<ExecutionInput>>;
type ExecutionRun$ = Computed<Promise<ExecutionContextRun>>;
type ExecutionIdentities = ReturnType<typeof createExecutionIdentities>;
type ExecutionSources = ReturnType<typeof createExecutionConnectorSources>;
type ExecutionModel$ = ReturnType<typeof createExecutionModel>;
type ExecutionModel =
  ExecutionModel$ extends Computed<infer T> ? Awaited<T> : never;
type DisabledTools$ = Computed<Promise<readonly string[]>>;

/** Assemble runtime input from this Run's authoritative sources. */
export function createExecutionRuntimeContext(input$: ExecutionInput$) {
  const identities = createExecutionIdentities(input$);
  const { run$, identity$, features$ } = identities;
  const sources = createExecutionConnectorSources(identity$, features$);
  const networkPolicyInputs$ = computed(
    async (get): Promise<ExecutionNetworkPolicyInputs> => {
      const [catalog, grants, features] = await Promise.all([
        get(sources.signals.catalog$),
        get(sources.signals.permissionGrants$),
        get(features$),
      ]);
      if (!catalog) {
        throw new Error("Execution builtin targets require a scoped catalog");
      }
      return {
        catalog: catalog.serverFirewalls,
        grants,
        permissionSource: isFeatureEnabled(
          FeatureSwitchKey.ConnectorChatAccountAccess,
          features,
        )
          ? "member"
          : "agent",
      };
    },
  );
  const seedSkills$ = createExecutionSeedSkills();
  const preferences$ = createExecutionPreferences(run$);
  const disabledTools$ = createExecutionDisabledTools(input$);
  const connectors = createExecutionConnectorContext(
    input$,
    identities,
    sources,
  );
  const model$ = createExecutionModel(input$);
  const modelRoute$ = computed(async (get) => {
    return (await get(model$))?.provider ?? null;
  });
  const modelEnvironment$ = createModelProviderEnvironmentSignals(
    connectors.runVariables$,
    modelRoute$,
  );
  const storage$ = createExecutionStorage(input$);
  const packages$ = createExecutionPackages(input$, disabledTools$, sources, {
    seedSkills$,
    storage$,
  });
  const platform$ = createExecutionPlatform(input$, model$, disabledTools$);
  const environment$ = createExecutionEnvironment(
    input$,
    connectors.connectorEnvironment$,
    modelEnvironment$,
    platform$,
  );
  return createExecutionPreparedContext(input$, {
    model$,
    preferences$,
    packages$,
    environment$,
    storage$,
    connectorTiming$: connectors.timing$,
    networkPolicyInputs$,
  });
}

function createExecutionStorage(input$: ExecutionInput$) {
  const mounts$ = computed(async (get) => {
    const { run } = await get(input$);
    if (run.storageMounts === null) {
      throw new Error("Admitted Run is missing its accepted Storage mounts");
    }
    return run.storageMounts;
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
    if (run.agentId === null) {
      throw new Error("Connector sources require the admitted Agent identity");
    }
    return { orgId: run.orgId, userId: run.userId, agentId: run.agentId };
  });
  const currentFeatures$ = createUserFeatureSwitchContext(memberIdentity$);
  const features$ = computed(async (get) => {
    const [current, input] = await Promise.all([
      get(currentFeatures$),
      get(input$),
    ]);
    const overrides = { ...current.overrides };
    for (const key of [
      FeatureSwitchKey.SingleAgent,
      FeatureSwitchKey.ConnectorChatAccountAccess,
    ]) {
      const captured = input.context.featureFlags?.[key];
      if (captured !== undefined) {
        overrides[key] = captured;
      }
    }
    return {
      ...current,
      userId: input.run.userId,
      orgId: input.run.orgId,
      overrides,
    };
  });
  return { run$, identity$, features$ };
}

function createExecutionPreferences(run$: ExecutionRun$) {
  return computed(async (get) => {
    const run = await get(run$);
    const [row] = await get(db$)
      .select({ timezone: orgMembersMetadata.timezone })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, run.orgId),
          eq(orgMembersMetadata.userId, run.userId),
        ),
      );
    return { timezone: row?.timezone ?? undefined };
  });
}

function createExecutionDisabledTools(input$: ExecutionInput$) {
  return computed(async (get) => {
    // The emitted prompt already embodies this Run's tool choices. Current
    // preferences cannot reconstruct that decision after a later edit.
    const { context } = await get(input$);
    return array(paidToolIdSchema).parse(
      safeJsonParse(context.platformEnvironment[DISABLED_PAID_TOOLS_ENV_VAR]),
    );
  });
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
    if (run.chatThreadId === null) {
      throw new Error(
        "Connector accounts require the admitted Thread identity",
      );
    }
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
    const { run } = await get(input$);
    return variablesSchema.parse(run.vars) ?? undefined;
  });
  const connectorEnvironment$ = createConnectorEnvironmentSignals(
    {
      runVariables$,
      permissionPolicies$: sources.signals.permissionPolicies$,
      featureSwitches$: features$,
    },
    {
      connectorSelection$: connected.connectorSelection$,
      connectorSnapshot$: connected.connectorSnapshot$,
      selectedConnectorSources$: connected.selectedStoredConnectorSources$,
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
    if (run.modelProvider === null) {
      return null;
    }
    if (
      !run.selectedModel ||
      !run.modelRuntimeModel ||
      !run.modelRuntimeProvider
    ) {
      throw new Error("Admitted Run is missing its pinned model route");
    }
    const piExecution = run.launchSnapshot?.framework === "pi";
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
          apiKey: builtInModelKeys.apiKey,
        })
        .from(builtInModelKeys)
        .where(eq(builtInModelKeys.id, run.builtInModelKeyId));
      const source = managedSourceFromSnapshot(key);
      if (!source) {
        throw new Error("Run execution sources are unavailable");
      }
      provider = await prepareManagedModelEnvironment(source, {
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
  disabledTools$: DisabledTools$,
  sources: ExecutionSources,
  {
    seedSkills$,
    storage$,
  }: {
    readonly seedSkills$: ReturnType<typeof createExecutionSeedSkills>;
    readonly storage$: ReturnType<typeof createExecutionStorage>;
  },
) {
  const templateInput$ = computed(async (get) => {
    const { templateInput } = (await get(input$)).facts;
    return templateInput.userMessage ? templateInput : null;
  });
  const templates$ = createRunTemplatePackages(
    templateInput$,
    computed(async (get) => {
      return (await get(input$)).run.orgId;
    }),
    disabledTools$,
  );
  const seeds$ = createSystemSkillsContext(disabledTools$, seedSkills$);
  const connectorSkills$ = createConnectorSkillVolumes(
    sources.signals.authorizedConnectors$,
  );
  return computed(async (get) => {
    const { run } = await get(input$);
    const framework = executionFramework(run);
    const skillRoot =
      framework === "pi"
        ? "/home/user/.pi/agent/skills"
        : framework === "codex"
          ? "/home/user/.codex/skills"
          : "/home/user/.claude/skills";
    const [seedSkills, connectors, templates] =
      run.agentId === null
        ? [undefined, undefined, undefined]
        : await Promise.all([
            get(seeds$),
            get(connectorSkills$),
            get(templates$),
          ]);
    if (templates && "error" in templates) {
      throw new Error("Run execution sources are unavailable");
    }
    const parts = [
      connectors,
      seedSkills?.skillVolumes,
      templates?.skillVolumes,
    ].filter((part) => {
      return part !== undefined;
    });
    const volumes = resolveRunSkillVolumes(
      mergeRunSkillVolumes(parts),
      skillRoot,
    );
    const winners = normalizeMountOverlay([
      ...volumes,
      ...(await get(storage$)).storageMounts,
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
    return { seedSkillBundles, templateGuidanceBundles, skillRoot };
  });
}

function executionFramework(run: ExecutionContextRun) {
  const framework = run.launchSnapshot?.framework;
  if (!framework) {
    throw new Error("Admitted Run is missing its execution framework");
  }
  return framework;
}

function createExecutionPlatform(
  input$: ExecutionInput$,
  model$: ExecutionModel$,
  disabledTools$: DisabledTools$,
) {
  return computed(async (get) => {
    const [{ run, context, facts }, model, disabledTools] = await Promise.all([
      get(input$),
      get(model$),
      get(disabledTools$),
    ]);
    const framework = executionFramework(run);
    const integration = facts.integration;
    const bypass = context.previewBypassAuthorized
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
          modelProviderType: model?.provider.type ?? null,
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
    const { run, context } = await get(input$);
    const [modelEnvironment, platform, connectorEnvironment] =
      await Promise.all([
        get(modelEnvironment$),
        get(platform$),
        run.agentId === null ? emptyEnvironment() : get(connectorEnvironment$),
      ]);
    if ("status" in connectorEnvironment || "status" in modelEnvironment) {
      throw new Error("Run execution sources are unavailable");
    }
    const data = dataRouterEnvironment();
    const token = context.platformEnvironment.OKOU_TOKEN;
    const tokenEnvironment = {
      ...emptyEnvironment(),
      platformEnvironment:
        token === undefined ? undefined : { OKOU_TOKEN: token },
      secrets: token === undefined ? undefined : { OKOU_TOKEN: token },
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
        return (
          !key.startsWith("OKOU_") &&
          (token === undefined || !key.startsWith("ZERO_"))
        );
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
    readonly preferences$: ReturnType<typeof createExecutionPreferences>;
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
    const { run, context, facts } = await get(input$);
    const [model, preferences, packages, resolved, storage] = await Promise.all(
      [
        get(dependencies.model$),
        get(dependencies.preferences$),
        get(dependencies.packages$),
        get(dependencies.environment$),
        get(dependencies.storage$),
      ],
    );
    const { environment, untrustedEnvironment, secretKeys } = resolved;
    const prepared: PreparedExecutionContext = {
      ...context,
      ...executionModelConfiguration(run, model),
      storageMounts: storage.storageMounts,
      nativeContinuation: {
        ...context.nativeContinuation,
        recoveryPrompt:
          context.nativeContinuation.recoveryPrompt === null
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
        modelProvider: model?.provider ?? null,
        permissions: environmentPermissionManifest(environment),
      }),
      disallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
      userTimezone: preferences.timezone,
      captureNetworkBodies: facts.captureNetworkBodies ? true : undefined,
      seedSkillBundles: packages.seedSkillBundles,
      officialWorkflowBundles: executionOfficialBundles(
        run,
        packages.skillRoot,
      ),
      templateGuidanceBundles: packages.templateGuidanceBundles,
    };
    return {
      context: prepared,
      secrets: environment.secrets ?? null,
      storageCacheWrites: storage.cacheWrites,
      connectorOperationTimings: get(dependencies.connectorTiming$).snapshot(),
      networkPolicyInputs: prepared.connectorRuntimeTargets.some((target) => {
        return target.kind === "builtin";
      })
        ? await get(dependencies.networkPolicyInputs$)
        : null,
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
  const framework = executionFramework(run);
  return {
    cliAgentType: framework,
    modelUsageProvider:
      run.modelProvider === "built-in"
        ? (run.modelUsageProvider ?? undefined)
        : (run.selectedModel ?? undefined),
    modelUsageLongContextMinTotalInputTokens:
      run.modelProvider === "built-in"
        ? (run.modelLongContextMinTotalInputTokens ?? undefined)
        : 0,
    codexRuntimeConfig: model?.provider.codexRuntimeConfig ?? null,
    piModelConfig: model?.piModelConfig,
    piLaunchConfig: framework === "pi" ? { schemaVersion: 2 } : undefined,
    piSessionId:
      framework === "pi"
        ? run.officialWorkflowProvenance
          ? run.id
          : (run.chatThreadId ?? run.id)
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
