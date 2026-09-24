import { hasChatEventBodyContent } from "./chat-event-body-blocks.ts";
import { command, computed, type Computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isChatEventContentTextType } from "@okouai/api-contracts/contracts/chat-events";
import {
  getCodexChatGptAccountUnsupportedModel,
  isAgentExecutionTimeoutRunError,
} from "@okouai/api-contracts/contracts/errors";
import type { ModelProviderFramework } from "@okouai/api-contracts/contracts/model-provider-types";
import { getMemberModelPolicyRoute } from "@okouai/api-contracts/contracts/member-model-policy";
import {
  getFrameworkForType,
  isSupportedRunModel,
  type ModelProviderResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  knownRunFailureReasonSchema,
  type KnownRunFailureReason,
} from "@okouai/api-contracts/contracts/run-failure-reasons";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { personalModelProviders$ } from "../external/personal-model-providers.ts";
import { resetPersonalCodexAccountSubscriptionUsage$ } from "../okou-page/settings/personal-model-providers.ts";
import { textToMessageDocument } from "../okou-page/user-message-document-codec.ts";
import type { ChatEventGroup, EnrichedChatEvent } from "./chat-event.ts";
import type { ChatEventSignals } from "./chat-event-signals.ts";
import { threadMeta } from "./chat-thread-event-sourcing.ts";
import { runOptionsFromModelProviderSelection } from "./model-selection-request.ts";

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
  | "five-hour"
  | "weekly"
  | "model"
  | "unknown";
type SubscriptionResetWindow = Exclude<
  AssistantErrorRecoveryWindow,
  "model" | "unknown"
>;

type PersonalSubscriptionProviderType =
  | "codex-oauth-token"
  | "claude-code-oauth-token";

/**
 * The personal subscription the thread's current model routes through. The
 * card reads the route the next run will take rather than the failed run's
 * captured account: retrying always goes through the current route.
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
  readonly retryAt: string | null;
  readonly resetWindows: readonly {
    readonly limitWindow: SubscriptionResetWindow;
    readonly resetAt: string | null;
  }[];
  readonly actions: {
    readonly tryAgain: {
      readonly notBefore: string | null;
    } | null;
    readonly resetAndTryAgain: {
      readonly resetsRemaining: number;
      readonly accountId: string;
    } | null;
  };
};

interface SubscriptionReset {
  readonly resetAt: string | null;
  readonly limitWindow: SubscriptionResetWindow;
}

const CONTINUE_PROMPT = "continue";

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
  execution_timeout: "execution-timeout",
  insufficient_credits: null,
  provider_insufficient_credits: "provider-settings",
  invalid_api_key: "provider-settings",
  invalid_credentials: "provider-settings",
  terms_acceptance_required: "terms-acceptance-required",
  context_window_exceeded: "new-chat-required",
  input_too_large: "input-too-large",
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

function structuredRecoveryFrameworkFromMessage(
  kind: AssistantErrorRecoveryKind,
  error: string,
): ModelProviderFramework | null {
  const normalized = normalizedProviderMessage(error);
  if (kind === "model-capacity") {
    if (isCodexModelCapacity(normalized)) {
      return getFrameworkForType("openai-api-key");
    }
    if (isClaudeModelCapacity(normalized)) {
      return getFrameworkForType("anthropic-api-key");
    }
  }
  if (kind === "model-unavailable") {
    return getCodexChatGptAccountUnsupportedModel(error) === undefined
      ? null
      : getFrameworkForType("openai-api-key");
  }
  if (kind === "usage-limit") {
    if (/you(?:'|’)ve hit your usage limit\b/iu.test(normalized)) {
      return getFrameworkForType("openai-api-key");
    }
    if (isClaudeUsageLimit(normalized)) {
      return getFrameworkForType("anthropic-api-key");
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

function latestKnownResetAt(
  resets: readonly SubscriptionReset[],
): string | null {
  let latest: { readonly value: string; readonly time: number } | null = null;
  for (const reset of resets) {
    if (!reset.resetAt) {
      continue;
    }
    const time = new Date(reset.resetAt).getTime();
    if (!Number.isNaN(time) && (latest === null || time > latest.time)) {
      latest = { value: reset.resetAt, time };
    }
  }
  return latest?.value ?? null;
}

function isPersonalSubscriptionProviderType(
  type: string,
): type is PersonalSubscriptionProviderType {
  return type === "codex-oauth-token" || type === "claude-code-oauth-token";
}

function createCurrentPersonalSubscriptionComputed(
  selectedModel$: Computed<string | null>,
): Computed<Promise<CurrentPersonalSubscription | null>> {
  return computed(async (get): Promise<CurrentPersonalSubscription | null> => {
    const selectedModel = get(selectedModel$);
    if (selectedModel === null) {
      return null;
    }
    const { policies } = await get(orgModelPolicies$);
    const policy = policies.find((candidate) => {
      return candidate.model === selectedModel;
    });
    if (!policy) {
      return null;
    }
    const route = getMemberModelPolicyRoute(policy);
    if (
      route.credentialScope !== "member" ||
      !isPersonalSubscriptionProviderType(route.providerType)
    ) {
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
    structuredRecoveryFrameworkFromMessage(
      structuredKind.kind,
      candidate.error,
    ),
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
 * The account the next run would spend: the active account of the current
 * route's subscription type. A limit on another framework says nothing about
 * that account, so it is only read when the frameworks agree.
 */
