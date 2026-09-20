import { EVENT } from "@axiomhq/logging";
import { afterEach, expect } from "vitest";

import {
  getApiTestMocks,
  resetApiTestMocks,
} from "../../../../__tests__/mocks";
import {
  logAgentRunFailure,
  type AgentRunFailureLogSnapshot,
} from "../../agent-run-failure-log.service";

interface TestRegistrar {
  (name: string, test: () => void): void;
  each: <T>(
    cases: readonly T[],
  ) => (name: string, test: (value: T) => void) => void;
}

const { axiomLogging } = getApiTestMocks();

afterEach(resetApiTestMocks);

function runSnapshot(
  overrides: Partial<AgentRunFailureLogSnapshot> = {},
): AgentRunFailureLogSnapshot {
  return {
    launchSnapshot: { framework: "pi" },
    modelProvider: "built-in",
    modelProviderCredentialScope: "org",
    selectedModel: "gpt-6-astra",
    modelRuntimeProvider: "openai-api-key",
    modelRuntimeModel: "gpt-6-astra-runtime",
    ...overrides,
  };
}

export function registerAgentRunFailureLogTests(test: TestRegistrar): void {
  test("retains bounded platform route evidence for built-in overload", () => {
    logAgentRunFailure({
      runId: "run-built-in-overload",
      exitCode: 1,
      error: "model request failed",
      failureReason: "provider_overloaded",
      executionOwner: "sandbox",
      run: runSnapshot({ launchSnapshot: { framework: "codex" } }),
    });

    expect(axiomLogging.error).toHaveBeenCalledWith("Run failed", {
      runId: "run-built-in-overload",
      exitCode: 1,
      error: "model request failed",
      failureReason: "provider_overloaded",
      framework: "codex",
      executionOwner: "sandbox",
      modelProvider: "built-in",
      selectedModel: "gpt-6-astra",
      modelCredentialOwner: "platform",
      modelRuntimeProvider: "openai-api-key",
      modelRuntimeModel: "gpt-6-astra-runtime",
      modelFailureCategory: "unknown",
      context: "webhook:complete",
      [EVENT]: { source: "api" },
    });
  });

  test.each([
    {
      framework: "pi" as const,
      provider: "anthropic-api-key",
      scope: "member" as const,
    },
    {
      framework: "claude-code" as const,
      provider: "claude-code-oauth-token",
      scope: "org" as const,
    },
  ])(
    "suppresses an expected caller-owned provider limit for $scope credentials",
    ({ framework, provider, scope }) => {
      logAgentRunFailure({
        runId: `run-${scope}-limit`,
        exitCode: 1,
        failureReason: "provider_rate_limited",
        executionOwner: "sandbox",
        run: runSnapshot({
          launchSnapshot: { framework },
          modelProvider: provider,
          modelProviderCredentialScope: scope,
          modelRuntimeProvider: "stale-runtime-provider",
          modelRuntimeModel: "stale-runtime-model",
        }),
      });

      expect(axiomLogging.debug).not.toHaveBeenCalled();
      expect(axiomLogging.info).not.toHaveBeenCalled();
      expect(axiomLogging.warn).not.toHaveBeenCalled();
      expect(axiomLogging.error).not.toHaveBeenCalled();
    },
  );

  test.each(["pi", "codex", "claude-code"] as const)(
    "applies the same retained platform policy to %s",
    (framework) => {
      logAgentRunFailure({
        runId: `run-${framework}-platform-limit`,
        exitCode: 1,
        failureReason: "provider_rate_limited",
        executionOwner: framework === "pi" ? "api-first" : "sandbox",
        run: runSnapshot({ launchSnapshot: { framework } }),
      });

      expect(axiomLogging.warn).toHaveBeenCalledWith(
        "Run failed",
        expect.objectContaining({
          framework,
          modelCredentialOwner: "platform",
          failureReason: "provider_rate_limited",
        }),
      );
    },
  );

  test("keeps incomplete ownership conservative and omits a non-built-in runtime route", () => {
    logAgentRunFailure({
      runId: "run-unresolved-limit",
      exitCode: 1,
      failureReason: "provider_rate_limited",
      executionOwner: "sandbox",
      run: runSnapshot({
        modelProvider: "anthropic-api-key",
        modelProviderCredentialScope: null,
      }),
    });

    expect(axiomLogging.warn).toHaveBeenCalledWith(
      "Run failed",
      expect.objectContaining({
        modelProvider: "anthropic-api-key",
        modelCredentialOwner: "unresolved",
      }),
    );
    const fields = axiomLogging.warn.mock.calls[0]?.[1];
    expect(fields).not.toHaveProperty("modelRuntimeProvider");
    expect(fields).not.toHaveProperty("modelRuntimeModel");
    expect(fields).not.toHaveProperty("modelProviderCredentialScope");
    expect(fields).not.toHaveProperty("modelProviderId");
    expect(fields).not.toHaveProperty("modelProviderAccountIdentity");
  });

  test("projects only the bounded API-first diagnostic on an unresolved route", () => {
    const transportFailure = {
      phase: "request" as const,
      signalAborted: false,
      errorName: "TypeError" as const,
      causeCode: "ECONNRESET" as const,
    };
    logAgentRunFailure({
      runId: "run-api-first-diagnostic",
      exitCode: 1,
      error: "[PI_API_MODEL_FAILED] Pi API first-turn model request failed",
      failureReason: "provider_server_error",
      executionOwner: "api-first",
      run: runSnapshot({
        launchSnapshot: { framework: "pi" },
        modelProvider: "unrecognized-provider",
        modelProviderCredentialScope: "member",
        selectedModel: null,
      }),
      modelFailureDiagnostic: {
        category: "http_error",
        httpStatus: 503,
        transportFailure,
      },
    });

    expect(axiomLogging.warn).toHaveBeenCalledWith(
      "Run failed",
      expect.objectContaining({
        framework: "pi",
        executionOwner: "api-first",
        modelProvider: "unknown",
        selectedModel: "unknown",
        modelCredentialOwner: "unresolved",
        modelFailureCategory: "http_error",
        modelFailureHttpStatus: 503,
        modelTransportFailure: transportFailure,
      }),
    );
  });
}
