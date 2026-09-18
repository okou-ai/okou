import { describe, expect, it } from "vitest";

import {
  CHAT_RUN_CONTENT_POLICY_REJECTED_MESSAGE,
  CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE,
  CHAT_RUN_TRANSIENT_ERROR_MESSAGE,
  CHAT_RUN_USAGE_LIMIT_MESSAGE,
  CHAT_RUN_UNSUPPORTED_MODEL_MESSAGE,
  formatRunErrorForExternalSurface,
  getCodexChatGptAccountUnsupportedModel,
  INSUFFICIENT_CREDITS_ASK_ADMIN_MESSAGE,
  isActionableRunError,
  isAgentExecutionTimeoutRunError,
  isCodexChatGptAccountUnsupportedModelRunError,
  isGenericRunErrorForDisplay,
} from "../errors";

describe("formatRunErrorForExternalSurface", () => {
  it.each([
    ["usage_limit", CHAT_RUN_USAGE_LIMIT_MESSAGE],
    ["unsupported_model", CHAT_RUN_UNSUPPORTED_MODEL_MESSAGE],
  ] as const)(
    "renders actionable %s copy without exposing provider diagnostics",
    (failureReason, expected) => {
      for (const message of [
        "[PI_API_MODEL_FAILED] Pi API first-turn model request failed",
        "private upstream diagnostic",
      ]) {
        expect(
          formatRunErrorForExternalSurface({
            code: "UNKNOWN",
            message,
            failureReason,
          }),
        ).toBe(expected);
      }
    },
  );
  it.each(["anthropic-api-key", "built-in"] as const)(
    "keeps platform credit rejection actionable when the run uses %s",
    (modelProviderType) => {
      expect(
        formatRunErrorForExternalSurface({
          code: "UNKNOWN",
          message: "Insufficient vm0 credits",
          failureReason: "insufficient_credits",
          modelProviderType,
        }),
      ).toBe("insufficient_credits");
    },
  );

  it.each([
    [
      "anthropic-api-key",
      "Your connected model provider account has insufficient balance.",
    ],
    ["built-in", "The current model is unavailable."],
    [null, "The current model is unavailable."],
  ] as const)(
    "presents upstream balance according to persisted provider %s",
    (modelProviderType, expected) => {
      expect(
        formatRunErrorForExternalSurface({
          code: "UNKNOWN",
          message: "Credit balance is too low",
          failureReason: "provider_insufficient_credits",
          modelProviderType,
          framework: "claude-code",
        }),
      ).toBe(expected);
    },
  );

  it("presents built-in balance as unavailable while retaining the provider failure reason", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: "private platform billing detail",
        failureReason: "provider_insufficient_credits",
        modelProviderType: "built-in",
      }),
    ).toBe("The current model is unavailable.");
  });

  it.each([
    "The tool said Credit balance is too low",
    "Credit balance is too low for this example",
    "API Error: 402 Payment required",
  ])("does not turn ambiguous text into a balance decision: %s", (message) => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message,
        modelProviderType: "anthropic-api-key",
        framework: "claude-code",
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
  });

  it("preserves unknown reason precedence over untrusted balance words", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: "Credit balance is too low",
        failureReason: "future_reason",
        framework: "claude-code",
        modelProviderType: "anthropic-api-key",
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
  });
  it("preserves allowlisted run errors like Web chat", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "NO_MODEL_PROVIDER",
        message: "No model provider configured",
      }),
    ).toBe("No model provider configured");
  });

  it("preserves non-guidance allowlisted run errors", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: "Cannot continue session with this provider",
      }),
    ).toBe("Cannot continue session with this provider");
  });

  it.each([
    "Agent execution timed out after 7200 seconds",
    "Agent execution timed out after 1 seconds",
  ])("shows controlled execution timeout errors safely: %s", (error) => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: error,
      }),
    ).toBe(CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE);
    expect(isAgentExecutionTimeoutRunError(error)).toBe(true);
    expect(isActionableRunError(error)).toBe(true);
    expect(isGenericRunErrorForDisplay(error)).toBe(false);
  });

  it("uses the structured timeout reason instead of untrusted error text", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: "Contradictory runner failure",
        failureReason: "execution_timeout",
      }),
    ).toBe(CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE);
  });

  it.each(["claude-code", "codex", null, undefined] as const)(
    "offers manual continuation for the structured output limit with framework %s",
    (framework) => {
      expect(
        formatRunErrorForExternalSurface({
          code: "UNKNOWN",
          message: "private upstream diagnostic",
          failureReason: "output_token_limit",
          framework,
        }),
      ).toBe(
        "The model reached its output limit before finishing. Ask it to continue from where it stopped.",
      );
    },
  );

  it.each([
    undefined,
    "response_connection_lost",
    "context_window_exceeded",
    "future_reason",
  ] as const)(
    "does not infer continuation guidance from output-limit text with reason %s",
    (failureReason) => {
      expect(
        formatRunErrorForExternalSurface({
          code: "UNKNOWN",
          message:
            "stream disconnected before completion: Incomplete response returned, reason: max_output_tokens",
          failureReason,
          framework: "codex",
        }),
      ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    },
  );

  it("replaces a content-policy refusal with non-retry guidance", () => {
    const formatted = formatRunErrorForExternalSurface({
      code: "UNKNOWN",
      message:
        '{"error":{"message":"Content Exists Risk","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}',
      failureReason: "safety_policy_refusal",
      framework: "codex",
    });

    expect(formatted).toBe(CHAT_RUN_CONTENT_POLICY_REJECTED_MESSAGE);
    // The rejection is deterministic, so the copy must not invite a retry and
    // must not echo the raw provider envelope back to the user.
    expect(formatted).not.toContain("try again later");
    expect(formatted).not.toContain("Content Exists Risk");
  });

  it("keeps an unclassified provider envelope on the generic message", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message:
          '{"error":{"message":"Invalid Format","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}',
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
  });

  it("keeps the canonical execution timeout message stable", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE,
      }),
    ).toBe(CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE);
    expect(
      isAgentExecutionTimeoutRunError(CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE),
    ).toBe(true);
  });

  it.each([
    "Agent execution timed out",
    "Agent execution timed out after 0 seconds",
    "Agent execution timed out after 7200 milliseconds",
    "Agent execution timed out after 7200 seconds while finalizing",
    "Sandbox execution timed out after 7200 seconds",
    "Execution: Agent execution timed out after 7200 seconds",
    "execution:  Agent execution timed out after 7200 seconds",
  ])("keeps unrelated execution timeout text generic: %s", (error) => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: error,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isAgentExecutionTimeoutRunError(error)).toBe(false);
    expect(isActionableRunError(error)).toBe(false);
    expect(isGenericRunErrorForDisplay(error)).toBe(true);
  });

  it("appends Add credits link for admins on insufficient credits", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits. Please add credits to continue.",
        insufficientCredits: {
          canManageBilling: true,
          addCreditsUrl:
            "https://app.example.test/?settings=billing&billingView=credits",
        },
      }),
    ).toBe(
      "Insufficient credits. Please add credits to continue.\n\nAdd credits: https://app.example.test/?settings=billing&billingView=credits",
    );
  });

  it("asks non-admins to contact an admin on insufficient credits", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits. Please add credits to continue.",
        insufficientCredits: {
          canManageBilling: false,
          addCreditsUrl:
            "https://app.example.test/?settings=billing&billingView=credits",
        },
      }),
    ).toBe(INSUFFICIENT_CREDITS_ASK_ADMIN_MESSAGE);
  });

  it("appends Compare plans link when the plan cannot buy credits", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits. Please add credits to continue.",
        insufficientCredits: {
          canManageBilling: true,
          comparePlansUrl:
            "https://app.example.test/?settings=billing&billingView=plans",
        },
      }),
    ).toBe(
      "Insufficient credits. Please add credits to continue.\n\nCompare plans: https://app.example.test/?settings=billing&billingView=plans",
    );
  });

  it.each([undefined, "usage_limit"] as const)(
    "shows Codex usage limit errors verbatim with reason %s",
    (failureReason) => {
      const codexUsageLimit =
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 6:17 AM.";
      const formatted = formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: codexUsageLimit,
        failureReason,
      });
      expect(formatted).toBe(codexUsageLimit);
      expect(formatted).not.toContain("switch to another model");
    },
  );

  it.each([undefined, "usage_limit"] as const)(
    "shows Claude session limit errors verbatim with reason %s",
    (failureReason) => {
      const sessionLimit =
        "You've hit your session limit · resets 12:50pm (Asia/Shanghai)";
      expect(
        formatRunErrorForExternalSurface({
          code: "UNKNOWN",
          message: sessionLimit,
          failureReason,
        }),
      ).toBe(sessionLimit);
    },
  );

  it.each([undefined, "usage_limit"] as const)(
    "shows Claude weekly limit errors verbatim with reason %s",
    (failureReason) => {
      const weeklyLimit =
        "You've hit your weekly limit · resets 10am (Asia/Shanghai)";
      expect(
        formatRunErrorForExternalSurface({
          code: "UNKNOWN",
          message: weeklyLimit,
          failureReason,
        }),
      ).toBe(weeklyLimit);
    },
  );

  it("shows Claude Code five-hour rate limit errors verbatim", () => {
    const rateLimit =
      "Claude Code rate limit reached. Your 5-hour limit has been reached; resets 12:50pm (Asia/Shanghai).";
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rateLimit,
      }),
    ).toBe(rateLimit);
    expect(isActionableRunError(rateLimit)).toBe(true);
    expect(isGenericRunErrorForDisplay(rateLimit)).toBe(false);
  });

  it("keeps unrelated rate limit errors generic", () => {
    const unrelatedRateLimit =
      "GitHub API rate limit exceeded while fetching repository context.";
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: unrelatedRateLimit,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(unrelatedRateLimit)).toBe(false);
    expect(isGenericRunErrorForDisplay(unrelatedRateLimit)).toBe(true);
  });

  it("shows Codex model capacity errors verbatim", () => {
    const modelCapacity =
      "Selected model is at capacity. Please try a different model.";
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: modelCapacity,
      }),
    ).toBe(modelCapacity);
    expect(isActionableRunError(modelCapacity)).toBe(true);
    expect(isGenericRunErrorForDisplay(modelCapacity)).toBe(false);
  });

  it("shows friendly Claude overload guidance with the selected model label", () => {
    const rawRunError =
      "API Error: 529 Overloaded. This is a server-side issue, usually temporary - try again in a moment. If it persists, check https://status.claude.com.";

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
        selectedModel: "claude-sonnet-4-6",
      }),
    ).toBe(
      "Claude Sonnet 4.6 is overloaded. Please wait a few minutes and try again, or switch to another model.",
    );
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
        selectedModel: "anthropic/claude-sonnet-5",
      }),
    ).toBe(
      "Claude Sonnet 5 is overloaded. Please wait a few minutes and try again, or switch to another model.",
    );
  });

  it("shows fallback Claude overload guidance when no selected model is available", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message:
          'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"The service is overloaded"}}',
      }),
    ).toBe(
      "Claude Model is overloaded. Please wait a few minutes and try again, or switch to another model.",
    );
  });

  it("shows friendly Claude overload guidance for repeated 529 errors", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message:
          "API Error: Repeated 529 Overloaded errors. The API is at capacity - this is usually temporary.",
        selectedModel: "claude-opus-4-8",
      }),
    ).toBe(
      "Claude Opus 4.8 is overloaded. Please wait a few minutes and try again, or switch to another model.",
    );
  });

  it("keeps unrelated Claude 529 text generic", () => {
    for (const rawRunError of [
      "API Error: 529 upstream failed",
      "API Error: 529 not overloaded",
      "API Error: 529 overloadedness check failed",
      'API Error: 529 {"type":"error","error":{"type":"not_overloaded_error"}}',
      "API Error: 503 Overloaded",
    ]) {
      expect(
        formatRunErrorForExternalSurface({
          code: "UNKNOWN",
          message: rawRunError,
          selectedModel: "claude-sonnet-4-6",
        }),
      ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    }
  });

  it.each([undefined, "unsupported_model"] as const)(
    "shows Codex ChatGPT account model support errors verbatim with reason %s",
    (failureReason) => {
      const unsupportedModel =
        '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.6-sol\' model is not supported when using Codex with a ChatGPT account."}}';
      expect(
        formatRunErrorForExternalSurface({
          code: "UNKNOWN",
          message: unsupportedModel,
          failureReason,
        }),
      ).toBe(unsupportedModel);
      expect(isActionableRunError(unsupportedModel)).toBe(true);
      expect(
        isCodexChatGptAccountUnsupportedModelRunError(unsupportedModel),
      ).toBe(true);
      expect(getCodexChatGptAccountUnsupportedModel(unsupportedModel)).toBe(
        "gpt-5.6-sol",
      );
      expect(isGenericRunErrorForDisplay(unsupportedModel)).toBe(false);
    },
  );

  it("keeps near-miss unsupported-model errors generic", () => {
    const message =
      "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.";
    const nearMisses = [
      message,
      JSON.stringify({
        type: "error",
        status: 401,
        error: { type: "invalid_request_error", message },
      }),
      JSON.stringify({
        type: "error",
        status: 400,
        error: { type: "authentication_error", message },
      }),
      JSON.stringify({
        type: "error",
        status: 400,
        error: {
          type: "invalid_request_error",
          message: "The 'gpt-5.6-sol' model is not supported by this API key.",
        },
      }),
    ];

    for (const nearMiss of nearMisses) {
      expect(isCodexChatGptAccountUnsupportedModelRunError(nearMiss)).toBe(
        false,
      );
      expect(getCodexChatGptAccountUnsupportedModel(nearMiss)).toBeUndefined();
      expect(isActionableRunError(nearMiss)).toBe(false);
      expect(
        formatRunErrorForExternalSurface({
          code: "UNKNOWN",
          message: nearMiss,
        }),
      ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    }
  });

  it("shows Claude Code subscription reconnect guidance for upstream 401s", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message:
          "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        claudeCodeCredentialRecovery: {
          modelProviderType: "claude-code-oauth-token",
          modelProviderCredentialScope: "member",
          canManageOrgModelProviders: false,
          modelProvidersUrl: "https://app.example.test/?settings=model",
        },
      }),
    ).toBe(
      "Claude Code subscription authentication failed. Reconnect Claude Code in Model Providers, then retry.\n\nReconnect Claude Code: https://app.example.test/?settings=model",
    );
  });

  it("shows Anthropic API key update guidance for org admins on Claude Code upstream 401s", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message:
          "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        claudeCodeCredentialRecovery: {
          modelProviderType: "anthropic-api-key",
          modelProviderCredentialScope: "org",
          canManageOrgModelProviders: true,
          modelProvidersUrl: "https://app.example.test/?settings=model",
        },
      }),
    ).toBe(
      "Claude Code could not authenticate with the configured Anthropic API key. Update or replace the API key in Model Providers, then retry.\n\nOpen Model Providers: https://app.example.test/?settings=model",
    );
  });

  it("asks non-admins to contact an admin on Claude Code Anthropic API key upstream 401s", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message:
          "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        claudeCodeCredentialRecovery: {
          modelProviderType: "anthropic-api-key",
          modelProviderCredentialScope: "org",
          canManageOrgModelProviders: false,
          modelProvidersUrl: "https://app.example.test/?settings=model",
        },
      }),
    ).toBe(
      "Claude Code could not authenticate with the configured Anthropic API key. Ask a workspace admin to update or replace the API key.\n\nShare with an admin: https://app.example.test/?settings=model",
    );
  });

  it("keeps upstream 401s generic without Claude Code provider context", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message:
          "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        claudeCodeCredentialRecovery: {
          modelProviderType: "openai-api-key",
          modelProviderCredentialScope: "org",
          canManageOrgModelProviders: true,
          modelProvidersUrl: "https://app.example.test/?settings=model",
        },
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
  });

  it("shows Claude Consumer Terms guidance without provider context", () => {
    const rawRunError =
      "API Error: 400 We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue.";
    const expectedMessage =
      "Claude Code requires acceptance of updated Consumer Terms and Privacy Policy. Sign in to https://claude.ai with the Claude account connected in Model Providers, accept the updated terms and policy, then retry.";

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(expectedMessage);
    expect(isActionableRunError(rawRunError)).toBe(true);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(false);
    expect(isActionableRunError(expectedMessage)).toBe(true);
    expect(isGenericRunErrorForDisplay(expectedMessage)).toBe(false);
  });

  it("appends Model Providers to Claude Consumer Terms guidance", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message:
          "api error: 400 PLEASE ACCEPT the updated PRIVACY POLICY and CONSUMER TERMS at CLAUDE.AI before continuing.",
        claudeCodeCredentialRecovery: {
          modelProviderType: "claude-code-oauth-token",
          modelProviderCredentialScope: "member",
          canManageOrgModelProviders: false,
          modelProvidersUrl: "https://app.example.test/?settings=model",
        },
      }),
    ).toBe(
      "Claude Code requires acceptance of updated Consumer Terms and Privacy Policy. Sign in to https://claude.ai with the Claude account connected in Model Providers, accept the updated terms and policy, then retry.\n\nOpen Model Providers: https://app.example.test/?settings=model",
    );
  });

  it("keeps incomplete Claude Consumer Terms messages generic", () => {
    for (const rawRunError of [
      "We've updated our Consumer Terms and Privacy Policy. Accept them in claude.ai.",
      "API Error: 400 We've updated our Service Terms and Privacy Policy. Accept them in claude.ai.",
      "API Error: 400 We've updated our Consumer Terms. Accept them in claude.ai.",
      "API Error: 400 We've updated our Consumer Terms and Privacy Policy. Review them in claude.ai.",
      "API Error: 400 We've updated our Consumer Terms and Privacy Policy. Accept them to continue.",
      "API Error: 400 request rejected by the provider",
      "API Error: 400-error Consumer Terms and Privacy Policy must be accepted at claude.ai.",
      "API Error: 4000 Consumer Terms and Privacy Policy must be accepted at claude.ai.",
      "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      "API Error: 529 upstream failed",
    ]) {
      expect(
        formatRunErrorForExternalSurface({
          code: "UNKNOWN",
          message: rawRunError,
        }),
      ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
      expect(isActionableRunError(rawRunError)).toBe(false);
      expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
    }
  });

  it("keeps unrelated Claude limit errors generic", () => {
    const unrelatedClaudeLimit =
      "Claude process memory limit reached while preparing the sandbox.";
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: unrelatedClaudeLimit,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(unrelatedClaudeLimit)).toBe(false);
    expect(isGenericRunErrorForDisplay(unrelatedClaudeLimit)).toBe(true);
  });

  it("falls back to the Web generic message for unallowlisted errors", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: "Something failed",
      }),
    ).toBe("Oops, something went wrong. Please try again later.");
  });

  it("shows reconnect guidance for Codex OAuth reconnect-required refresh failures", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: codex-oauth-token. The connector may need to be reconnected.","permission":"model-provider:codex-oauth-token","base":"https://chatgpt.com/backend-api/codex","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses';
    const expectedMessage =
      "ChatGPT session needs reconnection. Reconnect ChatGPT (Codex) in Model Providers, then retry.";

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(expectedMessage);
    expect(isActionableRunError(rawRunError)).toBe(true);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(false);
    expect(isActionableRunError(expectedMessage)).toBe(true);
    expect(isGenericRunErrorForDisplay(expectedMessage)).toBe(false);
  });

  it("ignores braces after the embedded reconnect-required error body", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Refresh failed for {codex} token.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/{response_id}';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(
      "ChatGPT session needs reconnection. Reconnect ChatGPT (Codex) in Model Providers, then retry.",
    );
    expect(isActionableRunError(rawRunError)).toBe(true);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(false);
  });

  it("skips unrelated objects before the reconnect-required error body", () => {
    const rawRunError =
      'request metadata {"traceId":"abc","status":502}: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: codex-oauth-token.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(
      "ChatGPT session needs reconnection. Reconnect ChatGPT (Codex) in Model Providers, then retry.",
    );
    expect(isActionableRunError(rawRunError)).toBe(true);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(false);
  });

  it("skips non-JSON brace templates before the reconnect-required error body", () => {
    const rawRunError =
      'request template {response_id: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: codex-oauth-token.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(
      "ChatGPT session needs reconnection. Reconnect ChatGPT (Codex) in Model Providers, then retry.",
    );
    expect(isActionableRunError(rawRunError)).toBe(true);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(false);
  });

  it("shows reconnect guidance for firewall auth API error envelopes", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":{"message":"Access token expired and refresh failed for: codex-oauth-token.","code":"TOKEN_REFRESH_FAILED","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}}';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(
      "ChatGPT session needs reconnection. Reconnect ChatGPT (Codex) in Model Providers, then retry.",
    );
    expect(isActionableRunError(rawRunError)).toBe(true);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(false);
  });

  it("does not match nested debug objects inside unrelated error bodies", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"SOMETHING_ELSE","debug":{"error":"TOKEN_REFRESH_FAILED","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}}';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });

  it("does not match nested debug objects inside unrelated metadata bodies", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"traceId":"abc","debug":{"error":"TOKEN_REFRESH_FAILED","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}}';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });

  it("does not match nested debug objects inside incomplete JSON-looking bodies", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"traceId":"abc","debug":{"error":"TOKEN_REFRESH_FAILED","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });

  it("keeps upstream Codex token refresh failures generic", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token refresh failed for: codex-oauth-token.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"upstream_provider"}, url: https://chatgpt.com/backend-api/codex/responses';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });

  it("does not show reconnect guidance when upstream provider marker is present", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token refresh failed for: codex-oauth-token after reconnect_required state.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"upstream_provider"}, url: https://chatgpt.com/backend-api/codex/responses';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });

  it("requires reconnect-required to be the failure reason field", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token refresh failed for: codex-oauth-token after reconnect_required state.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"]}, url: https://chatgpt.com/backend-api/codex/responses';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });

  it("requires token refresh failed to be the error code field", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"SOMETHING_ELSE","message":"TOKEN_REFRESH_FAILED for codex-oauth-token.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });

  it("keeps non-Codex token refresh failures generic", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: zendesk.","permission":"connector:zendesk","connectors":["zendesk"],"failureReason":"reconnect_required"}, url: https://example.zendesk.com/api/v2/tickets';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });

  it("keeps mixed connector token refresh failures generic", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: notion, codex-oauth-token. The connector may need to be reconnected.","connectors":["notion","codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });
});
