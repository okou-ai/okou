import { getFrameworkForType } from "@okouai/api-contracts/contracts/model-providers";
import {
  DISABLED_PAID_TOOLS_ENV_VAR,
  paidToolIdSchema,
} from "@okouai/api-contracts/contracts/paid-tools";
import {
  agentRunConnectorDiagnosticRegistrationPayloadSchema,
  type StoredExecutionContext,
  type PreparedExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { AUTO_RUN_PROVIDER } from "@okouai/core/auto-run-model";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatNetworkBodyCaptures } from "@okouai/db/schema/chat-network-body-capture";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { chatAgentphoneContext } from "@okouai/db/schema/chat-agentphone-context";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { computed, type Computed } from "ccstate";
import { and, asc, eq, inArray } from "drizzle-orm";
import { array, record, string } from "zod";
import { previewAutomationBypassSecret } from "../../lib/preview-automation-bypass";
import { db$ } from "../external/db";
import { safeJsonParse } from "../utils";
import { billableFirewallsForPermissions } from "./built-in-route-pricing";
import { createExecutionConnectorSources } from "./agent-run-context.signals";
import type { ResolvedModelProviderEnvironment } from "./agent-run-contracts";
import { canonicalChatEventUserMessage } from "./canonical-chat-event-read.service";
import { NATIVE_CONTEXT_RECOVERY_PROMPT } from "./chat-session-continuity.service";
import type { ClaimExecutionContextRun } from "./claim-execution-context";
import { createClaimSourceContext } from "./claim-source-context.service";
import type { ConnectorServerFirewallMetadataCatalog } from "./connector-server-firewall-catalog.service";
import { createConnectorsContext } from "./connectors-context.service";
import { createEmailThreadContext } from "./email-queued-launch-context.service";
import { createEmailMailboxConnections } from "./email-mailbox-context.service";
import { dataRouterEnvironment } from "./data-router-environment";
import { createGlobalModelContext } from "./execution-global-model-context.service";
import { createAcceptedExecutionStorageObjects } from "./execution-storage.service";
import { featureSwitchContextFromRows } from "./feature-switch-scope";
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
import type { ResolvedPermissionGrant } from "./user-permission-grants.service";

/** Internal to one Claim; never part of its persisted or Runner context. */
export interface ClaimNetworkPolicyInputs {
  readonly catalog: ConnectorServerFirewallMetadataCatalog;
  readonly grants: readonly ResolvedPermissionGrant[];
  readonly permissionSource: "member" | "agent";
}

