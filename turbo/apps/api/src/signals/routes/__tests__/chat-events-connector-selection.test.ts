import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createChatConnectorAccessApi } from "./helpers/chat-connector-access";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";

describe("thread connector selection", () => {
  const context = testContext();

  it(
    "chat-events-connector-selection-001 keeps active Run accounts and uses an allowed replacement for queued input",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const firewall = createFirewallApi(context);
      const connectorAccess = createChatConnectorAccessApi(context);
      const selectionClient = setupApp({
        context,
        routes: chatThreadConnectorSelectionRoutes,
      })(chatThreadConnectorSelectionContract);

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
      mockClaudeCodeTokenEndpoint();

      const openAiDefaultSecret = "sk-openai-default-secret";
      const openAiSelectedSecret = "sk-openai-selected-secret";
      const runtimeInitialSecret = "runtime-initial-secret";
      const runtimeReconnectedSecret = "runtime-reconnected-secret";

      const [openAiDefaultResponse, runtimeResponse] = await Promise.all([
        runOwned(() => {
          return fixture.connectors.requestManualGrant(
            actor,
            "openai",
            "api-token",
            { apiKey: openAiDefaultSecret },
            { statuses: [200] },
          );
        }),
        runOwned(() => {
          return fixture.connectors.requestManualGrant(
            actor,
            "runtime",
            "api-token",
            { apiKey: runtimeInitialSecret },
            { statuses: [200] },
          );
        }),
        fixture.api.configureRunnerGroup(),
        runOwned(() => {
          return fixture.api.grantProEntitlement(actor, {
            onExternalStateReady: (restoreWebhook) => {
              restoreSetupWebhook = restoreWebhook;
            },
          });
        }),
        runOwned(() => {
          return fixture.api.createPersonalModelProvider(actor, {
            type: "claude-code-oauth-token",
            secret: "bdd-personal-claude-token",
          });
        }),
      ]);
      restoreSetupWebhook = undefined;

      if (
        openAiDefaultResponse.status !== 200 ||
        runtimeResponse.status !== 200
      ) {
        throw new Error("Expected default OpenAI and Runtime connections");
      }
      const openAiDefaultId = openAiDefaultResponse.body.connectionId;
      const runtimeAccountId = runtimeResponse.body.connectionId;

      const [, openAiSelectedResponse, thread] = await Promise.all([
        runOwned(() => {
          return fixture.api.updateUserModelPreference(
            actor,
            "claude-fable-5-1",
          );
        }),
        runOwned(() => {
          return fixture.connectors.requestManualGrant(
            actor,
            "openai",
            "api-token",
            { apiKey: openAiSelectedSecret },
            { statuses: [200] },
          );
        }),
        runOwned(() => {
          return fixture.chat.createThread(actor, {
            model: "claude-fable-5-1",
          });
        }),
      ]);
      if (openAiSelectedResponse.status !== 200) {
        throw new Error("Expected secondary OpenAI connection");
      }
      const openAiSelectedId = openAiSelectedResponse.body.connectionId;
      const threadId = thread.id;

      await Promise.all([
        runOwned(() => {
          return accept(
            selectionClient.update({
              headers: fixture.sessionHeaders(actor),
              params: { id: threadId },
              body: {
                target: { kind: "builtin", connectorSlug: "openai" },
                connectionId: openAiSelectedId,
              },
            }),
            [200],
          );
        }),
        runOwned(() => {
          return accept(
            selectionClient.update({
              headers: fixture.sessionHeaders(actor),
              params: { id: threadId },
              body: {
                target: { kind: "builtin", connectorSlug: "runtime" },
                connectionId: runtimeAccountId,
              },
            }),
            [200],
          );
        }),
      ]);

      const initialSelections = await runOwned(() => {
        return accept(
          selectionClient.get({
            headers: fixture.sessionHeaders(actor),
            params: { id: threadId },
          }),
          [200],
        );
      });
      expect(initialSelections.body.selections).toStrictEqual(
        expect.arrayContaining([
          {
            target: { kind: "builtin", connectorSlug: "openai" },
            connectionId: openAiSelectedId,
          },
          {
            target: { kind: "builtin", connectorSlug: "runtime" },
            connectionId: runtimeAccountId,
          },
        ]),
      );

      const firstRun = await runOwned(() => {
        return fixture.sendChatRun(actor, {
          threadId,
          prompt: "First run with selected OpenAI and Runtime accounts",
        });
      });
      const firstExecution = await runOwned(async () => {
        const result = await fixture.runExecution(firstRun.runId);
        owner.rememberExecution(firstRun.runId, result.execution.sandboxToken);
        return result;
      });

      const firstEnv = firstExecution.execution.environment ?? {};
      expect(firstEnv.OPENAI_TOKEN).toBeTruthy();
      expect(firstEnv.RUNTIME_API_KEY).toBeTruthy();
      expect(firstExecution.execution.secretConnectorMetadataMap).toMatchObject(
        {
          OPENAI_TOKEN: {
            sourceType: "connector",
            sourceId: openAiSelectedId,
          },
          RUNTIME_API_KEY: {
            sourceType: "connector",
            sourceId: runtimeAccountId,
          },
        },
      );
      const firstSerialized = JSON.stringify(firstExecution.execution);
      expect(firstSerialized).not.toContain(openAiDefaultSecret);
      expect(firstSerialized).not.toContain(openAiSelectedSecret);
      expect(firstSerialized).not.toContain(runtimeInitialSecret);

      const [firstResolved, queuedInput] = await Promise.all([
        runOwned(() => {
          return firewall.requestFirewallAuth(
            {
              authorization: `Bearer ${firstExecution.execution.firewallToken}`,
            },
            {
              authHeaders: {
                "x-openai": `Bearer ${secretTemplate("OPENAI_TOKEN")}`,
                "x-runtime": `Bearer ${secretTemplate("RUNTIME_API_KEY")}`,
              },
              secretConnectorMap:
                firstExecution.execution.secretConnectorMap ?? undefined,
              secretConnectorMetadataMap:
                firstExecution.execution.secretConnectorMetadataMap ??
                undefined,
            },
            [200],
          );
        }),
        runOwned(() => {
          return fixture.sendWaitingChatInput(actor, {
            threadId,
            prompt: "Queued run using fallback OpenAI and reconnected Runtime",
          });
        }),
      ]);
      if (!("headers" in firstResolved.body)) {
        throw new Error("Expected first firewall auth headers");
      }
      expect(firstResolved.body.headers).toStrictEqual({
        "x-openai": `Bearer ${openAiSelectedSecret}`,
        "x-runtime": `Bearer ${runtimeInitialSecret}`,
      });

      const [disabledOpenAi] = await Promise.all([
        runOwned(() => {
          return connectorAccess.setThreadOverride(
            actor,
            threadId,
            {
              target: { kind: "builtin", connectorSlug: "openai" },
              connectionId: openAiSelectedId,
            },
            false,
          );
        }),
        runOwned(() => {
          return fixture.connectors.requestManualGrant(
            actor,
            "runtime",
            "api-token",
            { apiKey: runtimeReconnectedSecret },
            {
              statuses: [200],
              account: { intent: "reconnect", connectionId: runtimeAccountId },
            },
          );
        }),
      ]);
      expect(disabledOpenAi.currentConnectionId).toBe(openAiDefaultId);

      const [updatedSelections] = await Promise.all([
        runOwned(() => {
          return accept(
            selectionClient.get({
              headers: fixture.sessionHeaders(actor),
              params: { id: threadId },
            }),
            [200],
          );
        }),
        runOwned(() => {
          return fixture.api.requestCancelRun(actor, firstRun.runId, [200]);
        }),
      ]);
      expect(updatedSelections.body.selections).not.toContainEqual({
        target: { kind: "builtin", connectorSlug: "openai" },
        connectionId: openAiSelectedId,
      });
      expect(updatedSelections.body.selections).toStrictEqual(
        expect.arrayContaining([
          {
            target: { kind: "builtin", connectorSlug: "runtime" },
            connectionId: runtimeAccountId,
          },
        ]),
      );

      const secondRun = await runOwned(async () => {
        await fixture.failChatRun(
          firstRun.runId,
          firstExecution.sandboxHeaders,
          "Run cancelled",
        );
        await flushWaitUntilForTest();
        return await queuedInput.launchedRun();
      });
      expect(secondRun.threadId).toBe(threadId);
      expect(secondRun.runId).not.toBe(firstRun.runId);

      const secondExecution = await runOwned(async () => {
        const result = await fixture.runExecution(secondRun.runId);
        owner.rememberExecution(secondRun.runId, result.execution.sandboxToken);
        return result;
      });
      const secondEnv = secondExecution.execution.environment ?? {};
      expect(secondEnv.OPENAI_TOKEN).toBeTruthy();
      expect(secondEnv.RUNTIME_API_KEY).toBeTruthy();
      expect(
        secondExecution.execution.secretConnectorMetadataMap,
      ).toMatchObject({
        OPENAI_TOKEN: {
          sourceType: "connector",
          sourceId: openAiDefaultId,
        },
        RUNTIME_API_KEY: {
          sourceType: "connector",
          sourceId: runtimeAccountId,
        },
      });
      const secondSerialized = JSON.stringify(secondExecution.execution);
      expect(secondSerialized).not.toContain(openAiDefaultSecret);
      expect(secondSerialized).not.toContain(openAiSelectedSecret);
      expect(secondSerialized).not.toContain(runtimeInitialSecret);
      expect(secondSerialized).not.toContain(runtimeReconnectedSecret);

      const secondResolved = await runOwned(() => {
        return firewall.requestFirewallAuth(
          {
            authorization: `Bearer ${secondExecution.execution.firewallToken}`,
          },
          {
            authHeaders: {
              "x-openai": `Bearer ${secretTemplate("OPENAI_TOKEN")}`,
              "x-runtime": `Bearer ${secretTemplate("RUNTIME_API_KEY")}`,
            },
            secretConnectorMap:
              secondExecution.execution.secretConnectorMap ?? undefined,
            secretConnectorMetadataMap:
              secondExecution.execution.secretConnectorMetadataMap ?? undefined,
          },
          [200],
        );
      });
      if (!("headers" in secondResolved.body)) {
        throw new Error("Expected second firewall auth headers");
      }
      expect(secondResolved.body.headers).toStrictEqual({
        "x-openai": `Bearer ${openAiDefaultSecret}`,
        "x-runtime": `Bearer ${runtimeReconnectedSecret}`,
      });
    },
  );
});
