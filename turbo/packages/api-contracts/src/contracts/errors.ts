import { z } from "zod";
import { formatRunBalanceError } from "./run-balance-errors";
import {
  getCanonicalModelDisplayName,
  normalizeRunModelId,
  type ModelProviderCredentialScope,
  type ModelProviderType,
} from "./model-providers";
import type { ModelProviderFramework } from "./model-provider-types";
import {
  knownRunFailureReasonSchema,
  type KnownRunFailureReason,
  type RunFailureReasonToken,
} from "./run-failure-reasons";

/**
 * API error definitions with associated HTTP status codes
 * Used across all API endpoints for consistent error responses
 */
export const ApiError = {
  BAD_REQUEST: { status: 400 as const, code: "BAD_REQUEST" },
  UNAUTHORIZED: { status: 401 as const, code: "UNAUTHORIZED" },
  FORBIDDEN: { status: 403 as const, code: "FORBIDDEN" },
  NOT_FOUND: { status: 404 as const, code: "NOT_FOUND" },
  CONFLICT: { status: 409 as const, code: "CONFLICT" },
  AUTONOMY_BUDGET_EXHAUSTED: {
    status: 409 as const,
    code: "AUTONOMY_BUDGET_EXHAUSTED",
  },
  RUN_NOT_CANCELLABLE: {
    status: 400 as const,
    code: "RUN_NOT_CANCELLABLE",
  },
  INSUFFICIENT_CREDITS: {
    status: 402 as const,
    code: "INSUFFICIENT_CREDITS",
  },
  PRO_REQUIRED: {
    status: 402 as const,
    code: "PRO_REQUIRED",
  },
  PAYLOAD_TOO_LARGE: { status: 413 as const, code: "PAYLOAD_TOO_LARGE" },
  TOO_MANY_REQUESTS: { status: 429 as const, code: "TOO_MANY_REQUESTS" },
  NO_MODEL_PROVIDER: {
    status: 422 as const,
    code: "NO_MODEL_PROVIDER",
  },
  PROVIDER_UNAVAILABLE: {
    status: 503 as const,
    code: "PROVIDER_UNAVAILABLE",
  },
  MODEL_PROVIDER_UNAVAILABLE: {
    status: 503 as const,
    code: "MODEL_PROVIDER_UNAVAILABLE",
  },
  EVENT_DELIVERY_UNAVAILABLE: {
    status: 503 as const,
    code: "EVENT_DELIVERY_UNAVAILABLE",
  },
  PROVIDER_DELETED: {
    status: 422 as const,
    code: "PROVIDER_DELETED",
  },
  CODEX_AUTH_JSON_SHAPE_INVALID: {
    status: 400 as const,
    code: "CODEX_AUTH_JSON_SHAPE_INVALID",
  },
  CODEX_FREE_PLAN_REJECTED: {
    status: 400 as const,
    code: "CODEX_FREE_PLAN_REJECTED",
  },
  INTERNAL_SERVER_ERROR: {
    status: 500 as const,
    code: "INTERNAL_SERVER_ERROR",
  },
} as const;

export type ApiErrorKey = keyof typeof ApiError;

/**
 * Helper to create a standardized error response
 * Ensures the correct HTTP status code is always used with the error code
 */
export function createErrorResponse<K extends ApiErrorKey>(
  errorKey: K,
  message: string,
) {
  const { status, code } = ApiError[errorKey];
  return {
    status,
    body: { error: { message, code } },
  };
}

/**
 * Standard API error response schema
 * Used across all API endpoints for consistent error handling
 */
export const apiErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.string(),
  }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;

export const PLAN_UPGRADE_RUN_GUIDANCE =
  "Return the plan upgrade link to the user.";
export const PLAN_UPGRADE_CLI_HINT = "okou upgrade pro";

/**
 * Centralized guidance registry for run error codes.
 * All client surfaces (Web, CLI, Slack, Telegram) use this to render
 * actionable error messages. To add a new error code, add an entry here
 * and create the corresponding factory function in errors.ts.
 */
