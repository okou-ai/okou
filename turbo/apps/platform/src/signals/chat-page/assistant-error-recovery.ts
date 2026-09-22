import { hasChatEventBodyContent } from "./chat-event-body-blocks.ts";
import { command, computed, type Computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isChatEventContentTextType } from "@okouai/api-contracts/contracts/chat-events";
import {
  getCodexChatGptAccountUnsupportedModel,
  isAgentExecutionTimeoutRunError,
} from "@okouai/api-contracts/contracts/errors";
import type { GetRunResponse } from "@okouai/api-contracts/contracts/runs";
import type { RunDetailSignals } from "./run-detail.ts";
import type { ModelProviderFramework } from "@okouai/api-contracts/contracts/model-provider-types";
import {
  getFrameworkForType,
  getBuiltInConcreteProviderType,
  isSupportedRunModel,
  type ModelProviderResponse,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  knownRunFailureReasonSchema,
  type KnownRunFailureReason,
} from "@okouai/api-contracts/contracts/run-failure-reasons";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { resetPersonalCodexAccountSubscriptionUsage$ } from "../okou-page/settings/personal-model-providers.ts";
import { now } from "../../lib/time.ts";
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

interface ClassifiedAssistantError {
  readonly sourceEventId: string;
  readonly runId?: string;
  readonly source?: GetRunResponse["source"];
  readonly failureReason: KnownRunFailureReason | null;
  readonly providerMessage: string;
  readonly kind: AssistantErrorRecoveryKind;
  readonly framework: ModelProviderFramework | null;
  readonly scope: AssistantErrorRecoveryScope;
  readonly limitWindow: AssistantErrorRecoveryWindow | null;
  readonly retryLabel: string | null;
  readonly failedModel: SupportedRunModel | null;
}

export type AssistantErrorRecovery = ClassifiedAssistantError & {
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
      readonly runId: string;
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
    failedModel: null,
  };
}