type ClaimInput = {
  readonly run: ClaimExecutionContextRun;
  readonly context: StoredExecutionContext;
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
type ClaimSourceContext$ = ReturnType<typeof createClaimSourceContext>;

/** An expected source removal or cancellation, distinct from dependency failures. */
export class ClaimRuntimeUnavailableError extends Error {
  constructor() {
    super("Run execution sources are unavailable");
  }
}

/** All dependencies belong to this Claim; no captured runtime snapshot participates. */
export function createClaimRuntimeContext(input$: ClaimInput$) {
  const sourceContext$ = createClaimSourceContext(
    computed(async (get) => {
      return (await get(input$)).run;
    }),
    computed(async (get) => {
      return (await get(input$)).context.connectorPreparation === undefined;
    }),
  );
  const identities = createClaimIdentities(input$, sourceContext$);
  const { run$, identity$, features$, selectionFeatures$ } = identities;
  const environmentSnapshot$ = computed(async (get) => {
    const captured = await get(sourceContext$);
    if (captured.kind !== "agent") {
      throw new Error("Connector sources require an admitted Agent");
    }
    return captured.environment;
  });
  const sources = createExecutionConnectorSources(
    identity$,
    selectionFeatures$,
    environmentSnapshot$,
  );
  const networkPolicyInputs$ = computed(
    async (get): Promise<ClaimNetworkPolicyInputs> => {
      const [catalog, grants, features] = await Promise.all([
        get(sources.signals.catalog$),
        get(sources.signals.permissionGrants$),
        get(features$),
      ]);
      if (!catalog) {
        throw new Error("Claim builtin targets require a scoped catalog");
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
  const globalRequest$ = computed(async (get) => {
    const run = await get(run$);
    return {
      kind: "claim" as const,
      modelKeyId:
        run.modelProvider === "built-in" ? run.builtInModelKeyId : null,
    };
  });
  const global = createGlobalModelContext(globalRequest$);
  const preferences$ = computed(async (get) => {
    return { timezone: (await get(sourceContext$)).timezone };
  });
  const disabledTools$ = createClaimDisabledTools(input$);
  const connectors = createClaimConnectorContext(
    input$,
    identities,
    sources,
    sourceContext$,
  );
  const model$ = createClaimModel(run$, global, sourceContext$);
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
    { global, storage$, selection$: connectors.connected.connectorSelection$ },
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
  const prompt$ = createClaimPrompt(
    input$,
    initialInput$,
    connectors,
    sources,
    { features$, packages$ },
  );
  return createClaimPreparedContext(input$, {
    prompt$,
    sourceContext$,
    model$,
    initialInput$,
    preferences$,
    packages$,
    environment$,
    storage$,
    connectorTiming$: connectors.timing$,
    networkPolicyInputs$,
  });
}

function createClaimPrompt(
  input$: ClaimInput$,
  initialInput$: InitialInput$,
  connectors: ReturnType<typeof createClaimConnectorContext>,
  sources: ClaimSources,
  dependencies: {
    readonly features$: ClaimIdentities["features$"];
    readonly packages$: ReturnType<typeof createClaimPackages>;
  },
) {
  const { features$, packages$ } = dependencies;
  const emailOrgId$ = computed(async (get) => {
    return (await get(input$)).run.orgId;
  });
  const emailInput$ = computed(async (get) => {
    return (await get(input$)).context.connectorPreparation
      ? await get(initialInput$)
      : null;
  });
  const email$ = createEmailThreadContext(emailInput$, emailOrgId$);
  const mailboxes$ = createEmailMailboxConnections(
    emailInput$,
    connectors.connected.selectedStoredConnectorSources$,
    emailOrgId$,
  );
  const prompt$ = computed(async (get) => {
    const { run, context } = await get(input$);
    if (!context.connectorPreparation) {
      return undefined;
    }
    const [packages, email] = await Promise.all([get(packages$), get(email$)]);
    const systemPromptVariables = {
      ...context.connectorPreparation.systemPromptVariables,
      connectors: packages.connectorPrompt,
    };
    if (!email) {
      return { systemPromptVariables, email: null };
    }
    const mailboxes = await get(mailboxes$);
    if (mailboxes.length === 0) {
      return { systemPromptVariables, email: null };
    }
    const [snapshot, policies, featureSwitchContext] = await Promise.all([
      get(sources.signals.catalog$),
      get(sources.signals.permissionPolicies$),
      get(features$),
    ]);
    if (!snapshot) {
      throw new Error("Email prompt requires its authorized catalog");
    }
    return {
      systemPromptVariables,
      email: {
        email,
        mailboxes,
        snapshot,
        policies,
        featureSwitchContext,
        orgId: run.orgId,
        userId: run.userId,
      },
    };
  });
  return prompt$;
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

function createClaimIdentities(
  input$: ClaimInput$,
  sourceContext$: ClaimSourceContext$,
) {
  const run$ = computed(async (get) => {
    return (await get(input$)).run;
  });
  const identity$ = computed(async (get) => {
    const run = await get(run$);
    if (run.agentId === null) {
      throw new Error("Connector sources require the admitted Agent identity");
    }
    return { orgId: run.orgId, userId: run.userId, agentId: run.agentId };
  });
  const currentFeatures$ = computed(async (get) => {
    const [run, context] = await Promise.all([get(run$), get(sourceContext$)]);
    if (context.kind !== "agent") {
      throw new Error("Connector features require an admitted Agent");
    }
    return featureSwitchContextFromRows(
      run.orgId,
      run.userId,
      context.features,
    );
  });
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
  const selectionFeatures$ = computed(async (get) => {
    const { run, context } = await get(input$);
    const key = FeatureSwitchKey.ConnectorChatAccountAccess;
    const captured = context.featureFlags?.[key];
    if (captured === undefined) {
      return await get(features$);
    }
    // Selection reads only this admitted decision. Do not serialize its current
    // grants/catalog reads behind the independent account/credential capture.
    return {
      orgId: run.orgId,
      userId: run.userId,
      overrides: { [key]: captured },
    };
  });
  return { run$, identity$, features$, selectionFeatures$ };
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
  sourceContext$: ClaimSourceContext$,
) {
  const { run$, identity$, features$ } = identities;
  const targets$ = computed(async (get) => {
    if ((await get(input$)).context.connectorPreparation) {
      return [];
    }
    const context = await get(sourceContext$);
    if (context.kind !== "agent") {
      throw new Error("Connector registrations require an admitted Agent");
    }
    const [row] = context.registrations;
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
    claimOwned$: computed(async (get) => {
      return (await get(input$)).context.connectorPreparation !== undefined;
    }),
    sourceId$: computed(async (get) => {
      return (await get(input$)).context.connectorPreparation?.sourceId;
    }),
    selections$: computed(async (get) => {
      const intent = (await get(input$)).context.connectorPreparation;
      if (intent) {
        return intent.threadSelections;
      }
      const context = await get(sourceContext$);
      if (context.kind !== "agent") {
        throw new Error("Connector selections require an admitted Agent");
      }
      return context.selections;
    }),
    accessOverrides$: computed(async (get) => {
      const context = await get(sourceContext$);
      if (context.kind !== "agent") {
        throw new Error("Connector access requires an admitted Agent");
      }
      return context.accessOverrides;
    }),
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
  return { bodyEnvironment$, connectorEnvironment$, timing$, connected };
}

function createClaimModel(
  run$: ClaimRun$,
  global: GlobalModels,
  sourceContext$: ClaimSourceContext$,
) {
  const memberIdentity$ = computed(async (get) => {
    const run = await get(run$);
    return { orgId: run.orgId, userId: run.userId, runId: run.id };
  });
  const agentlessMemberModels$ = createRunModelSources(memberIdentity$);
  const memberModels$ = computed(async (get) => {
    if ((await get(run$)).agentId === null) {
      return await get(agentlessMemberModels$);
    }
    const captured = await get(sourceContext$);
    if (captured.kind !== "agent" || captured.memberModels === undefined) {
      throw new Error(
        "Admitted personal model requires captured member sources",
      );
    }
    return captured.memberModels;
  });
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
        contextId: chatEvents.contextId,
        chatThreadId: chatEvents.chatThreadId,
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
    selection$,
  }: {
    readonly global: GlobalModels;
    readonly storage$: ReturnType<typeof createClaimStorage>;
    readonly selection$: ReturnType<
      typeof createClaimConnectedAccounts
    >["connectorSelection$"];
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
    computed(async (get) => {
      const authorized = await get(sources.signals.authorizedConnectors$);
      if (
        (await get(input$)).context.featureFlags?.[
          FeatureSwitchKey.ConnectorChatAccountAccess
        ] !== true
      ) {
        return authorized;
      }
      const selection = await get(selection$);
      if ("status" in selection) {
        throw new ClaimRuntimeUnavailableError();
      }
      return authorized.filter((connector) => {
        return connector.kind === "builtin"
          ? selection.connectorScope.allowedConnectorSlugs.includes(
              connector.connectorSlug,
            )
          : selection.connectorScope.allowedCustomConnectorIds.includes(
              connector.customConnectorId,
            );
      });
    }),
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
    return {
      seedSkillBundles,
      templateGuidanceBundles,
      skillRoot,
      connectorPrompt: connectors?.systemPromptVariables.connectors,
    };
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
    readonly prompt$: Computed<
      Promise<
        | import("./claim-connector-prompt.service").ClaimPromptPreparation
        | undefined
      >
    >;
    readonly sourceContext$: ClaimSourceContext$;
    readonly model$: ClaimModel$;
    readonly initialInput$: InitialInput$;
    readonly preferences$: Computed<
      Promise<{ readonly timezone: string | undefined }>
    >;
    readonly packages$: ReturnType<typeof createClaimPackages>;
    readonly environment$: ReturnType<typeof createClaimEnvironment>;
    readonly storage$: ReturnType<typeof createClaimStorage>;
    readonly connectorTiming$: ReturnType<
      typeof createClaimConnectorContext
    >["timing$"];
    readonly networkPolicyInputs$: Computed<Promise<ClaimNetworkPolicyInputs>>;
  },
) {
  return computed(async (get) => {
    const { run, context } = await get(input$);
    // Start the shared launch-critical capture before independent hydration.
    // Joining it below retains error ownership without serializing other reads.
    const sourceContext = get(dependencies.sourceContext$);
    const [model, originalInput, preferences, packages, resolved, storage] =
      await Promise.all([
        get(dependencies.model$),
        get(dependencies.initialInput$),
        get(dependencies.preferences$),
        get(dependencies.packages$),
        get(dependencies.environment$),
        get(dependencies.storage$),
        sourceContext,
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
      prompt: await get(dependencies.prompt$),
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