export const RUN_ERROR_GUIDANCE: Record<
  string,
  { title: string; guidance: string; cliHint?: string }
> = {
  COMPUTER_USE_AUTHORIZATION_REQUIRED: {
    title: "Computer Use authorization required",
    guidance:
      "Request a delegated Computer Use authorization link, ask the user to select an Okou Desktop host for this chat or Slack thread, then start a new run. Existing run tokens cannot be upgraded in place.",
    cliHint:
      "okou connector permission-request computer-use --permission computer-use:write",
  },
  NO_MODEL_PROVIDER: {
    title: "No model provider configured",
    guidance: "Configure a model provider to start running agents.",
    cliHint: "okou model-provider set --help",
  },
  INSUFFICIENT_CREDITS: {
    title: "Credits depleted",
    guidance:
      "Run credit diagnostics first. Buy credits only when the current plan allows it; otherwise return the plan upgrade link.",
    cliHint: "okou doctor credit",
  },
  GENERATION_OUTPUT_SAFETY_BLOCKED: {
    title: "Generated image blocked",
    guidance:
      "Try again once. If it is blocked again, change the prompt or reference image before retrying.",
  },
  GENERATION_INPUT_SAFETY_REJECTED: {
    title: "Image request blocked",
    guidance:
      "Change the prompt or reference image before trying again. Retrying the unchanged request is unlikely to help.",
  },
  GENERATION_INPUT_MEDIA_UNREACHABLE: {
    title: "Input image unavailable",
    guidance:
      "Use a public URL that returns the image directly without authentication or a browser challenge, then try again.",
  },
  GENERATION_INPUT_MEDIA_INVALID: {
    title: "Input image invalid",
    guidance:
      "Replace or re-encode the image in a supported format, then try again.",
  },
  GENERATION_INVALID_PARAMETERS: {
    title: "Invalid image generation options",
    guidance: "Correct the image generation parameters before trying again.",
  },
  GENERATION_PROVIDER_UNAVAILABLE: {
    title: "Image provider unavailable",
    guidance:
      "The image generation provider is temporarily unavailable. Please try again shortly.",
  },
  GENERATION_FAILED: {
    title: "Image generation failed",
    guidance:
      "Try again once. If it still fails, contact support with the time, model, and error code.",
  },
  PRO_REQUIRED: {
    title: "Paid plan required",
    guidance: "Built-in video generation is unavailable on the current plan.",
  },
  PROVIDER_INCOMPATIBLE: {
    title: "Provider not compatible",
    guidance: "This session was created with a different provider type.",
  },
  PROVIDER_UNAVAILABLE: {
    title: "Provider temporarily unavailable",
    guidance:
      "The model provider is temporarily unavailable. Please try again later.",
  },
  MODEL_PROVIDER_UNAVAILABLE: {
    title: "Model temporarily unavailable",
    guidance:
      "Every built-in model route for this model is temporarily unavailable. Please try again later.",
  },
  PROVIDER_DELETED: {
    title: "Model provider unavailable",
    guidance:
      "The model provider used by this thread has been deleted. Start a new chat thread to continue.",
  },
  TOO_MANY_REQUESTS: {
    title: "Concurrent run limit reached",
    guidance:
      "Wait for your current run to complete before starting a new one.",
  },
  SOCIAL_TRANSCRIPT_UNAVAILABLE: {
    title: "Transcript unavailable",
    guidance:
      "The provider did not return transcript data for this social video. A missing transcript is not evidence that the video contains no speech.",
  },
  SOCIAL_TRANSCRIPT_AVAILABILITY_UNKNOWN: {
    title: "Transcript availability unknown",
    guidance:
      "The provider did not establish whether the source or its transcript is unavailable. No transcript was returned, and this is not evidence that the video contains no speech.",
  },
  SOCIAL_TRANSCRIPT_ACCESS_DENIED: {
    title: "Transcript access denied",
    guidance:
      "The social data service denied transcript access, possibly because transcripts are disabled. This is not an Okou authentication failure.",
  },
  // Keep guidance for responses from an older API deployment while the CLI
  // maps those codes to the provider-neutral values above.
  SOCIALKIT_TRANSCRIPT_UNAVAILABLE: {
    title: "Transcript unavailable",
    guidance:
      "The provider did not return transcript data for this social video. A missing transcript is not evidence that the video contains no speech.",
  },
  SOCIALKIT_TRANSCRIPT_AVAILABILITY_UNKNOWN: {
    title: "Transcript availability unknown",
    guidance:
      "The provider did not establish whether the source or its transcript is unavailable. No transcript was returned, and this is not evidence that the video contains no speech.",
  },
  SOCIALKIT_TRANSCRIPT_ACCESS_DENIED: {
    title: "Transcript access denied",
    guidance:
      "The social data service denied transcript access, possibly because transcripts are disabled. This is not an Okou authentication failure.",
  },
};