function classifyAssistantErrorFromText(
  event: EnrichedChatEvent,
  error: string,
): ClassifiedAssistantError | null {
  const normalized = normalizedProviderMessage(error);
  const retryLabel = resetLabelFromProviderMessage(normalized);
  const unsupportedModel = getCodexChatGptAccountUnsupportedModel(error);

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
      failedModel: null,
    };
  }

  if (unsupportedModel !== undefined) {
    return {
      sourceEventId: event.id,
      failureReason: null,
      providerMessage: error,
      kind: "model-unavailable",
      framework: "codex",
      scope: "model",
      limitWindow: null,
      retryLabel: null,
      failedModel: isSupportedRunModel(unsupportedModel)
        ? unsupportedModel
        : null,
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
      failedModel: null,
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
      failedModel: null,
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
      failedModel: null,
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
      failedModel: null,
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
  const unsupportedModel = getCodexChatGptAccountUnsupportedModel(error);
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
    failedModel:
      kind === "model-unavailable" &&
      unsupportedModel !== undefined &&
      isSupportedRunModel(unsupportedModel)
        ? unsupportedModel
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

function runSourceFramework(
  source: GetRunResponse["source"] | undefined,
): ModelProviderFramework | null {
  const provider = source?.runtimeProviderType ?? source?.providerType;
  if (!provider) {
    return null;
  }
  if (provider === "built-in") {
    return source?.model && isSupportedRunModel(source.model)
      ? getFrameworkForType(getBuiltInConcreteProviderType(source.model))
      : null;
  }
  return getFrameworkForType(provider);
}

function historicalSubscriptionError(
  event: EnrichedChatEvent,
  error: string,
  source: GetRunResponse["source"] | undefined,
): ClassifiedAssistantError | null {
  const subscriptionFailureReasons = [
    "reconnect_required",
    "invalid_credentials",
    "provider_rate_limited",
    "provider_stream_timeout",
    "provider_server_error",
    "response_connection_lost",
  ];
  if (
    (event.eventType === "run.failed" &&
      event.failureReason !== undefined &&
      !subscriptionFailureReasons.includes(event.failureReason)) ||
    ["insufficient_credits", "pro_required"].includes(
      error.trim().toLowerCase(),
    ) ||
    source?.credentialScope !== "member" ||
    (source.providerType !== "codex-oauth-token" &&
      source.providerType !== "claude-code-oauth-token")
  ) {
    return null;
  }
  return {
    sourceEventId: event.id,
    ...(event.runId ? { runId: event.runId } : {}),
    source,
    failureReason: null,
    kind: "subscription-error",
    providerMessage: error,
    framework: getFrameworkForType(source.providerType),
    scope: "framework",
    limitWindow: null,
    retryLabel: null,
    failedModel: null,
  };
}

function createClassifiedAssistantErrorComputed(
  visibleRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>,
  runDetails$: Computed<ReadonlyMap<string, RunDetailSignals>>,
): Computed<Promise<ClassifiedAssistantError | null>> {
  return computed(async (get): Promise<ClassifiedAssistantError | null> => {
    const candidate = latestAssistantErrorCandidate(
      await get(visibleRenderedChatGroups$),
    );
    if (candidate === null) {
      return null;
    }

    const runId = candidate.event.runId;
    const detailSignals = runId ? get(runDetails$).get(runId) : undefined;
    const source = detailSignals
      ? (await get(detailSignals.detail$))?.source
      : undefined;
    const structuredKind = structuredRecoveryKind(candidate.event);
    if (structuredKind === null) {
      return historicalSubscriptionError(
        candidate.event,
        candidate.error,
        source,
      );
    }

    let classified: ClassifiedAssistantError | null;
    if (structuredKind === undefined) {
      classified = classifyAssistantErrorFromText(
        candidate.event,
        candidate.error,
      );
    } else if (structuredKind.kind === null) {
      classified = null;
    } else if (structuredKind.kind === "execution-timeout") {
      classified = classifyExecutionTimeout(candidate.event, candidate.error);
    } else {
      const frameworkFromMessage = structuredRecoveryFrameworkFromMessage(
        structuredKind.kind,
        candidate.error,
      );
      const framework = runSourceFramework(source) ?? frameworkFromMessage;
      classified = classifyStructuredAssistantError(
        candidate.event,
        candidate.error,
        structuredKind.failureReason,
        structuredKind.kind,
        framework,
      );
    }
    if (classified === null) {
      return historicalSubscriptionError(
        candidate.event,
        candidate.error,
        source,
      );
    }
    const sourceFramework = runSourceFramework(source);
    const classifiedWithSource = sourceFramework
      ? { ...classified, framework: sourceFramework }
      : classified;
    return {
      ...classifiedWithSource,
      ...(runId ? { runId } : {}),
      ...(source ? { source } : {}),
      ...((classified.kind === "model-unavailable" ||
        classified.kind === "usage-limit") &&
      source?.model &&
      isSupportedRunModel(source.model)
        ? { failedModel: source.model }
        : {}),
    };
  });
}

function recoveryForExactAccount(
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
  const source = classified.source;
  const resetAndTryAgain =
    classified.framework === "codex" &&
    classified.scope === "framework" &&
    provider &&
    !provider.needsReconnect &&
    resetsRemaining > 0 &&
    classified.runId &&
    source?.account.status === "connected"
      ? {
          resetsRemaining,
          accountId: source.account.id,
          runId: classified.runId,
        }
      : null;
  return {
    accountLabel: provider?.accountEmail ?? provider?.workspaceName ?? null,
    retryAt: latestKnownResetAt(resetWindows),
    resetWindows,
    limitWindow:
      resetWindows.length === 1
        ? (resetWindows[0]?.limitWindow ?? classified.limitWindow)
        : classified.limitWindow,
    resetAndTryAgain,
  };
}

/**
 * Permanent failures never offer a blind retry. An unsupported model, and an
 * exhausted account with a known future reset, become retryable only after the
 * thread points at another model. The command reads that same thread selection,
 * so the card cannot immediately spend another run on the unchanged route.
 */
function tryAgainAction(
  classified: ClassifiedAssistantError,
  retryAt: string | null,
  selectedModel: string | null,
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

  const waitsForAnotherRoute =
    classified.kind === "model-unavailable" ||
    (classified.kind === "usage-limit" &&
      retryAt !== null &&
      new Date(retryAt).getTime() > now());
  if (!waitsForAnotherRoute) {
    return { notBefore: retryAt };
  }

  const replaced =
    isSupportedRunModel(selectedModel) &&
    selectedModel !== classified.failedModel;
  return replaced ? { notBefore: null } : null;
}

function createAssistantErrorRecoveryComputed(
  visibleRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>,
  runDetails$: Computed<ReadonlyMap<string, RunDetailSignals>>,
  selectedModel$: Computed<string | null>,
) {
  const classifiedAssistantError$ = createClassifiedAssistantErrorComputed(
    visibleRenderedChatGroups$,
    runDetails$,
  );
  return computed(async (get): Promise<AssistantErrorRecovery | null> => {
    const classified = await get(classifiedAssistantError$);
    if (classified === null) {
      return null;
    }
    let provider: ModelProviderResponse | undefined;

    if (classified.kind === "usage-limit") {
      const source = classified.source;
      const detailSignals = classified.runId
        ? get(runDetails$).get(classified.runId)
        : undefined;
      const providerType =
        classified.framework === "codex"
          ? "codex-oauth-token"
          : classified.framework === "claude-code"
            ? "claude-code-oauth-token"
            : null;
      const usesSubscription =
        providerType !== null &&
        source?.credentialScope === "member" &&
        source.providerType === providerType;
      provider =
        usesSubscription &&
        detailSignals &&
        source.account.status === "connected"
          ? await get(detailSignals.recoveryAccount$)
          : undefined;
    }

    const recovery = recoveryForExactAccount(classified, provider);
    return {
      ...classified,
      accountLabel: recovery.accountLabel,
      limitWindow: recovery.limitWindow,
      retryAt: recovery.retryAt,
      resetWindows: recovery.resetWindows,
      actions: {
        tryAgain: tryAgainAction(
          classified,
          recovery.retryAt,
          get(selectedModel$),
        ),
        resetAndTryAgain: recovery.resetAndTryAgain,
      },
    };
  });
}

export function createAssistantErrorRecoverySignals(deps: {
  readonly threadId: string;
  readonly chatEvents: ChatEventSignals;
  readonly visibleRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>;
  readonly runDetails$: Computed<ReadonlyMap<string, RunDetailSignals>>;
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
    deps.runDetails$,
    selectedModel$,
  );
  /**
   * Which event the recovery will attach to follows from the transcript alone,
   * while the recovery itself waits on the run detail and the account behind
   * it. Publishing the identity separately lets the one card that is waiting
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
          account: {
            id: recovery.actions.resetAndTryAgain.accountId,
            runId: recovery.actions.resetAndTryAgain.runId,
          },
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
