import { isChatEventContentTextType } from "@okouai/api-contracts/contracts/chat-events";
import {
  getCodexChatGptAccountUnsupportedModel,
  isAgentExecutionTimeoutRunError,
} from "@okouai/api-contracts/contracts/errors";
import type { ModelProviderFramework } from "@okouai/api-contracts/contracts/model-provider-types";
import {
  getFrameworkForType,
  isPersonalSubscriptionProviderType,
  type ModelProviderResponse,
  type PersonalSubscriptionProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/contracts/third-party-subscriptions";
import {
  knownRunFailureReasonSchema,
  type KnownRunFailureReason,
} from "@okouai/api-contracts/contracts/run-failure-reasons";
import { computed, type Computed } from "ccstate";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { personalModelProviderAccountRevision$ } from "../external/third-party-subscriptions.ts";
import { availableRunModels$ } from "../external/run-models.ts";
import { hasChatEventBodyContent } from "./chat-event-body-blocks.ts";
import type { ChatEventSignals } from "./chat-event-signals.ts";
import type { ChatEventGroup, EnrichedChatEvent } from "./chat-event.ts";
import { threadMeta } from "./chat-thread-event-sourcing.ts";

type AssistantErrorRecoveryKind =
  | "subscription-error"
  | "usage-limit"
  | "model-capacity"
  | "model-unavailable"
  | "provider-retryable"
  | "provider-settings"
  | "new-chat-required"
  | "input-too-large"
  | "output-token-limit"
  | "terms-acceptance-required"
  | "safety-policy-refusal"
  | "execution-timeout"
  | "autonomy-budget-exhausted";
type AssistantErrorRecoveryScope = "framework" | "model";
type AssistantErrorRecoveryWindow =
  "five-hour" | "weekly" | "model" | "unknown";
type SubscriptionResetWindow = Exclude<
  AssistantErrorRecoveryWindow,
  "model" | "unknown"
>;

/**
 * The personal subscription the thread's current model routes through. The
 * card reads the route the next run will take rather than the failed run's
 * captured account; sending a new message uses the current route.
 */
interface CurrentPersonalSubscription {
  readonly providerType: PersonalSubscriptionProviderType;
  readonly framework: ModelProviderFramework;
}

interface ClassifiedAssistantError {
  readonly sourceEventId: string;
  readonly failureReason: KnownRunFailureReason | null;
  readonly providerMessage: string;
  readonly kind: AssistantErrorRecoveryKind;
  readonly framework: ModelProviderFramework | null;
  readonly scope: AssistantErrorRecoveryScope;
  readonly limitWindow: AssistantErrorRecoveryWindow | null;
  readonly retryLabel: string | null;
}

export type AssistantErrorRecovery = ClassifiedAssistantError & {
  /** Present when the current route is a personal subscription. */
  readonly personalSubscription: "connected" | "disconnected" | null;
  readonly accountLabel: string | null;
  readonly resetWindows: readonly {
    readonly limitWindow: SubscriptionResetWindow;
    readonly resetAt: string | null;
  }[];
};

interface SubscriptionReset {
  readonly resetAt: string | null;
  readonly limitWindow: SubscriptionResetWindow;
}

function normalizedProviderMessage(error: string): string {
  return error.replace(/\s+/gu, " ").trim();
}

function resetLabelFromProviderMessage(error: string): string | null {
  const match = error.match(/\b(?:resets?|try again at)\s+(.+)$/iu);
  return match?.[1]?.trim().replace(/[.!]+$/u, "") ?? null;
}

function claudeLimitWindow(error: string): AssistantErrorRecoveryWindow | null {
  if (/\bweekly\b/iu.test(error)) {
    return "weekly";
  }
  if (/\b(?:session|5[- ]hour)\b/iu.test(error)) {
    return "five-hour";
  }
  if (/\b(?:opus|sonnet|haiku)\b/iu.test(error)) {
    return "model";
  }
  return null;
}

function isClaudeUsageLimit(error: string): boolean {
  return (
    /you(?:'|’)ve hit your (?:session|weekly|5[- ]hour|opus(?:\s+[\w.-]+)?|sonnet(?:\s+[\w.-]+)?|haiku(?:\s+[\w.-]+)?) limit\b/iu.test(
      error,
    ) || /\bclaude(?: code)? (?:rate|usage) limit reached\b/iu.test(error)
  );
}

function isCodexModelCapacity(error: string): boolean {
  return /selected model is at capacity\.? please try a different model/iu.test(
    error,
  );
}

function isClaudeModelCapacity(error: string): boolean {
  return (
    /\bclaude\b.*\b(?:is overloaded|overloaded|at capacity)\b/iu.test(error) ||
    /\b529\b.*\boverload/iu.test(error) ||
    /\boverloaded_error\b/iu.test(error)
  );
}

function classifyExecutionTimeout(
  event: EnrichedChatEvent,
  error: string,
): ClassifiedAssistantError {
  return {
    sourceEventId: event.id,
    failureReason:
      event.eventType === "run.failed" &&
      event.failureReason === "execution_timeout"
        ? event.failureReason
        : null,
    providerMessage: error,
    kind: "execution-timeout",
    framework: null,
    scope: "framework",
    limitWindow: null,
    retryLabel: null,
  };
}

function classifyAssistantErrorFromText(
  event: EnrichedChatEvent,
  error: string,
): ClassifiedAssistantError | null {
  const normalized = normalizedProviderMessage(error);
  const retryLabel = resetLabelFromProviderMessage(normalized);

  if (isAgentExecutionTimeoutRunError(normalized)) {
    return classifyExecutionTimeout(event, error);
  }

  if (normalized.toUpperCase() === "AUTONOMY_BUDGET_EXHAUSTED") {
    return {
      sourceEventId: event.id,
      failureReason: null,
      providerMessage: error,
      kind: "autonomy-budget-exhausted",
      framework: null,
      scope: "framework",
      limitWindow: null,
      retryLabel: null,
    };
  }

  if (getCodexChatGptAccountUnsupportedModel(error) !== undefined) {
    return {
      sourceEventId: event.id,
      failureReason: null,
      providerMessage: error,
      kind: "model-unavailable",
      framework: "codex",
      scope: "model",
      limitWindow: null,
      retryLabel: null,
    };
  }

  if (isCodexModelCapacity(normalized)) {
    return {
      sourceEventId: event.id,
      failureReason: null,
      providerMessage: error,
      kind: "model-capacity",
      framework: "codex",
      scope: "model",
      limitWindow: null,
      retryLabel: null,
    };
  }

  if (isClaudeModelCapacity(normalized)) {
    return {
      sourceEventId: event.id,
      failureReason: null,
      providerMessage: error,
      kind: "model-capacity",
      framework: "claude-code",
      scope: "model",
      limitWindow: null,
      retryLabel: null,
    };
  }

  if (/you(?:'|’)ve hit your usage limit\b/iu.test(normalized)) {
    const modelScoped = /\busage limit for\b/iu.test(normalized);
    return {
      sourceEventId: event.id,
      failureReason: null,
      providerMessage: error,
      kind: "usage-limit",
      framework: "codex",
      scope: modelScoped ? "model" : "framework",
      limitWindow: modelScoped ? "model" : "unknown",
      retryLabel,
    };
  }

  if (isClaudeUsageLimit(normalized)) {
    const limitWindow = claudeLimitWindow(normalized) ?? "unknown";
    return {
      sourceEventId: event.id,
      failureReason: null,
      providerMessage: error,
      kind: "usage-limit",
      framework: "claude-code",
      scope: limitWindow === "model" ? "model" : "framework",
      limitWindow,
      retryLabel,
    };
  }

  return null;
}

const STRUCTURED_RECOVERY_KIND = Object.freeze({
  session_history_limit: "new-chat-required",
  guest_root_filesystem_full: "provider-retryable",
  guest_home_filesystem_full: "provider-retryable",
  execution_timeout: "execution-timeout",
  insufficient_credits: null,
  provider_insufficient_credits: "provider-settings",
  invalid_api_key: "provider-settings",
  invalid_credentials: "provider-settings",
  terms_acceptance_required: "terms-acceptance-required",
  context_window_exceeded: "new-chat-required",
  input_too_large: "input-too-large",
  provider_image_too_large: "input-too-large",
  output_token_limit: "output-token-limit",
  provider_rate_limited: "provider-retryable",
  provider_overloaded: "model-capacity",
  provider_stream_timeout: "provider-retryable",
  provider_queue_timeout: "provider-retryable",
  codex_access_program_unavailable: "provider-retryable",
  provider_server_error: "provider-retryable",
  response_connection_lost: "provider-retryable",
  safety_policy_refusal: "safety-policy-refusal",
  reconnect_required: "provider-settings",
  unsupported_model: "model-unavailable",
  usage_limit: "usage-limit",
} satisfies Record<KnownRunFailureReason, AssistantErrorRecoveryKind | null>);

interface StructuredRecovery {
  readonly failureReason: KnownRunFailureReason;
  readonly kind: AssistantErrorRecoveryKind | null;
}

function structuredRecoveryKind(
  event: EnrichedChatEvent,
): StructuredRecovery | null | undefined {
  if (event.eventType !== "run.failed" || event.failureReason === undefined) {
    return undefined;
  }

  const knownReason = knownRunFailureReasonSchema.safeParse(
    event.failureReason,
  );
  if (!knownReason.success) {
    return null;
  }
  return {
    failureReason: knownReason.data,
    kind: STRUCTURED_RECOVERY_KIND[knownReason.data],
  };
}

function structuredRecoveryFrameworkFromError(
  kind: AssistantErrorRecoveryKind,
  error: string,
): ModelProviderFramework | null {
  const normalized = normalizedProviderMessage(error);
  if (kind === "model-capacity") {
    if (isCodexModelCapacity(normalized)) {
      return "codex";
    }
    if (isClaudeModelCapacity(normalized)) {
      return "claude-code";
    }
  }
  if (kind === "model-unavailable") {
    return getCodexChatGptAccountUnsupportedModel(error) === undefined
      ? null
      : "codex";
  }
  if (kind === "usage-limit") {
    if (/you(?:'|’)ve hit your usage limit\b/iu.test(normalized)) {
      return "codex";
    }
    if (isClaudeUsageLimit(normalized)) {
      return "claude-code";
    }
  }
  return null;
}

function classifyStructuredAssistantError(
  event: EnrichedChatEvent,
  error: string,
  failureReason: KnownRunFailureReason,
  kind: AssistantErrorRecoveryKind,
  framework: ModelProviderFramework | null,
): ClassifiedAssistantError {
  const normalized = normalizedProviderMessage(error);
  const hasCodexUsageDetails =
    kind === "usage-limit" &&
    /you(?:'|’)ve hit your usage limit\b/iu.test(normalized);
  const hasClaudeUsageDetails =
    kind === "usage-limit" && isClaudeUsageLimit(normalized);
  const codexModelScoped =
    framework === "codex" &&
    hasCodexUsageDetails &&
    /\busage limit for\b/iu.test(normalized);
  const limitWindow =
    kind === "usage-limit"
      ? framework === "claude-code" && hasClaudeUsageDetails
        ? (claudeLimitWindow(normalized) ?? "unknown")
        : codexModelScoped
          ? "model"
          : "unknown"
      : null;

  return {
    sourceEventId: event.id,
    failureReason,
    providerMessage: error,
    kind,
    framework,
    scope:
      kind === "model-unavailable" ||
      kind === "model-capacity" ||
      codexModelScoped ||
      limitWindow === "model"
        ? "model"
        : "framework",
    limitWindow,
    retryLabel:
      hasCodexUsageDetails || hasClaudeUsageDetails
        ? resetLabelFromProviderMessage(normalized)
        : null,
  };
}

function isRenderableAssistantEvent(event: EnrichedChatEvent): boolean {
  return (
    (isChatEventContentTextType(event.eventType) && Boolean(event.content)) ||
    hasChatEventBodyContent(event) ||
    event.eventType === "input.rejected" ||
    event.eventType === "output.error" ||
    event.eventType === "run.failed" ||
    event.eventType === "run.cancelled"
  );
}

function latestAssistantErrorCandidate(groups: readonly ChatEventGroup[]): {
  readonly event: EnrichedChatEvent;
  readonly error: string;
} | null {
  const group = groups.at(-1);
  if (group?.role !== "assistant") {
    return null;
  }

  let event: EnrichedChatEvent | undefined;
  for (let index = group.events.length - 1; index >= 0; index -= 1) {
    const candidate = group.events[index];
    if (candidate && isRenderableAssistantEvent(candidate)) {
      event = candidate;
      break;
    }
  }
  if (
    event === undefined ||
    (event.eventType !== "output.error" && event.eventType !== "run.failed") ||
    !event.error
  ) {
    return null;
  }
  return { event, error: event.error };
}

function exhaustedUsageWindows(
  provider: ModelProviderResponse,
): readonly SubscriptionReset[] {
  const usage = provider.subscriptionUsage;
  if (!usage) {
    return [];
  }
  const windows = [
    { limitWindow: "five-hour" as const, value: usage.fiveHour },
    { limitWindow: "weekly" as const, value: usage.weekly },
  ];
  return windows.flatMap(({ limitWindow, value }) => {
    const exhausted =
      value !== null &&
      (value.remainingPercent === 0 ||
        (value.usedPercent !== null && value.usedPercent >= 100));
    return exhausted ? [{ limitWindow, resetAt: value.resetAt ?? null }] : [];
  });
}

function providerSubscriptionResets(
  provider: ModelProviderResponse | undefined,
  limitWindow: AssistantErrorRecoveryWindow | null,
): readonly SubscriptionReset[] {
  if (!provider) {
    return [];
  }
  if (limitWindow === "five-hour") {
    return [
      {
        limitWindow,
        resetAt: provider.subscriptionUsage?.fiveHour?.resetAt ?? null,
      },
    ];
  }
  if (limitWindow === "weekly") {
    return [
      {
        limitWindow,
        resetAt: provider.subscriptionUsage?.weekly?.resetAt ?? null,
      },
    ];
  }
  return limitWindow === "unknown" ? exhaustedUsageWindows(provider) : [];
}

function createCurrentPersonalSubscriptionComputed(
  selectedModel$: Computed<string | null>,
): Computed<Promise<CurrentPersonalSubscription | null>> {
  return computed(async (get): Promise<CurrentPersonalSubscription | null> => {
    const selectedModel = get(selectedModel$);
    if (selectedModel === null) {
      return null;
    }
    const { models } = await get(availableRunModels$);
    const runModel = models.find((candidate) => {
      return candidate.model === selectedModel;
    });
    if (!runModel) {
      return null;
    }
    const route = runModel.memberEffective;
    if (!isPersonalSubscriptionProviderType(route.providerType)) {
      return null;
    }
    return {
      providerType: route.providerType,
      framework: getFrameworkForType(route.providerType),
    };
  });
}

/** An unclassified failure may still come from the subscription it ran on. */
function maySubscriptionFail(event: EnrichedChatEvent, error: string): boolean {
  const subscriptionFailureReasons = [
    "reconnect_required",
    "invalid_credentials",
    "provider_rate_limited",
    "provider_stream_timeout",
    "provider_server_error",
    "response_connection_lost",
  ];
  return !(
    (event.eventType === "run.failed" &&
      event.failureReason !== undefined &&
      !subscriptionFailureReasons.includes(event.failureReason)) ||
    ["insufficient_credits", "pro_required"].includes(
      error.trim().toLowerCase(),
    )
  );
}

function subscriptionError(
  event: EnrichedChatEvent,
  error: string,
  subscription: CurrentPersonalSubscription,
): ClassifiedAssistantError {
  return {
    sourceEventId: event.id,
    failureReason: null,
    kind: "subscription-error",
    providerMessage: error,
    framework: subscription.framework,
    scope: "framework",
    limitWindow: null,
    retryLabel: null,
  };
}

function classifyCandidate(
  candidate: { readonly event: EnrichedChatEvent; readonly error: string },
  structuredKind: StructuredRecovery | undefined,
): ClassifiedAssistantError | null {
  if (structuredKind === undefined) {
    return classifyAssistantErrorFromText(candidate.event, candidate.error);
  }
  if (structuredKind.kind === null) {
    return null;
  }
  if (structuredKind.kind === "execution-timeout") {
    return classifyExecutionTimeout(candidate.event, candidate.error);
  }
  return classifyStructuredAssistantError(
    candidate.event,
    candidate.error,
    structuredKind.failureReason,
    structuredKind.kind,
    structuredRecoveryFrameworkFromError(structuredKind.kind, candidate.error),
  );
}

/**
 * Classification reads the failure event itself. Only the fallbacks that ask
 * whether the thread routes through a personal subscription read the current
 * route, and never the failed run's details.
 */
function createClassifiedAssistantErrorComputed(
  visibleRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>,
  currentPersonalSubscription$: Computed<
    Promise<CurrentPersonalSubscription | null>
  >,
): Computed<Promise<ClassifiedAssistantError | null>> {
  return computed(async (get): Promise<ClassifiedAssistantError | null> => {
    const candidate = latestAssistantErrorCandidate(
      await get(visibleRenderedChatGroups$),
    );
    if (candidate === null) {
      return null;
    }

    const structuredKind = structuredRecoveryKind(candidate.event);
    const classified =
      structuredKind === null
        ? null
        : classifyCandidate(candidate, structuredKind);
    if (classified === null) {
      if (!maySubscriptionFail(candidate.event, candidate.error)) {
        return null;
      }
      const subscription = await get(currentPersonalSubscription$);
      return subscription
        ? subscriptionError(candidate.event, candidate.error, subscription)
        : null;
    }
    if (classified.kind === "usage-limit" && classified.framework === null) {
      const subscription = await get(currentPersonalSubscription$);
      return subscription
        ? { ...classified, framework: subscription.framework }
        : classified;
    }
    return classified;
  });
}

interface PersonalSubscriptionRecovery {
  readonly personalSubscription: AssistantErrorRecovery["personalSubscription"];
  readonly provider: ModelProviderResponse | undefined;
}

/**
 * The newest failure in the thread. A usage limit is reported after the page
 * may already have read the subscription usage, so each new failure keys a
 * fresh read of the accounts rather than reusing the session's cached list.
 */
function createLatestFailureEventIdComputed(
  chatEvents$: ChatEventSignals["chatEvents$"],
): Computed<string | null> {
  return computed((get): string | null => {
    const events = get(chatEvents$);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (
        event.eventType === "run.failed" ||
        event.eventType === "output.error"
      ) {
        return event.id;
      }
    }
    return null;
  });
}

function createFailureAccountsComputed(
  latestFailureEventId$: Computed<string | null>,
): Computed<Promise<readonly ModelProviderResponse[]>> {
  return computed(async (get) => {
    get(latestFailureEventId$);
    get(personalModelProviderAccountRevision$);
    const result = await accept(
      get(apiClient$)(thirdPartySubscriptionsMainContract).list(),
      [200],
    );
    return result.body.subscriptions;
  });
}

/**
 * The account the next run would spend: the active account of the current
 * route's subscription type. A limit on another framework says nothing about
 * that account, so it is only read when the frameworks agree.
 */
function createPersonalSubscriptionRecoveryComputed(
  classifiedAssistantError$: Computed<Promise<ClassifiedAssistantError | null>>,
  currentPersonalSubscription$: Computed<
    Promise<CurrentPersonalSubscription | null>
  >,
  failureAccounts$: Computed<Promise<readonly ModelProviderResponse[]>>,
): Computed<Promise<PersonalSubscriptionRecovery>> {
  return computed(async (get): Promise<PersonalSubscriptionRecovery> => {
    const none = { personalSubscription: null, provider: undefined } as const;
    const classified = await get(classifiedAssistantError$);
    if (classified?.kind !== "usage-limit") {
      return none;
    }
    const subscription = await get(currentPersonalSubscription$);
    if (
      subscription === null ||
      subscription.framework !== classified.framework
    ) {
      return none;
    }
    const provider = (await get(failureAccounts$)).find((candidate) => {
      return (
        candidate.type === subscription.providerType &&
        candidate.isActive !== false
      );
    });
    if (!provider || provider.needsReconnect) {
      return { personalSubscription: "disconnected", provider: undefined };
    }
    return { personalSubscription: "connected", provider };
  });
}

function recoveryForAccount(
  classified: ClassifiedAssistantError,
  provider: ModelProviderResponse | undefined,
): Pick<
  AssistantErrorRecovery,
  "accountLabel" | "limitWindow" | "resetWindows"
> {
  const resetWindows = providerSubscriptionResets(
    provider,
    classified.limitWindow,
  );
  return {
    accountLabel: provider?.accountEmail ?? provider?.workspaceName ?? null,
    resetWindows,
    limitWindow:
      resetWindows.length === 1
        ? resetWindows[0].limitWindow
        : classified.limitWindow,
  };
}

function createAssistantErrorRecoveryComputed(
  visibleRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>,
  chatEvents$: ChatEventSignals["chatEvents$"],
  selectedModel$: Computed<string | null>,
) {
  const currentPersonalSubscription$ =
    createCurrentPersonalSubscriptionComputed(selectedModel$);
  const classifiedAssistantError$ = createClassifiedAssistantErrorComputed(
    visibleRenderedChatGroups$,
    currentPersonalSubscription$,
  );
  const personalSubscriptionRecovery$ =
    createPersonalSubscriptionRecoveryComputed(
      classifiedAssistantError$,
      currentPersonalSubscription$,
      createFailureAccountsComputed(
        createLatestFailureEventIdComputed(chatEvents$),
      ),
    );
  return computed(async (get): Promise<AssistantErrorRecovery | null> => {
    const classified = await get(classifiedAssistantError$);
    if (classified === null) {
      return null;
    }
    const { personalSubscription, provider } = await get(
      personalSubscriptionRecovery$,
    );
    const recovery = recoveryForAccount(classified, provider);
    return {
      ...classified,
      personalSubscription,
      accountLabel: recovery.accountLabel,
      limitWindow: recovery.limitWindow,
      resetWindows: recovery.resetWindows,
    };
  });
}

export function createAssistantErrorRecoverySignals(deps: {
  readonly threadId: string;
  readonly chatEvents: ChatEventSignals;
  readonly visibleRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>;
}) {
  const threadMeta$ = threadMeta(deps.threadId);
  /**
   * The recovery reads the selection rather than the thread record it sits on.
   * Every chat-thread event replays that record into a fresh object, so taking
   * the record itself would re-run this asynchronous classification whenever
   * any thread in the workspace changes.
   */
  const selectedModel$ = computed((get): string | null => {
    return get(threadMeta$)?.selectedModel ?? null;
  });
  const assistantErrorRecovery$ = createAssistantErrorRecoveryComputed(
    deps.visibleRenderedChatGroups$,
    deps.chatEvents.chatEvents$,
    selectedModel$,
  );
  /**
   * Which event the recovery will attach to follows from the transcript alone,
   * while the recovery itself may wait on the current route and its personal
   * account. Publishing the identity separately lets the one card that is waiting
   * say so, instead of every error card in the thread reacting to the same
   * pending read.
   */
  const assistantErrorRecoveryEventId$ = computed(
    async (get): Promise<string | null> => {
      const candidate = latestAssistantErrorCandidate(
        await get(deps.visibleRenderedChatGroups$),
      );
      return candidate?.event.id ?? null;
    },
  );
  return {
    assistantErrorRecovery$,
    assistantErrorRecoveryEventId$,
  };
}
