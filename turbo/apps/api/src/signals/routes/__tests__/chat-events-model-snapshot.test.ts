import { personalModelProvidersByTypeContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";

function isHeadObjectForUpload(command: unknown, uploadId: string): boolean {
  if (typeof command !== "object" || command === null) {
    return false;
  }
  const candidate = command as {
    readonly constructor?: { readonly name?: string };
    readonly input?: { readonly Key?: unknown };
  };
  return (
    candidate.constructor?.name === "HeadObjectCommand" &&
    typeof candidate.input?.Key === "string" &&
    candidate.input.Key.includes(uploadId)
  );
}

describe("accepted model source snapshots", () => {
  const context = testContext();

  it(
    "chat-events-model-snapshot-001 keeps the accepted Claude source through disconnection and uses a new source on the next Run",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
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
      mockClaudeCodeTokenEndpoint();

      const [{ providerId: originalProviderId }, upload] = await Promise.all([
        runOwned(() => {
          return fixture.api.createPersonalModelProvider(actor, {
            type: "claude-code-oauth-token",
            secret: "bdd-personal-claude-token",
          });
        }),
        runOwned(() => {
          return fixture.chat.prepareUpload(actor, {
            filename: "notes.txt",
            contentType: "text/plain",
            size: 42,
          });
        }),
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

      const headStarted = createDeferredPromise<void>(context.signal);
      const releaseHead = createDeferredPromise<{
        readonly ContentLength: number;
      }>(context.signal);
      const previousS3Impl = context.mocks.s3.send.getMockImplementation();
      let delayedOnce = false;
      context.mocks.s3.send.mockImplementation((...args: unknown[]) => {
        if (!delayedOnce && isHeadObjectForUpload(args[0], upload.id)) {
          delayedOnce = true;
          headStarted.resolve();
          return releaseHead.promise;
        }
        return previousS3Impl?.(...args) ?? Promise.resolve({});
      });

      const firstSendPromise = runOwned(() => {
        return fixture.sendChatRun(actor, {
          prompt: "Summarize the attached notes",
          model: "claude-fable-5-1",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Summarize the attached notes" },
              {
                type: "file",
                fileId: upload.id,
                filenameSnapshot: "notes.txt",
                contentType: "text/plain",
              },
            ],
          },
        });
      });

      await headStarted.promise;

      const deleteClient = setupApp({
        context,
        routes: meModelProvidersDeleteRoutes,
      })(personalModelProvidersByTypeContract);

      const { providerId: replacementProviderId } = await runOwned(async () => {
        await accept(
          deleteClient.delete({
            headers: fixture.sessionHeaders(actor),
            params: { type: "claude-code-oauth-token" },
          }),
          [204],
        );
        return await fixture.api.createPersonalModelProvider(actor, {
          type: "claude-code-oauth-token",
          secret: "bdd-replacement-claude-token",
        });
      });
      expect(replacementProviderId).not.toBe(originalProviderId);

      releaseHead.resolve({ ContentLength: 42 });

      const firstRun = await firstSendPromise;
      const firstExecution = await runOwned(async () => {
        const result = await fixture.runExecution(firstRun.runId);
        owner.rememberExecution(firstRun.runId, result.execution.sandboxToken);
        return result;
      });

      expect(firstExecution.execution.cliAgentType).toBe("claude-code");
      expect(firstExecution.execution.environment?.ANTHROPIC_MODEL).toBe(
        "claude-fable-5-1",
      );
      expect(firstExecution.execution.secretConnectorMetadataMap).toMatchObject(
        {
          CLAUDE_CODE_OAUTH_TOKEN: {
            sourceType: "model-provider",
            sourceId: originalProviderId,
          },
        },
      );

      const secondRun = await runOwned(() => {
        return fixture.sendChatRun(actor, {
          prompt: "Start another Claude run after replacement",
          model: "claude-fable-5-1",
        });
      });
      const secondExecution = await runOwned(async () => {
        const result = await fixture.runExecution(secondRun.runId);
        owner.rememberExecution(secondRun.runId, result.execution.sandboxToken);
        return result;
      });

      expect(secondExecution.execution.cliAgentType).toBe("claude-code");
      expect(secondExecution.execution.environment?.ANTHROPIC_MODEL).toBe(
        "claude-fable-5-1",
      );
      expect(
        secondExecution.execution.secretConnectorMetadataMap,
      ).toMatchObject({
        CLAUDE_CODE_OAUTH_TOKEN: {
          sourceType: "model-provider",
          sourceId: replacementProviderId,
        },
      });
    },
  );
});