export const CHAT_RUN_TRANSIENT_ERROR_MESSAGE =
  "Oops, something went wrong. Please try again later.";

export const CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE =
  "This run reached its execution time limit.";

/**
 * A provider content-safety rejection is deterministic for the same input, so
 * this copy must not invite a retry. It names the actions the user can take
 * without describing or attributing the rejected content.
 */
export const CHAT_RUN_CONTENT_POLICY_REJECTED_MESSAGE =
  "The model provider rejected this request under its content safety policy. Retrying the same input will fail again. Try rephrasing the request, starting a new conversation, or switching to a different model.";

const AGENT_EXECUTION_TIMEOUT_RUN_ERROR =
  /^Agent execution timed out after [1-9]\d* seconds$/u;

export const CODEX_OAUTH_RECONNECT_REQUIRED_MESSAGE =
  "ChatGPT session needs reconnection. Reconnect ChatGPT (Codex) in Model Providers, then retry.";

export const CLAUDE_CODE_SUBSCRIPTION_RECONNECT_REQUIRED_MESSAGE =
  "Claude Code subscription authentication failed. Reconnect Claude Code in Model Providers, then retry.";

export const CLAUDE_CODE_ANTHROPIC_API_KEY_ADMIN_MESSAGE =
  "Claude Code could not authenticate with the configured Anthropic API key. Update or replace the API key in Model Providers, then retry.";

export const CLAUDE_CODE_ANTHROPIC_API_KEY_MEMBER_MESSAGE =
  "Claude Code could not authenticate with the configured Anthropic API key. Ask a workspace admin to update or replace the API key.";

export const CLAUDE_CODE_TERMS_ACCEPTANCE_REQUIRED_MESSAGE =
  "Claude Code requires acceptance of updated Consumer Terms and Privacy Policy. Sign in to https://claude.ai with the Claude account connected in Model Providers, accept the updated terms and policy, then retry.";

const CLAUDE_PROVIDER_OVERLOADED_FALLBACK_MODEL = "Claude Model";
export const CLAUDE_PROVIDER_OVERLOADED_GUIDANCE =
  "is overloaded. Please wait a few minutes and try again, or switch to another model.";
export const CODEX_PROVIDER_OVERLOADED_MESSAGE =
  "Selected model is at capacity. Please try a different model.";

const CLAUDE_CODE_LIMIT_SNIPPETS = [
  "usage limit",
  "usage_limit",
  "usage-limit",
  "rate limit",
  "rate_limit",
  "rate-limit",
  "subscription limit",
  "ai limit reached",
  "code limit reached",
  "5-hour limit",
  "five-hour limit",
] as const;

const codexOAuthReconnectRequiredRunErrorBodySchema = z.object({
  error: z.literal("TOKEN_REFRESH_FAILED"),
  connectors: z.tuple([z.literal("codex-oauth-token")]),
  failureReason: z.literal("reconnect_required"),
});

const codexOAuthReconnectRequiredRunErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.literal("TOKEN_REFRESH_FAILED"),
    connectors: z.tuple([z.literal("codex-oauth-token")]),
    failureReason: z.literal("reconnect_required"),
  }),
});

const codexChatGptAccountUnsupportedModelRunErrorSchema = z.object({
  type: z.literal("error"),
  status: z.literal(400),
  error: z.object({
    type: z.literal("invalid_request_error"),
    message: z.string(),
  }),
});

const CODEX_CHATGPT_ACCOUNT_UNSUPPORTED_MODEL_MESSAGE =
  /^The '([^']+)' model is not supported when using Codex with a ChatGPT account\.$/u;

export const INSUFFICIENT_CREDITS_ASK_ADMIN_MESSAGE =
  "Ask a workspace admin to add credits or upgrade the workspace plan.";

export const ACTIONABLE_RUN_ERROR_SNIPPETS = [
  ...Object.values(RUN_ERROR_GUIDANCE).flatMap((guidance) => {
    return [guidance.title, guidance.guidance];
  }),
  "Cannot continue session",
  "Invalid signature in thinking block",
  "Run cancelled",
  CODEX_PROVIDER_OVERLOADED_MESSAGE,
  // Upstream model usage/quota limits are shown verbatim (the CLI already
  // emits clean, user-friendly copy with reset time and upgrade links).
  // Codex: "You've hit your usage limit …"
  "usage limit",
  "usage_limit",
  "usage-limit",
  "UsageLimit",
  // Claude Code subscription limits:
  //   "You've hit your session limit · resets …"
  //   "You've hit your weekly limit · resets …"
  "session limit",
  "weekly limit",
  CODEX_OAUTH_RECONNECT_REQUIRED_MESSAGE,
  CLAUDE_CODE_SUBSCRIPTION_RECONNECT_REQUIRED_MESSAGE,
  CLAUDE_CODE_ANTHROPIC_API_KEY_ADMIN_MESSAGE,
  CLAUDE_CODE_ANTHROPIC_API_KEY_MEMBER_MESSAGE,
  CLAUDE_CODE_TERMS_ACCEPTANCE_REQUIRED_MESSAGE,
] as const;

type ClaudeCodeCredentialRecovery = {
  readonly modelProviderType: ModelProviderType | null | undefined;
  readonly modelProviderCredentialScope:
    | ModelProviderCredentialScope
    | null
    | undefined;
  readonly canManageOrgModelProviders: boolean;
  readonly modelProvidersUrl: string | undefined;
};

function isWordBoundaryChar(char: string | undefined): boolean {
  return char === undefined || !/[a-z0-9_-]/u.test(char);
}

function startsWithOverloadedWord(value: string): boolean {
  return (
    value.startsWith("overloaded") &&
    isWordBoundaryChar(value["overloaded".length])
  );
}

function containsOverloadedErrorType(value: string): boolean {
  return /(^|[^a-z0-9_])overloaded_error([^a-z0-9_]|$)/u.test(value);
}

function claude529ErrorDetail(value: string): string | undefined {
  const detail = value.trimStart();
  const repeatedMatch = /^repeated\s+529\b/u.exec(detail);
  if (repeatedMatch) {
    return detail.slice(repeatedMatch[0].length).trimStart();
  }

  const statusMatch = /^529\b/u.exec(detail);
  if (!statusMatch) {
    return undefined;
  }
  return detail.slice(statusMatch[0].length).trimStart();
}

function isClaudeProviderOverloadedErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  const marker = "api error:";
  let markerIndex = normalized.indexOf(marker);

  while (markerIndex !== -1) {
    const detail = claude529ErrorDetail(
      normalized.slice(markerIndex + marker.length),
    );
    if (
      detail !== undefined &&
      (startsWithOverloadedWord(detail) || containsOverloadedErrorType(detail))
    ) {
      return true;
    }
    markerIndex = normalized.indexOf(marker, markerIndex + marker.length);
  }

  return false;
}

