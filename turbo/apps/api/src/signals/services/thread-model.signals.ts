import {
  getFrameworkForType,
  isBuiltInModelProviderType,
  type ModelProviderCredentialScope,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  AUTO_RUN_KEY_VENDOR,
  isAutoSelectedModel,
} from "@okouai/core/auto-run-model";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import {
  getValidatedFramework,
  type SupportedFramework,
} from "@okouai/core/frameworks";
import { piCatalogModel } from "@okouai/core/pi-execution";
import { computed, type Computed } from "ccstate";
import {
  badRequestMessage,
  conflict,
  insufficientCredits,
  providerUnavailable,
} from "../../lib/error";
import { usagePricingResolution$ } from "../context/usage-pricing-resolution";
import { safeSync, settle } from "../utils";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import type {
  AgentRunModelPin,
  ResolvedModelProviderEnvironment,
} from "./agent-run-contracts";
import { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import {
  type BuiltInModelRuntimeRoute,
  builtInModelRuntimeRouteFromSnapshot,
  isBuiltInModelRuntimeRoutePermitted,
  unpricedBuiltInModelMessage,
} from "./built-in-model-runtime-route.service";
import { builtInRoutePricingFromSnapshot } from "./built-in-route-pricing";
import type { QueueFirstRunAssociation } from "./chat-queued-event.service";
import { resolveReasoningEffortForDispatch } from "./chat-reasoning-effort.service";
import { isMemberSubscriptionRoute } from "./effective-model-route.service";
import { memberSubscriptionModelRoutesFromCatalog } from "./member-subscription-models.service";
import type { ModelCatalog } from "./model-catalog.service";
import {
  isPersonalSubscriptionProviderType,
  type MemberModelAccountSnapshot,
} from "./model-provider-account.service";
import {
  prepareManagedModelEnvironment,
  prepareSubscriptionModelEnvironment,
} from "./model-provider.service";
import {
  type ModelFirstPin,
  resolveQueuedModelSelectionPinFromSnapshot,
} from "./model-selection.service";
import {
  managedSourceFromSnapshot,
  memberAccountSourceFromSnapshot,
} from "./model-source-context.service";
import { PiModelConfigurationError } from "./pi-model-configuration-error";
import {
  materializePreparedPiProvider,
  shouldUsePiExecution,
} from "./pi-sandbox-config";
import { checkOrgPlanRunAdmission } from "./run-admission.service";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

export type ThreadModelError =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof conflict>
  | ReturnType<typeof insufficientCredits>
  | ReturnType<typeof providerUnavailable>
  | NonNullable<ReturnType<typeof checkOrgPlanRunAdmission>>
  | {
      readonly status: 503;
      readonly body: {
        readonly error: {
          readonly code: "MODEL_PROVIDER_UNAVAILABLE";
          readonly message: string;
        };
      };
    };

export type QueuedModelContext =
  | ThreadModelError
  | {
      readonly pin: ModelFirstPin;
      readonly providerAdmission: {
        readonly effectiveModelProvider: string | null | undefined;
        readonly cliAgentType: string | null;
        readonly error: ThreadModelError | undefined;
      };
      readonly featureSwitchContext: FeatureSwitchContext;
      readonly runCodexServiceTier: "fast" | undefined;
      readonly reasoningEffort: ReasoningEffort | undefined;
      readonly builtInModelRuntimeRoute:
        BuiltInModelRuntimeRoute | null | undefined;
      readonly memberAccountSnapshot: MemberModelAccountSnapshot | null;
    };

/** The selected model facts shared by prompt preparation and Run persistence. */
export interface ThreadModelSelection {
  readonly owner: { readonly userId: string; readonly orgId: string };
  readonly agentRunModelPin: AgentRunModelPin;
  readonly modelProviderId: string | undefined;
  readonly modelProviderCredentialScope:
    ModelProviderCredentialScope | undefined;
  readonly modelProviderType: string | undefined;
  readonly selectedModelOverride: string;
  readonly builtInModelRuntimeRoute: BuiltInModelRuntimeRoute | undefined;
  readonly codexServiceTier: "fast" | undefined;
  readonly reasoningEffort: ReasoningEffort | undefined;
  readonly piExecution: boolean;
  readonly queueFirstAssociation: QueueFirstRunAssociation;
}

interface ThreadModelProviderArgs {
  readonly catalog: ModelCatalog;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly modelProviderType?: string;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  readonly piExecution: boolean;
  readonly codexServiceTier?: "fast";
  readonly agentRunMetadata?: {
    readonly reasoningEffort?: ReasoningEffort | null;
  };
  readonly queueFirstAssociation?: QueueFirstRunAssociation;
}

interface ThreadModelProviderInput {
  readonly timing: ApiDispatchTimingCollector;
  readonly args: ThreadModelProviderArgs;
}

export interface ThreadModelSignals {
  readonly dispatchTiming$: Computed<ApiDispatchTimingCollector>;
  readonly queuedModel$: Computed<Promise<QueuedModelContext>>;
  readonly subscriptionSelection$: Computed<
    Promise<ThreadModelSelection | ThreadModelError>
  >;
  readonly requestedFramework$: Computed<
    Promise<SupportedFramework | ThreadModelError>
  >;
  readonly modelRoute$: Computed<
    Promise<ResolvedModelProviderEnvironment | ThreadModelError | null>
  >;
  /** Provider-native framework; preserves provider-specific prompt guidance. */
  readonly providerFramework$: Computed<
    Promise<SupportedFramework | ThreadModelError>
  >;
  /** Actual execution framework, including a successfully materialized Pi route. */
  readonly framework$: Computed<
    Promise<SupportedFramework | "pi" | ThreadModelError>
  >;
}

type ThreadModelSelectionSignal = Computed<
  Promise<ThreadModelSelection | ThreadModelError>
>;
type ThreadModelProviderInputSignal = Computed<
  Promise<ThreadModelProviderInput | ThreadModelError>
>;

/** Resolve one immutable event selection, then share its captured provider route. */
export function createThreadModelSignals(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  selectedBootstrap$: Computed<Promise<AgentRunContextSignals>>,
): ThreadModelSignals {
  const dispatchTiming$ = computed(() => {
    return new ApiDispatchTimingCollector();
  });
  const queuedModel$ = createQueuedModel(
    bootstrap,
    pickedEvent$,
    selectedBootstrap$,
  );
  const selection$ = createModelSelection(
    bootstrap,
    pickedEvent$,
    selectedBootstrap$,
    queuedModel$,
  );
  const subscriptionSelection$ = createSubscriptionSelection(
    selectedBootstrap$,
    selection$,
    dispatchTiming$,
  );
  const providerInput$ = createProviderInput(
    bootstrap,
    subscriptionSelection$,
    dispatchTiming$,
  );
  const requestedFramework$ = createRequestedFramework(
    selectedBootstrap$,
    providerInput$,
  );
  const providerContext$ = createProviderContext(
    providerInput$,
    requestedFramework$,
  );
  const modelEnvironment$ = createModelEnvironment(
    bootstrap,
    selectedBootstrap$,
    providerContext$,
  );
  const modelRoute$ = createModelRoute(providerContext$, modelEnvironment$);
  const providerFramework$ = computed(
    async (get): Promise<SupportedFramework | ThreadModelError> => {
      const model = await get(modelRoute$);
      return model === null
        ? get(requestedFramework$)
        : "status" in model
          ? model
          : getFrameworkForType(model.type);
    },
  );
  const framework$ = computed(
    async (get): Promise<SupportedFramework | "pi" | ThreadModelError> => {
      const model = await get(modelRoute$);
      return model && !("status" in model) && model.piModelConfig
        ? "pi"
        : get(providerFramework$);
    },
  );
  return {
    dispatchTiming$,
    queuedModel$,
    subscriptionSelection$,
    requestedFramework$,
    modelRoute$,
    providerFramework$,
    framework$,
  };
}

function createQueuedModel(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  selectedBootstrap$: Computed<Promise<AgentRunContextSignals>>,
) {
  const memberSnapshot$ = computed(async (get) => {
    const selected = await get(selectedBootstrap$);
    const { accounts, providers } = await get(selected.memberModels$);
    return {
      orgId: selected.orgId,
      userId: selected.userId,
      accounts,
      providers,
    };
  });
  const memberRoutes$ = computed(async (get) => {
    return get((await get(selectedBootstrap$)).memberRoutes$);
  });
  const subscriptionModels$ = computed(async (get) => {
    return memberSubscriptionModelRoutesFromCatalog(
      await get(bootstrap.modelCatalog$),
      await get(memberRoutes$),
    );
  });
  const modelPin$ = computed(async (get) => {
    const selection = (await get(pickedEvent$))?.canonicalModelSelection;
    return selection
      ? resolveQueuedModelSelectionPinFromSnapshot({
          catalog: await get(bootstrap.modelCatalog$),
          selectedModel: selection.selectedModel,
          subscriptionModels: await get(subscriptionModels$),
          memberProviderTypes: new Set(
            (await get(memberSnapshot$)).providers.map((provider) => {
              return provider.type;
            }),
          ),
        })
      : badRequestMessage("Queued input is missing its model selection");
  });
  const builtInRuntimeRoute$ = createBuiltInRuntimeRoute(bootstrap, modelPin$);
  const providerAdmission$ = createProviderAdmission(
    bootstrap,
    selectedBootstrap$,
    memberRoutes$,
    modelPin$,
  );
  const queuedModel$ = computed(async (get): Promise<QueuedModelContext> => {
    const [event] = await Promise.all([
      get(pickedEvent$),
      get(bootstrap.plan$),
      get(bootstrap.featureSwitches$),
    ]);
    const selection = event?.canonicalModelSelection;
    if (!selection) {
      return badRequestMessage("Queued input is missing its model selection");
    }
    const pin = await get(modelPin$);
    if ("status" in pin) {
      return pin;
    }
    const [
      admission,
      featureSwitchContext,
      builtInModelRuntimeRoute,
      memberAccountSnapshot,
    ] = await Promise.all([
      get(providerAdmission$),
      get(bootstrap.featureSwitches$),
      get(builtInRuntimeRoute$),
      get(memberSnapshot$),
    ]);
    const unpriced =
      builtInModelRuntimeRoute === null && pin.selectedModel
        ? unpricedBuiltInModelRejection(
            {
              catalog: await get(bootstrap.modelCatalog$),
              model: pin.selectedModel,
              serviceTier: undefined,
              resolution: get(usagePricingResolution$),
            },
            await get(bootstrap.modelPricing$),
          )
        : undefined;
    return {
      pin,
      providerAdmission: {
        effectiveModelProvider: admission.effectiveModelProvider,
        cliAgentType: admission.cliAgentType,
        error:
          admission.error ??
          unpriced ??
          (admission.hasSpendableCredits ? undefined : insufficientCredits()),
      },
      featureSwitchContext,
      runCodexServiceTier: isAutoSelectedModel(pin.selectedModel)
        ? undefined
        : (selection.codexServiceTier ?? undefined),
      reasoningEffort: isAutoSelectedModel(pin.selectedModel)
        ? undefined
        : (selection.reasoningEffort ?? undefined),
      builtInModelRuntimeRoute,
      memberAccountSnapshot,
    };
  });
  return queuedModel$;
}

function createBuiltInRuntimeRoute(
  bootstrap: AgentRunContextSignals,
  modelPin$: Computed<
    Promise<ModelFirstPin | ReturnType<typeof badRequestMessage>>
  >,
) {
  const builtInRuntimeRoute$ = computed(async (get) => {
    const pin = await get(modelPin$);
    if (
      "status" in pin ||
      !isBuiltInModelProviderType(pin.modelProviderType) ||
      !pin.selectedModel
    ) {
      return undefined;
    }
    const [catalog, pricing, keys] = await Promise.all([
      get(bootstrap.modelCatalog$),
      get(bootstrap.modelPricing$),
      get(bootstrap.managedModelKeys$),
    ]);
    return builtInModelRuntimeRouteFromSnapshot({
      catalog,
      selectedModel: pin.selectedModel,
      modelKeyId: keys.find((key) => {
        return key.vendor === AUTO_RUN_KEY_VENDOR;
      })?.id,
      routePricing: builtInRoutePricingFromSnapshot(
        { serviceTier: undefined, resolution: get(usagePricingResolution$) },
        pricing,
      ),
    });
  });
  return builtInRuntimeRoute$;
}

function createProviderAdmission(
  bootstrap: AgentRunContextSignals,
  selectedBootstrap$: Computed<Promise<AgentRunContextSignals>>,
  memberRoutes$: AgentRunContextSignals["memberRoutes$"],
  modelPin$: Computed<
    Promise<ModelFirstPin | ReturnType<typeof badRequestMessage>>
  >,
) {
  const providerAdmission$ = computed(async (get) => {
    const pin = await get(modelPin$);
    if ("status" in pin) {
      throw new Error("Provider admission requires a valid queued model pin");
    }
    const [catalog, member, capabilities] = await Promise.all([
      get(bootstrap.modelCatalog$),
      get(memberRoutes$),
      get(bootstrap.plan$),
    ]);
    const effectiveModelProvider = pin.modelProviderType;
    const parsed = modelProviderTypeSchema.safeParse(effectiveModelProvider);
    const cliAgentType = parsed.success
      ? getFrameworkForType(parsed.data)
      : null;
    const error = checkOrgPlanRunAdmission({
      catalog,
      capabilities,
      modelProviderType: effectiveModelProvider,
      selectedModel: pin.selectedModel,
      personalSubscription: isMemberSubscriptionRoute({
        catalog,
        member,
        model: pin.selectedModel,
        providerType: pin.modelProviderType,
      }),
    });
    if (error || !isBuiltInModelProviderType(effectiveModelProvider)) {
      return {
        effectiveModelProvider,
        cliAgentType,
        error,
        hasSpendableCredits: true,
      };
    }
    const balance = await get((await get(selectedBootstrap$)).credits$);
    return {
      effectiveModelProvider,
      cliAgentType,
      error: balance ? undefined : insufficientCredits(),
      hasSpendableCredits:
        balance !== null &&
        (balance.usagePackCredits > 0 || balance.spendableCredits > 0),
    };
  });
  return providerAdmission$;
}

function createModelSelection(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  selectedBootstrap$: Computed<Promise<AgentRunContextSignals>>,
  queuedModel$: ThreadModelSignals["queuedModel$"],
) {
  const selection$ = computed(
    async (get): Promise<ThreadModelSelection | ThreadModelError> => {
      const event = await get(pickedEvent$);
      if (!event) {
        return badRequestMessage("Queued input is missing its model selection");
      }
      const model = await get(queuedModel$);
      if ("status" in model) {
        return model;
      }
      if (model.providerAdmission.error) {
        return model.providerAdmission.error;
      }
      const modelProviderType = model.providerAdmission.effectiveModelProvider;
      if (
        isBuiltInModelProviderType(modelProviderType) &&
        !model.builtInModelRuntimeRoute
      ) {
        return {
          status: 503,
          body: {
            error: {
              code: "MODEL_PROVIDER_UNAVAILABLE",
              message:
                "Every built-in model route for this model is temporarily unavailable",
            },
          },
        };
      }
      const [selected, catalog] = await Promise.all([
        get(selectedBootstrap$),
        get(bootstrap.modelCatalog$),
      ]);
      const piExecution = shouldUsePiExecution({
        chatThreadId: event.chatThreadId,
        modelProviderType,
        catalogModel: piCatalogModel(catalog, model.pin.selectedModel),
        codexServiceTier: model.runCodexServiceTier,
        builtInModelRuntimeRoute: model.builtInModelRuntimeRoute ?? undefined,
      });
      return {
        owner: { userId: selected.userId, orgId: selected.orgId },
        agentRunModelPin: {
          modelProvider: modelProviderType ?? null,
          modelProviderId: model.pin.modelProviderId,
          modelProviderCredentialScope: model.pin.modelProviderCredentialScope,
          selectedModel: model.pin.selectedModel,
        },
        modelProviderId: model.pin.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          model.pin.modelProviderCredentialScope ?? undefined,
        modelProviderType: modelProviderType ?? undefined,
        selectedModelOverride: model.pin.selectedModel,
        builtInModelRuntimeRoute: model.builtInModelRuntimeRoute ?? undefined,
        codexServiceTier: model.runCodexServiceTier,
        reasoningEffort: resolveReasoningEffortForDispatch({
          catalog,
          selectedModel: model.pin.selectedModel,
          modelProviderType,
          effort: model.reasoningEffort,
          runtimeProviderType:
            model.builtInModelRuntimeRoute?.providerType ?? modelProviderType,
          piExecution,
        }),
        piExecution,
        queueFirstAssociation: {
          threadId: event.chatThreadId,
          eventId: event.id,
        },
      };
    },
  );
  return selection$;
}

function createSubscriptionSelection(
  selectedBootstrap$: Computed<Promise<AgentRunContextSignals>>,
  selection$: ThreadModelSelectionSignal,
  dispatchTiming$: ThreadModelSignals["dispatchTiming$"],
) {
  const subscriptionSelection$ = computed(
    async (get): Promise<ThreadModelSelection | ThreadModelError> => {
      const selection = await get(selection$);
      if ("status" in selection) {
        return selection;
      }
      const pin = selection.agentRunModelPin;
      if (
        !pin.modelProvider ||
        !isPersonalSubscriptionProviderType(pin.modelProvider)
      ) {
        return selection;
      }
      const providerType = pin.modelProvider;
      return get(dispatchTiming$).measure(
        "api_dispatch_pre_create_agent_capture_subscription_account",
        "nested",
        async () => {
          const candidates = personalSubscriptionAccountCandidates({
            command: selection,
            providerType,
            modelProviderId: pin.modelProviderId,
            snapshot: await get((await get(selectedBootstrap$)).memberModels$),
          });
          const account =
            candidates.find((candidate) => {
              return candidate.id === pin.modelProviderId;
            }) ?? candidates[0];
          if (!account || account.type !== providerType) {
            return conflict(
              "The selected subscription account is unavailable. Reconnect it before starting another run.",
            );
          }
          return {
            ...selection,
            modelProviderId: account.id,
            agentRunModelPin: { ...pin, modelProviderId: account.id },
          };
        },
      );
    },
  );
  return subscriptionSelection$;
}

function createProviderInput(
  bootstrap: AgentRunContextSignals,
  subscriptionSelection$: ThreadModelSignals["subscriptionSelection$"],
  dispatchTiming$: ThreadModelSignals["dispatchTiming$"],
) {
  const providerInput$ = computed(
    async (get): Promise<ThreadModelProviderInput | ThreadModelError> => {
      const selection = await get(subscriptionSelection$);
      if ("status" in selection) {
        return selection;
      }
      return {
        timing: get(dispatchTiming$),
        args: {
          catalog: await get(bootstrap.modelCatalog$),
          orgId: selection.owner.orgId,
          userId: selection.owner.userId,
          modelProviderId: selection.modelProviderId,
          modelProviderCredentialScope: selection.modelProviderCredentialScope,
          modelProviderType: selection.modelProviderType,
          selectedModelOverride: selection.selectedModelOverride,
          builtInModelRuntimeRoute: selection.builtInModelRuntimeRoute,
          piExecution: selection.piExecution,
          codexServiceTier: selection.codexServiceTier,
          agentRunMetadata: { reasoningEffort: selection.reasoningEffort },
          queueFirstAssociation: selection.queueFirstAssociation,
        },
      };
    },
  );
  return providerInput$;
}

function createRequestedFramework(
  selectedBootstrap$: Computed<Promise<AgentRunContextSignals>>,
  providerInput$: ThreadModelProviderInputSignal,
) {
  const requestedFramework$ = computed(
    async (get): Promise<SupportedFramework | ThreadModelError> => {
      const input = await get(providerInput$);
      if ("status" in input) {
        return input;
      }
      const args = input.args;
      const parsed = modelProviderTypeSchema.safeParse(args.modelProviderType);
      if (parsed.success) {
        return getFrameworkForType(parsed.data);
      }
      if (!args.modelProviderId) {
        return getValidatedFramework(undefined);
      }
      const member = await get((await get(selectedBootstrap$)).memberModels$);
      const provider =
        member.providers.find((row) => {
          return row.id === args.modelProviderId;
        }) ??
        member.accounts.find((row) => {
          return row.id === args.modelProviderId;
        });
      const type = modelProviderTypeSchema.safeParse(provider?.type);
      return type.success
        ? getFrameworkForType(type.data)
        : getValidatedFramework(undefined);
    },
  );
  return requestedFramework$;
}

function createProviderContext(
  providerInput$: ThreadModelProviderInputSignal,
  requestedFramework$: ThreadModelSignals["requestedFramework$"],
) {
  const providerContext$ = computed(async (get) => {
    const input = await get(providerInput$);
    if ("status" in input) {
      return input;
    }
    const framework = await get(requestedFramework$);
    if (typeof framework !== "string") {
      return framework;
    }
    return { input, environmentArgs: { ...input.args, framework } };
  });
  return providerContext$;
}

function createModelEnvironment(
  bootstrap: AgentRunContextSignals,
  selectedBootstrap$: Computed<Promise<AgentRunContextSignals>>,
  providerContext$: ReturnType<typeof createProviderContext>,
) {
  const modelEnvironment$ = computed(
    async (get): Promise<ResolvedModelProviderEnvironment | null> => {
      const context = await get(providerContext$);
      if ("status" in context) {
        return null;
      }
      const args = context.environmentArgs;
      const identity = await get(selectedBootstrap$);
      if (identity.orgId !== args.orgId || identity.userId !== args.userId) {
        throw new Error("Model source snapshot identity mismatch");
      }
      if (isBuiltInModelProviderType(args.modelProviderType)) {
        const route = args.builtInModelRuntimeRoute;
        if (
          !route ||
          route.selectedModel !== args.selectedModelOverride ||
          !isBuiltInModelRuntimeRoutePermitted(route) ||
          getFrameworkForType(route.providerType) !== args.framework
        ) {
          return null;
        }
        const source = managedSourceFromSnapshot(
          (await get(identity.managedModelKeys$)).find((key) => {
            return key.id === route.modelKeyId;
          }),
        );
        return source ? prepareManagedModelEnvironment(source, args) : null;
      }
      if (
        !args.modelProviderId ||
        !args.modelProviderType ||
        !isPersonalSubscriptionProviderType(args.modelProviderType)
      ) {
        return null;
      }
      const source = memberAccountSourceFromSnapshot(
        await get(identity.memberModels$),
        args.modelProviderId,
      );
      if (!source) {
        return null;
      }
      const type = source.configuration.providerType;
      if (
        !args.selectedModelOverride ||
        !isPersonalSubscriptionProviderType(type) ||
        getFrameworkForType(type) !== args.framework ||
        args.modelProviderType !== type
      ) {
        return null;
      }
      return prepareSubscriptionModelEnvironment(
        source,
        args.selectedModelOverride,
        {
          catalog: await get(bootstrap.modelCatalog$),
          userId: args.userId,
          sourceId: args.modelProviderId,
          piExecution: args.piExecution,
        },
      );
    },
  );
  return modelEnvironment$;
}

function createModelRoute(
  providerContext$: ReturnType<typeof createProviderContext>,
  modelEnvironment$: ReturnType<typeof createModelEnvironment>,
) {
  const modelRoute$ = computed(
    async (
      get,
    ): Promise<ResolvedModelProviderEnvironment | ThreadModelError | null> => {
      const context = await get(providerContext$);
      if ("status" in context) {
        return context;
      }
      const result = await settle(
        context.input.timing.measure(
          "api_dispatch_prepare_context_resolve_model_provider",
          "nested",
          async () => {
            return (
              (await get(modelEnvironment$)) ??
              providerUnavailable("No model provider is available for this run")
            );
          },
        ),
      );
      if (!result.ok) {
        return piConfigurationRouteError(result.error);
      }
      const provider = result.value;
      if ("status" in provider) {
        return provider;
      }
      const args = context.input.args;
      const materialized = safeSync(() => {
        return materializePreparedPiProvider(
          {
            catalog: args.catalog,
            piExecution: args.piExecution,
            codexServiceTier: args.codexServiceTier,
            reasoningEffort: args.agentRunMetadata?.reasoningEffort,
          },
          provider,
        );
      });
      return "ok" in materialized
        ? materialized.ok
        : piConfigurationRouteError(materialized.error);
    },
  );
  return modelRoute$;
}

function unpricedBuiltInModelRejection(
  args: Parameters<typeof builtInRoutePricingFromSnapshot>[0] & {
    readonly catalog: ModelCatalog;
    readonly model: string;
  },
  pricing: Parameters<typeof builtInRoutePricingFromSnapshot>[1],
): ThreadModelError | undefined {
  const message = unpricedBuiltInModelMessage(
    args.catalog,
    args.model,
    builtInRoutePricingFromSnapshot(args, pricing),
  );
  return message
    ? {
        status: 503,
        body: { error: { code: "MODEL_PROVIDER_UNAVAILABLE", message } },
      }
    : undefined;
}

function personalSubscriptionAccountCandidates(args: {
  readonly command: {
    readonly owner: { readonly orgId: string; readonly userId: string };
  };
  readonly providerType: string;
  readonly modelProviderId: string | null;
  readonly snapshot: MemberModelAccountSnapshot;
}) {
  const snapshot = args.snapshot;
  if (
    snapshot.orgId !== args.command.owner.orgId ||
    snapshot.userId !== args.command.owner.userId ||
    !isPersonalSubscriptionProviderType(args.providerType)
  ) {
    throw new Error("Subscription account snapshot identity mismatch");
  }
  return snapshot.accounts.filter((account) => {
    if (
      account.disconnectedAt !== null ||
      account.orgId !== snapshot.orgId ||
      account.userId !== snapshot.userId
    ) {
      return false;
    }
    const activeType = account.type === args.providerType && account.isActive;
    return args.modelProviderId === null
      ? activeType
      : account.id === args.modelProviderId ||
          (account.modelProviderId === args.modelProviderId && activeType);
  });
}

function piConfigurationRouteError(
  error: unknown,
): ReturnType<typeof badRequestMessage> {
  if (error instanceof PiModelConfigurationError) {
    return badRequestMessage(error.message);
  }
  throw error;
}