function createPersonalSubscriptionRecoveryComputed(
  classifiedAssistantError$: Computed<Promise<ClassifiedAssistantError | null>>,
  currentPersonalSubscription$: Computed<
    Promise<CurrentPersonalSubscription | null>
  >,
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
    const { modelProviders } = await get(personalModelProviders$);
    const provider = modelProviders.find((candidate) => {
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
  "accountLabel" | "limitWindow" | "resetWindows" | "retryAt"
> &
  Pick<AssistantErrorRecovery["actions"], "resetAndTryAgain"> {
  const resetWindows = providerSubscriptionResets(
    provider,
    classified.limitWindow,
  );
  const resetsRemaining = provider?.subscriptionResetCredits ?? 0;
  const resetAndTryAgain =
    classified.framework === "codex" &&
    classified.scope === "framework" &&
    provider &&
    resetsRemaining > 0
      ? { resetsRemaining, accountId: provider.id }
      : null;
  return {
    accountLabel: provider?.accountEmail ?? provider?.workspaceName ?? null,
    retryAt: latestKnownResetAt(resetWindows),
    resetWindows,
    limitWindow:
      resetWindows.length === 1
        ? resetWindows[0].limitWindow
        : classified.limitWindow,
    resetAndTryAgain,
  };
}

/**
 * Permanent failures never offer a blind retry. Every other failure retries on
 * the thread's current selection, which the card's model picker writes; the
 * card does not track which model failed, so switching models is the user's
 * call. A usage limit keeps its retry and shows when each window resets.
 */
function tryAgainAction(
  classified: ClassifiedAssistantError,
  retryAt: string | null,
): AssistantErrorRecovery["actions"]["tryAgain"] {
  if (
    classified.kind === "provider-settings" ||
    classified.kind === "new-chat-required" ||
    classified.kind === "input-too-large" ||
    classified.kind === "terms-acceptance-required" ||
    classified.kind === "safety-policy-refusal"
  ) {
    return null;
  }
  return { notBefore: retryAt };
}

function createAssistantErrorRecoveryComputed(
  visibleRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>,
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
      retryAt: recovery.retryAt,
      resetWindows: recovery.resetWindows,
      actions: {
        tryAgain: tryAgainAction(classified, recovery.retryAt),
        resetAndTryAgain: recovery.resetAndTryAgain,
      },
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
  const sendContinueMessage$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const meta = get(threadMeta$);
      if (!meta) {
        return false;
      }
      const userMessage = textToMessageDocument(CONTINUE_PROMPT);
      if (!userMessage) {
        throw new Error("Failed to serialize continue message");
      }
      const modelSelection = isSupportedRunModel(meta.selectedModel)
        ? {
            selectedModel: meta.selectedModel,
            ...(meta.serviceTier === "priority"
              ? { codexServiceTier: "fast" as const }
              : {}),
          }
        : null;
      const features = get(featureSwitch$);
      const runOptions = runOptionsFromModelProviderSelection(modelSelection);
      await set(
        deps.chatEvents.sendEvent$,
        {
          kind: "input",
          delivery: "run",
          agentId: meta.agentId,
          prompt: CONTINUE_PROMPT,
          hasTextContent: true,
          userMessage,
          // The recovery card's model picker writes the thread selection, so
          // the continue run already uses it. Sending it here is what lets the
          // optimistic event carry the run-model annotation the transcript's
          // model-change divider reads, instead of waiting for the server copy.
          selectedModel: meta.selectedModel,
          ...(runOptions ? { runOptions } : {}),
          ...(features[FeatureSwitchKey.RealAgentInPreview]
            ? { realAgentInPreview: true }
            : {}),
        },
        signal,
      );
      return true;
    },
  );
  const retryAssistantError$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const recovery = await get(assistantErrorRecovery$);
      signal.throwIfAborted();
      if (!recovery?.actions.tryAgain) {
        return false;
      }
      return await set(sendContinueMessage$, signal);
    },
  );
  const resetCodexSubscriptionAndRetry$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const recovery = await get(assistantErrorRecovery$);
      signal.throwIfAborted();
      if (!recovery?.actions.resetAndTryAgain) {
        return false;
      }
      const result = await set(
        resetPersonalCodexAccountSubscriptionUsage$,
        {
          // This action is offered only for Codex runs; see the
          // `framework === "codex"` gate on `resetAndTryAgain`.
          type: "codex-oauth-token",
          account: recovery.actions.resetAndTryAgain.accountId,
        },
        signal,
      );
      signal.throwIfAborted();
      if (result.outcome === "noCredit") {
        return false;
      }
      return await set(sendContinueMessage$, signal);
    },
  );

  return {
    assistantErrorRecovery$,
    assistantErrorRecoveryEventId$,
    retryAssistantError$,
    resetCodexSubscriptionAndRetry$,
  };
}