function formatClaudeProviderOverloadedMessage(
  selectedModel: string | null | undefined,
): string {
  const trimmedModel = selectedModel?.trim();
  const modelLabel = trimmedModel
    ? getCanonicalModelDisplayName(normalizeRunModelId(trimmedModel))
    : CLAUDE_PROVIDER_OVERLOADED_FALLBACK_MODEL;
  return `${modelLabel} ${CLAUDE_PROVIDER_OVERLOADED_GUIDANCE}`;
}

export function formatClaudeProviderOverloadedRunError(params: {
  readonly message: string;
  readonly selectedModel?: string | null;
}): string | undefined {
  const errorMessage = params.message.trim();
  if (!isClaudeProviderOverloadedErrorMessage(errorMessage)) {
    return undefined;
  }
  return formatClaudeProviderOverloadedMessage(params.selectedModel);
}

function isJsonWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function findNextJsonObjectStart(
  errorMessage: string,
  searchStart: number,
): number {
  let bodyStart = errorMessage.indexOf("{", searchStart);
  while (bodyStart !== -1) {
    let nextNonWhitespace = bodyStart + 1;
    while (isJsonWhitespace(errorMessage[nextNonWhitespace])) {
      nextNonWhitespace += 1;
    }

    const firstToken = errorMessage[nextNonWhitespace];
    if (firstToken === '"' || firstToken === "}") {
      return bodyStart;
    }
    bodyStart = errorMessage.indexOf("{", bodyStart + 1);
  }
  return -1;
}

function parseNextJsonObject(
  errorMessage: string,
  searchStart: number,
): { readonly value?: unknown; readonly endIndex: number } | undefined {
  const bodyStart = findNextJsonObjectStart(errorMessage, searchStart);
  if (bodyStart === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = bodyStart; index < errorMessage.length; index += 1) {
    const char = errorMessage[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") {
      continue;
    }

    depth -= 1;
    if (depth !== 0) {
      continue;
    }

    try {
      return {
        value: JSON.parse(errorMessage.slice(bodyStart, index + 1)) as unknown,
        endIndex: index + 1,
      };
    } catch {
      return { endIndex: index + 1 };
    }
  }

  return { endIndex: errorMessage.length };
}

function isCodexOAuthReconnectRequiredRunErrorObject(value: unknown): boolean {
  return (
    codexOAuthReconnectRequiredRunErrorBodySchema.safeParse(value).success ||
    codexOAuthReconnectRequiredRunErrorEnvelopeSchema.safeParse(value).success
  );
}

function codexChatGptAccountUnsupportedModelFromObject(
  value: unknown,
): string | undefined {
  const parsed =
    codexChatGptAccountUnsupportedModelRunErrorSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return CODEX_CHATGPT_ACCOUNT_UNSUPPORTED_MODEL_MESSAGE.exec(
    parsed.data.error.message,
  )?.[1];
}

export function getCodexChatGptAccountUnsupportedModel(
  errorMessage: string,
): string | undefined {
  if (
    !errorMessage.includes(
      "not supported when using Codex with a ChatGPT account",
    )
  ) {
    return undefined;
  }

  let searchStart = 0;
  let parsed = parseNextJsonObject(errorMessage, searchStart);
  while (parsed !== undefined) {
    const model = codexChatGptAccountUnsupportedModelFromObject(parsed.value);
    if (model !== undefined) {
      return model;
    }
    searchStart = parsed.endIndex;
    parsed = parseNextJsonObject(errorMessage, searchStart);
  }
  return undefined;
}

export function isCodexChatGptAccountUnsupportedModelRunError(
  errorMessage: string,
): boolean {
  return getCodexChatGptAccountUnsupportedModel(errorMessage) !== undefined;
}

