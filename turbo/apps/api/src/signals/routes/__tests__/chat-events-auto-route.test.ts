import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";

describe("Auto native routing", () => {
  const context = testContext();

  it(
    "chat-events-auto-route-001 claims the OpenRouter preset for a completed initial run and its successor",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const actor = fixture.bdd.user();
      let accepted = captureConnectorExternalState(context);
      let previous: (() => void) | undefined;
      let restoreSetupWebhook: (() => void) | undefined;
      onTestFinished(() => {
        previous?.();
      });

      const owner = publicRunOwner(context, actor, {
        continueAcceptedOperations: true,
        restoreEnvironment: () => {
          previous ??= captureConnectorExternalState(context);
          accepted();
          restoreSetupWebhook?.();
        },
      });
      function runOwned<T>(operation: () => Promise<T>) {
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
      fixture.mockPiObjectStore();

      await Promise.all([
        fixture.api.configureRunnerGroup(),
        runOwned(() => {
          return fixture.api.grantProEntitlement(actor, {
            onExternalStateReady: (restoreWebhook) => {
              restoreSetupWebhook = restoreWebhook;
            },
          });
        }),
      ]);
      restoreSetupWebhook = undefined;

      const completePiRun = async (args: {
        readonly runId: string;
        readonly threadId: string;
        readonly answer: string;
        readonly sandboxHeaders: { readonly authorization: string };
      }) => {
        await fixture.webhooks.requestAgentEvents(
          {
            runId: args.runId,
            events: [
              {
                type: "assistant",
                sequenceNumber: 1,
                message: { content: [{ type: "text", text: args.answer }] },
              },
              { type: "result", sequenceNumber: 2, result: args.answer },
            ],
          },
          args.sandboxHeaders,
          [200],
        );
        await fixture.webhooks.requestAgentComplete(
          {
            runId: args.runId,
            exitCode: 0,
            lastEventSequence: 2,
            completion: {
              cliAgentType: "pi",
              cliAgentSessionId: args.threadId,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
          args.sandboxHeaders,
          [200],
          undefined,
        );
        await flushWaitUntilForTest();
      };

      const firstRun = await runOwned(() => {
        return fixture.sendChatRun(actor, {
          prompt: "Start an Auto thread",
          model: null,
        });
      });
      const firstExecution = await runOwned(async () => {
        const result = await fixture.runExecution(firstRun.runId);
        owner.rememberExecution(firstRun.runId, result.execution.sandboxToken);
        return result;
      });

      expect(firstExecution.execution.cliAgentType).toBe("pi");
      expect(firstExecution.execution.piModelConfig).toMatchObject({
        provider: "openrouter",
        dialect: "openai-completions",
        model: "@preset/okou-1-0",
        catalogModel: "auto",
      });
      expect(firstExecution.execution.modelUsageProvider).toBe(
        "@preset/okou-1-0",
      );

      await runOwned(() => {
        return completePiRun({
          runId: firstRun.runId,
          threadId: firstRun.threadId,
          answer: "Initial Auto response",
          sandboxHeaders: firstExecution.sandboxHeaders,
        });
      });

      const secondRun = await runOwned(() => {
        return fixture.sendChatRun(actor, {
          threadId: firstRun.threadId,
          prompt: "Continue the Auto thread",
        });
      });
      expect(secondRun.runId).not.toBe(firstRun.runId);
      expect(secondRun.threadId).toBe(firstRun.threadId);

      const secondExecution = await runOwned(async () => {
        const result = await fixture.runExecution(secondRun.runId);
        owner.rememberExecution(secondRun.runId, result.execution.sandboxToken);
        return result;
      });

      expect(secondExecution.execution.cliAgentType).toBe("pi");
      expect(secondExecution.execution.piModelConfig).toMatchObject({
        provider: "openrouter",
        dialect: "openai-completions",
        model: "@preset/okou-1-0",
        catalogModel: "auto",
      });
      expect(secondExecution.execution.modelUsageProvider).toBe(
        "@preset/okou-1-0",
      );
      expect(secondExecution.execution.nativeContinuation.sessionId).toBe(
        firstRun.threadId,
      );

      await runOwned(() => {
        return completePiRun({
          runId: secondRun.runId,
          threadId: firstRun.threadId,
          answer: "Successor Auto response",
          sandboxHeaders: secondExecution.sandboxHeaders,
        });
      });

      const [firstReadback, secondReadback] = await Promise.all([
        fixture.api.readRun(actor, firstRun.runId),
        fixture.api.readRun(actor, secondRun.runId),
      ]);

      for (const readback of [firstReadback, secondReadback]) {
        expect(readback.status).toBe("completed");
        expect(readback.source).toMatchObject({
          providerType: "built-in",
          runtimeProviderType: "openrouter-codex",
          model: "auto",
          credentialScope: "org",
        });
        expect(readback.result).toMatchObject({
          framework: "pi",
          frameworkSessionId: firstRun.threadId,
        });
      }
    },
  );
});
