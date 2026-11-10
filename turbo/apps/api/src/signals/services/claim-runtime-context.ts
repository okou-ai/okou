import { getFrameworkForType } from "@okouai/api-contracts/contracts/model-providers";
import {
  DISABLED_PAID_TOOLS_ENV_VAR,
  paidToolIdSchema,
} from "@okouai/api-contracts/contracts/paid-tools";
import {
  agentRunConnectorDiagnosticRegistrationPayloadSchema,
  type claimExecutionInputSchema,
  type PreparedExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { AUTO_RUN_PROVIDER } from "@okouai/core/auto-run-model";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatNetworkBodyCaptures } from "@okouai/db/schema/chat-network-body-capture";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { chatAgentphoneContext } from "@okouai/db/schema/chat-agentphone-context";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { computed, type Computed } from "ccstate";
import { and, asc, eq, inArray } from "drizzle-orm";
import { array, record, string, type infer as zInfer } from "zod";
import { previewAutomationBypassSecret } from "../../lib/preview-automation-bypass";
import { db$ } from "../external/db";
import { safeJsonParse } from "../utils";
import { billableFirewallsForPermissions } from "./built-in-route-pricing";
import { createExecutionConnectorSources } from "./agent-run-context.signals";
import type { ResolvedModelProviderEnvironment } from "./agent-run-contracts";
import { canonicalChatEventUserMessage } from "./canonical-chat-event-read.service";
import { NATIVE_CONTEXT_RECOVERY_PROMPT } from "./chat-session-continuity.service";
import type { ClaimExecutionContextRun } from "./claim-execution-context";
import { createConnectorsContext } from "./connectors-context.service";
import { dataRouterEnvironment } from "./data-router-environment";
import { createGlobalModelContext } from "./execution-global-model-context.service";
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
  materializePreparedPiProvider,
  resolvePreparedPiModelConfig,
} from "./pi-sandbox-config";
import {
  emptyEnvironment,
  environmentPermissionManifest,
  mergeEnvironments,
} from "./run-environment";
import {
  mergeRunPromptAndSkills,
  resolveRunSkillVolumes,
} from "./run-prompt-and-skills";
import { createRunTemplates } from "./run-templates.service";
import { storedMountFromPrepared } from "./run-storage-manifest.service";
import {
  DEFAULT_DISALLOWED_TOOLS,
  runPlatformEnvironment,
} from "./run-execution-defaults";
import { normalizeMountOverlay } from "./storage-mount-overlay";
import { createSystemSkillsContext } from "./system-skills-context.service";
import { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import { createClaimConnectedAccounts } from "./thread-connected-accounts.signals";
import { createConnectorEnvironmentSignals } from "./thread-connector-environment.signals";
import {
  createModelProviderEnvironmentSignals,
  paidToolPlatformEnvironment,
} from "./thread-environment.signals";

type ClaimInput = {
  readonly run: ClaimExecutionContextRun;
  readonly context: zInfer<typeof claimExecutionInputSchema>;
};

const variablesSchema = record(string(), string()).nullable();
type ClaimInput$ = Computed<Promise<ClaimInput>>;
type ClaimRun$ = Computed<Promise<ClaimExecutionContextRun>>;
type ClaimIdentities = ReturnType<typeof createClaimIdentities>;
type ClaimSources = ReturnType<typeof createExecutionConnectorSources>;
type GlobalModels = ReturnType<typeof createGlobalModelContext>;
type ClaimModel$ = ReturnType<typeof createClaimModel>;
type ClaimModel = ClaimModel$ extends Computed<infer T> ? Awaited<T> : never;
type InitialInput$ = ReturnType<typeof createClaimInitialInput>;
type InitialInput =
  InitialInput$ extends Computed<infer T> ? Awaited<T> : never;
type DisabledTools$ = Computed<Promise<readonly string[]>>;

/** An expected source removal or cancellation, distinct from dependency failures. */
export class ClaimRuntimeUnavailableError extends Error {
  constructor() {
    super("Run execution sources are unavailable");
  }
}

/** All dependencies belong to this Claim; no captured runtime snapshot participates. */
export function createClaimRuntimeContext(input$: ClaimInput$) {
  const identities = createClaimIdentities(input$);
  const { run$, identity$, features$ } = identities;
  const sources = createExecutionConnectorSources(identity$, features$);
  const global = createGlobalModelContext();
  const preferences$ = createClaimPreferences(run$);
  const disabledTools$ = createClaimDisabledTools(input$);
  const connectors = createClaimConnectorContext(input$, identities, sources);
  const model$ = createClaimModel(run$, global);
  const modelRoute$ = computed(async (get) => {
    return (await get(model$))?.provider ?? null;
  });
  const modelEnvironment$ = createModelProviderEnvironmentSignals(
    { bodyEnvironment$: connectors.bodyEnvironment$ },
    { modelRoute$ },
  );
  const initialInput$ = createClaimInitialInput(run$);
  const storage$ = createClaimStorage(input$);
  const packages$ = createClaimPackages(
    input$,
    initialInput$,
    disabledTools$,
    sources,
    { global, storage$ },
  );
  const platform$ = createClaimPlatform(
    input$,
    model$,
    initialInput$,
    disabledTools$,
  );
  const environment$ = createClaimEnvironment(
    input$,
    connectors.connectorEnvironment$,
    modelEnvironment$,
    platform$,
  );
  return createClaimPreparedContext(input$, {
    model$,
    initialInput$,
    preferences$,
    packages$,
    environment$,
    storage$,
  });
}

function createClaimStorage(input$: ClaimInput$) {
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

function createClaimIdentities(input$: ClaimInput$) {
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

function createClaimPreferences(run$: ClaimRun$) {
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

function createClaimDisabledTools(input$: ClaimInput$) {
  return computed(async (get) => {
    // The emitted prompt already embodies this Run's tool choices. Current
    // preferences cannot reconstruct that decision after a queued edit.
    const { context } = await get(input$);
    return array(paidToolIdSchema).parse(
      safeJsonParse(context.platformEnvironment[DISABLED_PAID_TOOLS_ENV_VAR]),
    );
  });
}

function createClaimConnectorContext(
  input$: ClaimInput$,
  identities: ClaimIdentities,
  sources: ClaimSources,
) {
  const { run$, identity$, features$ } = identities;
  const targets$ = computed(async (get) => {
    const run = await get(run$);
    const [row] = await get(db$)
      .select({ payload: agentRunConnectorDiagnosticRegistrations.payload })
      .from(agentRunConnectorDiagnosticRegistrations)
      .where(eq(agentRunConnectorDiagnosticRegistrations.runId, run.id));
    if (!row) {
      throw new ClaimRuntimeUnavailableError();
    }
    return agentRunConnectorDiagnosticRegistrationPayloadSchema.parse(
      row.payload,
    ).targets;
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
  const connected = createClaimConnectedAccounts({
    identity$: connectorIdentity$,
    targets$,
    scope$: sources.signals.connectorScope$,
    catalog$: sources.signals.catalog$,
    definitions$: sources.signals.customConnectorDefinitions$,
    connectors$: sources.signals.connectors$,
    policies$: sources.signals.permissionPolicies$,
    features$: features$,
    timing$,
  });
  const bodyEnvironment$ = computed(async (get) => {
    const { run, context } = await get(input$);
    const token = context.platformEnvironment.OKOU_TOKEN;
    return {
      vars: variablesSchema.parse(run.vars) ?? undefined,
      secrets: token === undefined ? undefined : { OKOU_TOKEN: token },
    };
  });
  const connectorEnvironment$ = createConnectorEnvironmentSignals(
    {
      bodyEnvironment$,
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
  return { bodyEnvironment$, connectorEnvironment$ };
}

function createClaimModel(run$: ClaimRun$, global: GlobalModels) {
  const memberIdentity$ = computed(async (get) => {
    const run = await get(run$);
    return { orgId: run.orgId, userId: run.userId, runId: run.id };
  });
  const memberModels$ = createRunModelSources(memberIdentity$);
  return computed(async (get) => {
    const run = await get(run$);
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
    const catalog = await get(global.catalog$);
    const piExecution = run.launchSnapshot?.framework === "pi";
    const preparation = {
      catalog,
      piExecution,
      codexServiceTier:
        run.codexServiceTier === "fast" ? ("fast" as const) : undefined,
      reasoningEffort: run.reasoningEffort,
    };
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
      const key = (await get(global.managedModelKeys$)).find((candidate) => {
        return candidate.id === run.builtInModelKeyId;
      });
      const source = managedSourceFromSnapshot(key);
      if (!source) {
        throw new ClaimRuntimeUnavailableError();
      }
      provider = await prepareManagedModelEnvironment(source, {
        catalog,
        framework: getFrameworkForType(AUTO_RUN_PROVIDER),
        selectedModelOverride: run.selectedModel,
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
        throw new ClaimRuntimeUnavailableError();
      }
      const source = memberAccountSourceFromSnapshot(members, account.id);
      if (!source) {
        throw new ClaimRuntimeUnavailableError();
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
      throw new ClaimRuntimeUnavailableError();
    }
    const resolved = materializePreparedPiProvider(preparation, provider);
    return {
      provider: resolved,
      piModelConfig: resolvePreparedPiModelConfig({
        input: preparation,
        modelProvider: resolved,
      }),
    };
  });
}

function createClaimInitialInput(run$: ClaimRun$) {
  return computed(async (get) => {
    const run = await get(run$);
    const [row] = await get(db$)
      .select({
        userMessage: canonicalChatEventUserMessage(),
        contextType: chatEvents.contextType,
        captureId: chatNetworkBodyCaptures.chatEventId,
        phoneChannel: chatAgentphoneContext.channel,
        feishuPlatform: feishuOrgInstallations.platform,
      })
      .from(chatEvents)
      .leftJoin(
        chatNetworkBodyCaptures,
        and(
          eq(chatNetworkBodyCaptures.chatEventId, chatEvents.revokesEventId),
          eq(chatNetworkBodyCaptures.chatThreadId, chatEvents.chatThreadId),
        ),
      )
      .leftJoin(
        chatAgentphoneContext,
        and(
          eq(chatEvents.contextType, "agentphone"),
          eq(chatAgentphoneContext.id, chatEvents.contextId),
          eq(chatAgentphoneContext.chatThreadId, chatEvents.chatThreadId),
        ),
      )
      .leftJoin(
        chatFeishuContext,
        and(
          eq(chatEvents.contextType, "feishu"),
          eq(chatFeishuContext.id, chatEvents.contextId),
          eq(chatFeishuContext.chatThreadId, chatEvents.chatThreadId),
        ),
      )
      .leftJoin(
        feishuOrgInstallations,
        and(
          eq(feishuOrgInstallations.id, chatFeishuContext.installationId),
          eq(feishuOrgInstallations.orgId, run.orgId),
        ),
      )
      .where(
        and(
          eq(chatEvents.runId, run.id),
          inArray(chatEvents.eventType, ["input.prompt", "input.automation"]),
        ),
      )
      .orderBy(asc(chatEvents.seqId))
      .limit(1);
    return row ? { ...row, userId: run.userId } : null;
  });
}

function createClaimPackages(
  input$: ClaimInput$,
  initialInput$: InitialInput$,
  disabledTools$: DisabledTools$,
  sources: ClaimSources,
  {
    global,
    storage$,
  }: {
    readonly global: GlobalModels;
    readonly storage$: ReturnType<typeof createClaimStorage>;
  },
) {
  const templateInput$ = computed(async (get) => {
    const input = await get(initialInput$);
    return input?.userMessage ? input : null;
  });
  const templates$ = createRunTemplates(
    templateInput$,
    computed(async (get) => {
      return (await get(input$)).run.orgId;
    }),
    disabledTools$,
  );
  const seeds$ = createSystemSkillsContext(disabledTools$, global.seedSkills$);
  const connectorSkills$ = createConnectorsContext(
    sources.signals.authorizedConnectors$,
    computed(async (get) => {
      return (
        (await get(input$)).context.featureFlags?.[
          FeatureSwitchKey.SingleAgent
        ] === true
      );
    }),
  );
  return computed(async (get) => {
    const { run } = await get(input$);
    const framework = claimFramework(run);
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
      throw new ClaimRuntimeUnavailableError();
    }
    const parts = [connectors, seedSkills, templates].filter((part) => {
      return part !== undefined;
    });
    const volumes = resolveRunSkillVolumes(
      mergeRunPromptAndSkills(parts).skillVolumes,
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

function claimFramework(run: ClaimExecutionContextRun) {
  const framework = run.launchSnapshot?.framework;
  if (!framework) {
    throw new Error("Admitted Run is missing its execution framework");
  }
  return framework;
}

function claimIntegration(input: InitialInput) {
  switch (input?.contextType) {
    case "web":
    case "agent_run": {
      return "web";
    }
    case "feishu": {
      return input.feishuPlatform;
    }
    case "agentphone": {
      return input.phoneChannel === "whatsapp" ? "whatsapp" : "phone";
    }
    case "automation": {
      return undefined;
    }
    default: {
      return input?.contextType;
    }
  }
}

function createClaimPlatform(
  input$: ClaimInput$,
  model$: ClaimModel$,
  initialInput$: InitialInput$,
  disabledTools$: DisabledTools$,
) {
  return computed(async (get) => {
    const [{ run, context }, model, originalInput, disabledTools] =
      await Promise.all([
        get(input$),
        get(model$),
        get(initialInput$),
        get(disabledTools$),
      ]);
    const framework = claimFramework(run);
    const integration = claimIntegration(originalInput);
    const bypass = context.platformEnvironment.VERCEL_AUTOMATION_BYPASS_SECRET
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
          modelProviderType: model?.provider?.type ?? null,
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

function createClaimEnvironment(
  input$: ClaimInput$,
  connectorEnvironment$: ReturnType<
    typeof createClaimConnectorContext
  >["connectorEnvironment$"],
  modelEnvironment$: ReturnType<typeof createModelProviderEnvironmentSignals>,
  platform$: ReturnType<typeof createClaimPlatform>,
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
      throw new ClaimRuntimeUnavailableError();
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

function createClaimPreparedContext(
  input$: ClaimInput$,
  dependencies: {
    readonly model$: ClaimModel$;
    readonly initialInput$: InitialInput$;
    readonly preferences$: ReturnType<typeof createClaimPreferences>;
    readonly packages$: ReturnType<typeof createClaimPackages>;
    readonly environment$: ReturnType<typeof createClaimEnvironment>;
    readonly storage$: ReturnType<typeof createClaimStorage>;
  },
) {
  return computed(async (get) => {
    const { run, context } = await get(input$);
    const [model, originalInput, preferences, packages, resolved, storage] =
      await Promise.all([
        get(dependencies.model$),
        get(dependencies.initialInput$),
        get(dependencies.preferences$),
        get(dependencies.packages$),
        get(dependencies.environment$),
        get(dependencies.storage$),
      ]);
    const { environment, untrustedEnvironment, secretKeys } = resolved;
    const prepared: PreparedExecutionContext = {
      ...context,
      ...claimModelConfiguration(run, model),
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
      captureNetworkBodies: originalInput?.captureId ? true : undefined,
      seedSkillBundles: packages.seedSkillBundles,
      officialWorkflowBundles: claimOfficialBundles(run, packages.skillRoot),
      templateGuidanceBundles: packages.templateGuidanceBundles,
    };
    return {
      context: prepared,
      secrets: environment.secrets ?? null,
      storageCacheWrites: storage.cacheWrites,
    };
  });
}

function claimModelConfiguration(
  run: ClaimExecutionContextRun,
  model: ClaimModel,
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
  const framework = claimFramework(run);
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
    codexRuntimeConfig: model?.provider?.codexRuntimeConfig ?? null,
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

function claimOfficialBundles(
  run: ClaimExecutionContextRun,
  skillRoot: string,
) {
  return run.officialWorkflowProvenance?.schemaVersion === 2
    ? run.officialWorkflowProvenance.definitions.map((definition) => {
        return {
          ...definition.contentBundle,
          mountPath: `${skillRoot}/${definition.name}`,
        };
      })
    : [];
}