function isCodexOAuthReconnectRequiredRunError(errorMessage: string): boolean {
  if (
    !errorMessage.includes("TOKEN_REFRESH_FAILED") ||
    !errorMessage.includes("codex-oauth-token") ||
    !errorMessage.includes("reconnect_required")
  ) {
    return false;
  }

  let searchStart = 0;
  let parsed = parseNextJsonObject(errorMessage, searchStart);
  while (parsed !== undefined) {
    if (isCodexOAuthReconnectRequiredRunErrorObject(parsed?.value)) {
      return true;
    }
    searchStart = parsed.endIndex;
    parsed = parseNextJsonObject(errorMessage, searchStart);
  }
  return false;
}

function hasActionableRunErrorSnippet(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return ACTIONABLE_RUN_ERROR_SNIPPETS.some((snippet) => {
    return normalized.includes(snippet.toLowerCase());
  });
}

function isClaudeCodeLimitError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  if (!normalized.includes("claude")) {
    return false;
  }

  return CLAUDE_CODE_LIMIT_SNIPPETS.some((snippet) => {
    return normalized.includes(snippet);
  });
}

export function isClaudeCodeAuthenticationCredentialsError(
  errorMessage: string,
): boolean {
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("401") &&
    normalized.includes("invalid authentication credentials")
  );
}

function isClaudeCodeOAuthReconnectRequiredError(
  errorMessage: string,
): boolean {
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("failed to authenticate") &&
    /api error:[\s:.-]*401(?![a-z0-9_-])/u.test(normalized) &&
    normalized.includes("oauth access token") &&
    (normalized.includes("revoked") ||
      /(?:^|[^a-z0-9_-])oauth access token is invalid(?![a-z0-9_-])/u.test(
        normalized,
      ))
  );
}

function isClaudeCodeTermsAcceptanceRequiredError(
  errorMessage: string,
): boolean {
  const normalized = errorMessage.toLowerCase();
  return (
    /api error:[\s:.-]*400(?![a-z0-9_-])/u.test(normalized) &&
    normalized.includes("consumer terms") &&
    normalized.includes("privacy policy") &&
    normalized.includes("accept") &&
    normalized.includes("claude.ai")
  );
}

export function isActionableRunError(errorMessage: string): boolean {
  return (
    isAgentExecutionTimeoutRunError(errorMessage) ||
    isCodexOAuthReconnectRequiredRunError(errorMessage) ||
    isCodexChatGptAccountUnsupportedModelRunError(errorMessage) ||
    isClaudeCodeLimitError(errorMessage) ||
    isClaudeCodeTermsAcceptanceRequiredError(errorMessage) ||
    hasActionableRunErrorSnippet(errorMessage)
  );
}

export function isAgentExecutionTimeoutRunError(errorMessage: string): boolean {
  const normalized = errorMessage.trim();
  return (
    normalized === CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE ||
    AGENT_EXECUTION_TIMEOUT_RUN_ERROR.test(normalized)
  );
}

function withOptionalActionUrl(
  message: string,
  label: string,
  url: string | undefined,
): string {
  return url ? `${message}\n\n${label}: ${url}` : message;
}

function formatClaudeCodeCredentialRecoveryMessage(
  recovery: ClaudeCodeCredentialRecovery,
): string | undefined {
  if (recovery.modelProviderType === "claude-code-oauth-token") {
    return withOptionalActionUrl(
      CLAUDE_CODE_SUBSCRIPTION_RECONNECT_REQUIRED_MESSAGE,
      "Reconnect Claude Code",
      recovery.modelProvidersUrl,
    );
  }

  if (recovery.modelProviderType !== "anthropic-api-key") {
    return undefined;
  }

  if (
    recovery.modelProviderCredentialScope === "org" &&
    !recovery.canManageOrgModelProviders
  ) {
    return withOptionalActionUrl(
      CLAUDE_CODE_ANTHROPIC_API_KEY_MEMBER_MESSAGE,
      "Share with an admin",
      recovery.modelProvidersUrl,
    );
  }

  return withOptionalActionUrl(
    CLAUDE_CODE_ANTHROPIC_API_KEY_ADMIN_MESSAGE,
    "Open Model Providers",
    recovery.modelProvidersUrl,
  );
}

