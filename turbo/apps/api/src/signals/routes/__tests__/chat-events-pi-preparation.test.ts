import { describe, expect, it, onTestFinished } from "vitest";
import { testContext, type TestContext } from "../../../__tests__/test-context";
import { TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { settleIncludingAbort } from "../../utils";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";

async function createClaudeAndPiActor(context: TestContext) {
  const fixture = createChatEventsFixture(context);
  const actor = fixture.bdd.user();
  let accepted = captureConnectorExternalState(context);
  let previous: (() => void) | undefined;
  onTestFinished(() => {
    previous?.();
  });
  const owner = publicRunOwner(context, actor, {
    continueAcceptedOperations: true,
    restoreEnvironment: () => {
      previous ??= captureConnectorExternalState(context);
      accepted();
    },
  });
  function run<T>(operation: () => Promise<T>) {
    return owner.run(() => {
      const pending = settleIncludingAbort(operation);
      accepted = captureConnectorExternalState(context);
      return pending.then((result) => {
        if (!result.ok) {
          throw result.error;
        }
        return result.value;
      });
    });
  }
  fixture.chatCallbacks.acceptChatObjectStorage();
  fixture.api.acceptStorageDownloads();
  fixture.api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  fixture.chatCallbacks.disableVapid();
  mockClaudeCodeTokenEndpoint();
  const runnerGroupPromise = fixture.api.configureRunnerGroup();
  await Promise.all([
    runnerGroupPromise,
    run(() => {
      return fixture.api.grantProEntitlement(actor);
    }),
  ]);
  await Promise.all([
    run(() => {
      return fixture.api.createPersonalModelProvider(actor, {
        type: "claude-code-oauth-token",
        secret: "bdd-personal-claude-token",
      });
    }),
    run(() => {
      return fixture.connectSubscriptionPiModel(actor);
    }),
  ]);
  return {
    actor,
    fixture,
    run,
    sendChatRun: (...parameters: Parameters<typeof fixture.sendChatRun>) => {
      return run(() => {
        return fixture.sendChatRun(...parameters);
      });
    },
    sendWaitingChatInput: (
      ...parameters: Parameters<typeof fixture.sendWaitingChatInput>
    ) => {
      return run(() => {
        return fixture.sendWaitingChatInput(...parameters);
      });
    },
    runExecution: (...parameters: Parameters<typeof fixture.runExecution>) => {
      return run(async () => {
        const execution = await fixture.runExecution(...parameters);
        owner.rememberExecution(
          parameters[0],
          execution.execution.sandboxToken,
        );
        return execution;
      });
    },
  };
}

describe("chat-events-pi-preparation", () => {
  const context = testContext();

  it(
    "chat-events-pi-preparation-001 launches an at-capacity Pi send on a fresh session once a slot frees",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockEnv("CONCURRENT_RUN_LIMIT_CAP", 1);
      const chatActor = await createClaudeAndPiActor(context);
      const { actor, fixture } = chatActor;

      const blocker = await chatActor.sendChatRun(actor, {
        model: "claude-fable-5-1",
        prompt: "Occupy the single workspace run slot",
      });
      const blockerExecution = await chatActor.runExecution(blocker.runId);

      const queuedPrompt = "Launch personal gpt-6-luna once a slot frees";
      const waiting = await chatActor.sendWaitingChatInput(actor, {
        model: "gpt-6-luna",
        prompt: queuedPrompt,
      });

      await chatActor.run(() => {
        return fixture.cancelChatRun(
          actor,
          blocker.runId,
          blockerExecution.sandboxHeaders,
        );
      });

      const launched = await chatActor.run(() => {
        return waiting.launchedRun();
      });
      const { execution } = await chatActor.runExecution(launched.runId);

      expect(launched.threadId).toBe(waiting.threadId);
      expect(execution.prompt).toBe(queuedPrompt);
      expect(execution.cliAgentType).toBe("pi");
      expect(execution.piSessionId).toBe(waiting.threadId);
      expect(execution.piLaunchConfig).toStrictEqual({ schemaVersion: 2 });
      expect(execution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        model: "gpt-6-luna",
      });
    },
  );
});
