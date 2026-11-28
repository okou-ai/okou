import { randomUUID } from "node:crypto";
import { HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { createDeferredPromise } from "../../utils";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicRunOwner } from "./helpers/public-run-owner";

describe("Runner run lookup ownership", () => {
  const context = testContext();

  it(
    "runners-run-lookups-001 scopes active runtime synchronization to its owner without exposing terminal state",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      const owner = bdd.user();
      const foreignMember = bdd.user({
        orgId: owner.orgId,
        orgRole: "org:member",
      });
      const dispatchArrived = createDeferredPromise<string>(context.signal);
      const releaseDispatch = createDeferredPromise<void>(context.signal);
      let dispatchReleased = false;
      const release = () => {
        if (!dispatchReleased) {
          dispatchReleased = true;
          releaseDispatch.resolve();
        }
      };
      onTestFinished(release);

      const runOwner = publicRunOwner(context, owner);
      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();

      const runnerIdentity = {
        runnerId: randomUUID(),
        heartbeatGeneration: 1,
      };
      await fixture.api.configureRunnerGroup({
        runnerIdentity,
        reply: async (envelope) => {
          dispatchArrived.resolve(envelope.executionContext.runId);
          await releaseDispatch.promise;
          return HttpResponse.json({
            ...runnerIdentity,
            runId: envelope.executionContext.runId,
            disposition: "accepted",
          });
        },
      });

      await runOwner.run(async () => {
        await bdd.bootstrapLimitedFreeOnboarding(owner);
        await fixture.api.ensurePersonalSubscriptionModel(owner);
      });

      const ownerCli = await runOwner.run(() => {
        return fixture.api.createCliToken(owner);
      });
      const foreignCli = await runOwner.run(() => {
        return fixture.api.createCliToken(foreignMember);
      });

      const prompt = "Verify runtime synchronization ownership";
      const missingConnectorSlug = "missing-builtin-connector";
      const syncBody = {
        targets: [
          {
            kind: "builtin" as const,
            connectorSlug: missingConnectorSlug,
          },
        ],
      };

      const sent = await runOwner.run(() => {
        return fixture.chat.requestSendEvent(
          owner,
          {
            prompt,
            clientEventId: randomUUID(),
          },
          [201],
        );
      });
      expect(sent.status).toBe(201);

      const runId = await dispatchArrived.promise;

      const foreignBeforeDispatch = await runs.requestSyncConnectorRuntimeAs(
        `Bearer ${foreignCli.token}`,
        runId,
        syncBody,
        [403],
      );
      expect(foreignBeforeDispatch.status).toBe(403);

      release();

      const execution = await runOwner.executionInput(runId);
      const sandboxHeaders = {
        authorization: `Bearer ${execution.sandboxToken}`,
      };
      expect(execution.prompt).toBe(prompt);
      expect(execution.isFirstRun).toBeTruthy();
      expect(execution.cliAgentType).toBe("claude-code");

      const foreignDuringExecution = await runs.requestSyncConnectorRuntimeAs(
        `Bearer ${foreignCli.token}`,
        runId,
        syncBody,
        [403],
      );
      expect(foreignDuringExecution.status).toBe(403);
      if (foreignDuringExecution.status !== 403) {
        throw new Error("Expected 403 for foreign member during execution");
      }
      expect(foreignDuringExecution.body.error.message).toBe(
        "Run does not belong to user",
      );

      const ownerDuringExecution = await runs.requestSyncConnectorRuntimeAs(
        `Bearer ${ownerCli.token}`,
        runId,
        syncBody,
        [200],
      );
      expect(ownerDuringExecution.status).toBe(200);
      if (ownerDuringExecution.status !== 200) {
        throw new Error("Expected 200 for owner during execution");
      }
      expect(ownerDuringExecution.body.results).toStrictEqual([
        {
          target: {
            kind: "builtin",
            connectorSlug: missingConnectorSlug,
          },
          state: "absent",
          reason: "connector-unavailable",
        },
      ]);

      await runOwner.run(() => {
        return fixture.completeChatRunOk(runId, sandboxHeaders, {
          cliAgentType: "claude-code",
        });
      });
      await expect(fixture.api.readRun(owner, runId)).resolves.toMatchObject({
        status: "completed",
      });

      const ownerAfterCompletion = await runs.requestSyncConnectorRuntimeAs(
        `Bearer ${ownerCli.token}`,
        runId,
        syncBody,
        [409],
      );
      expect(ownerAfterCompletion.status).toBe(409);
      if (ownerAfterCompletion.status !== 409) {
        throw new Error("Expected 409 for owner after completion");
      }
      expect(ownerAfterCompletion.body.error.code).toBe("RUN_TERMINAL");

      const foreignAfterCompletion = await runs.requestSyncConnectorRuntimeAs(
        `Bearer ${foreignCli.token}`,
        runId,
        syncBody,
        [404],
      );
      expect(foreignAfterCompletion.status).toBe(404);
    },
  );
});