export function isGenericRunErrorForDisplay(errorMessage: string): boolean {
  const normalizedErrorMessage = errorMessage.trim() || "Run failed";
  return !isActionableRunError(normalizedErrorMessage);
}

type StructuredRunErrorBehavior =
  | "content-policy"
  | "credential"
  | "execution-timeout"
  | "generic"
  | "insufficient-credits"
  | "provider-balance"
  | "overloaded"
  | "passthrough"
  | "reconnect"
  | "terms";

const STRUCTURED_RUN_ERROR_BEHAVIOR: Record<
  KnownRunFailureReason,
  StructuredRunErrorBehavior
> = {
  session_history_limit: "generic",
  execution_timeout: "execution-timeout",
  insufficient_credits: "insufficient-credits",
  provider_insufficient_credits: "provider-balance",
  invalid_api_key: "generic",
  invalid_credentials: "credential",
  terms_acceptance_required: "terms",
  context_window_exceeded: "generic",
  input_too_large: "generic",
  output_token_limit: "generic",
  provider_rate_limited: "generic",
  provider_overloaded: "overloaded",
  provider_stream_timeout: "generic",
  provider_server_error: "generic",
  response_connection_lost: "generic",
  safety_policy_refusal: "content-policy",
  reconnect_required: "reconnect",
  unsupported_model: "passthrough",
  usage_limit: "passthrough",
};

function formatReconnectRunError(
  recovery: ClaudeCodeCredentialRecovery | undefined,
): string {
  if (recovery?.modelProviderType === "codex-oauth-token") {
    return CODEX_OAUTH_RECONNECT_REQUIRED_MESSAGE;
  }
  if (recovery?.modelProviderType === "claude-code-oauth-token") {
    return (
      formatClaudeCodeCredentialRecoveryMessage(recovery) ??
      CHAT_RUN_TRANSIENT_ERROR_MESSAGE
    );
  }
  return CHAT_RUN_TRANSIENT_ERROR_MESSAGE;
}

function formatStructuredRunError(params: {
  readonly failureReason: RunFailureReasonToken;
  readonly errorMessage: string;
  readonly framework?: ModelProviderFramework | null;
  readonly selectedModel?: string | null;
  readonly modelProviderType?: ModelProviderType | null;
  readonly claudeCodeCredentialRecovery?: ClaudeCodeCredentialRecovery;
}): string {
  const knownReason = knownRunFailureReasonSchema.safeParse(
    params.failureReason,
  );
  if (!knownReason.success) {
    return CHAT_RUN_TRANSIENT_ERROR_MESSAGE;
  }

  switch (STRUCTURED_RUN_ERROR_BEHAVIOR[knownReason.data]) {
    case "execution-timeout": {
      return CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE;
    }
    case "content-policy": {
      return CHAT_RUN_CONTENT_POLICY_REJECTED_MESSAGE;
    }
    case "insufficient-credits": {
      return "insufficient_credits";
    }
    case "provider-balance": {
      return formatRunBalanceError({
        failureReason: params.failureReason,
        modelProvider: params.modelProviderType,
      })!;
    }
    case "credential": {
      const recoveryMessage =
        params.claudeCodeCredentialRecovery === undefined
          ? undefined
          : formatClaudeCodeCredentialRecoveryMessage(
              params.claudeCodeCredentialRecovery,
            );
      return recoveryMessage ?? CHAT_RUN_TRANSIENT_ERROR_MESSAGE;
    }
    case "reconnect": {
      return formatReconnectRunError(params.claudeCodeCredentialRecovery);
    }
    case "terms": {
      return withOptionalActionUrl(
        CLAUDE_CODE_TERMS_ACCEPTANCE_REQUIRED_MESSAGE,
        "Open Model Providers",
        params.claudeCodeCredentialRecovery?.modelProvidersUrl,
      );
    }
    case "overloaded": {
      if (params.framework === "claude-code") {
        return formatClaudeProviderOverloadedMessage(params.selectedModel);
      }
      if (params.framework === "codex") {
        return CODEX_PROVIDER_OVERLOADED_MESSAGE;
      }
      return CHAT_RUN_TRANSIENT_ERROR_MESSAGE;
    }
    case "passthrough": {
      return params.errorMessage;
    }
    case "generic": {
      return CHAT_RUN_TRANSIENT_ERROR_MESSAGE;
    }
  }
}

/**
 * Plain-text run error copy shared by Web chat and external integrations.
 * Web may wrap generic failures with its report-link affordance after this
 * shared classification step.
 */
export function formatRunErrorForExternalSurface(params: {
  readonly code: string;
  readonly message: string;
  readonly failureReason?: RunFailureReasonToken;
  readonly framework?: ModelProviderFramework | null;
  readonly selectedModel?: string | null;
  readonly modelProviderType?: ModelProviderType | null;
  readonly claudeCodeCredentialRecovery?: ClaudeCodeCredentialRecovery;
  readonly insufficientCredits?:
    | {
        readonly canManageBilling: boolean;
        readonly addCreditsUrl: string;
        readonly comparePlansUrl?: string;
      }
    | {
        readonly canManageBilling: boolean;
        readonly comparePlansUrl: string;
        readonly addCreditsUrl?: string;
      };
}): string {
  const errorMessage = params.message.trim() || "Run failed";
  const modelProviderType = params.modelProviderType;
  if (params.failureReason !== undefined) {
    return formatStructuredRunError({
      failureReason: params.failureReason,
      errorMessage,
      framework: params.framework,
      selectedModel: params.selectedModel,
      modelProviderType,
      claudeCodeCredentialRecovery: params.claudeCodeCredentialRecovery,
    });
  }

  if (isAgentExecutionTimeoutRunError(errorMessage)) {
    return CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE;
  }

  const claudeOverloadedMessage = formatClaudeProviderOverloadedRunError({
    message: errorMessage,
    selectedModel: params.selectedModel,
  });
  if (claudeOverloadedMessage !== undefined) {
    return claudeOverloadedMessage;
  }

  if (isClaudeCodeTermsAcceptanceRequiredError(errorMessage)) {
    return withOptionalActionUrl(
      CLAUDE_CODE_TERMS_ACCEPTANCE_REQUIRED_MESSAGE,
      "Open Model Providers",
      params.claudeCodeCredentialRecovery?.modelProvidersUrl,
    );
  }

  if (
    params.claudeCodeCredentialRecovery !== undefined &&
    (isClaudeCodeAuthenticationCredentialsError(errorMessage) ||
      (params.claudeCodeCredentialRecovery.modelProviderType ===
        "claude-code-oauth-token" &&
        isClaudeCodeOAuthReconnectRequiredError(errorMessage)))
  ) {
    const recoveryMessage = formatClaudeCodeCredentialRecoveryMessage(
      params.claudeCodeCredentialRecovery,
    );
    if (recoveryMessage !== undefined) {
      return recoveryMessage;
    }
  }

  if (
    params.code === "INSUFFICIENT_CREDITS" &&
    params.insufficientCredits !== undefined
  ) {
    if (!params.insufficientCredits.canManageBilling) {
      return INSUFFICIENT_CREDITS_ASK_ADMIN_MESSAGE;
    }
    if (params.insufficientCredits.addCreditsUrl !== undefined) {
      return `${errorMessage}\n\nAdd credits: ${params.insufficientCredits.addCreditsUrl}`;
    }
    return `${errorMessage}\n\nCompare plans: ${params.insufficientCredits.comparePlansUrl}`;
  }

  if (isCodexOAuthReconnectRequiredRunError(errorMessage)) {
    return CODEX_OAUTH_RECONNECT_REQUIRED_MESSAGE;
  }

  return isActionableRunError(errorMessage)
    ? errorMessage
    : CHAT_RUN_TRANSIENT_ERROR_MESSAGE;
}
