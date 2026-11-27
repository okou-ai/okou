import { randomUUID } from "node:crypto";

import { feedContract } from "@okouai/api-contracts/contracts/feed";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { feedRoutes } from "../feed";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { proactiveSuggestionsRoutes } from "../proactive-preferences";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWebhookCallbackApi,
  deliverOrganizationCreated,
} from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

function proactiveApp() {
  return setupApp({
    context,
    routes: [
      ...morningBriefPreferenceRoutes,
      ...proactiveSuggestionsRoutes,
      ...feedRoutes,
    ],
  });
}

function sessionHeaders(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" } as const;
}

async function launchPrimaryRun(actor: ApiTestUser) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const chat = createChatFilesBddApi(context);
  const webhooks = createWebhookCallbackApi(context);
  bdd.acceptStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");

  const [runnerGroup] = await Promise.all([
    runs.configureRunnerGroup(),
    deliverOrganizationCreated(context, actor),
    bdd.updateUserTimezone(actor, "Asia/Shanghai"),
  ]);

  let settled = false;
  let active: { readonly runId: string; readonly sandboxToken: string } | null =
    null;
  onTestFinished(async () => {
    if (settled || !active) {
      return;
    }
    context.mocks.ably.publish.mockResolvedValue(undefined);
    await runs.requestCancelRun(actor, active.runId, [200]);
    await webhooks.requestAgentComplete(
      { runId: active.runId, exitCode: 1, error: "Run cancelled" },
      { authorization: `Bearer ${active.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
  });

  await chat.requestSendEvent(
    actor,
    {
      prompt: "Manage proactive settings",
      clientEventId: randomUUID(),
    },
    [201],
  );
  const execution = await runs.nextReceivedExecution(runnerGroup);
  const token = execution.platformEnvironment?.OKOU_TOKEN;
  if (!token) {
    throw new Error("Expected the primary Run to receive an Okou token");
  }
  active = { runId: execution.runId, sandboxToken: execution.sandboxToken };

  return {
    token,
    async cancel() {
      context.mocks.ably.publish.mockResolvedValue(undefined);
      await runs.requestCancelRun(actor, execution.runId, [200]);
    },
    async acknowledgeCancel() {
      await webhooks.requestAgentComplete(
        { runId: execution.runId, exitCode: 1, error: "Run cancelled" },
        { authorization: `Bearer ${execution.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
      settled = true;
    },
  };
}

describe("Built-in proactive preferences for a primary Run", () => {
  it(
    "pf-114 lets the primary Run control built-in preferences and delivery",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = createBddApi(context).user();
      const run = await launchPrimaryRun(actor);
      const agentHeaders = { authorization: `Bearer ${run.token}` } as const;
      const app = proactiveApp();
      const morningBrief = app(morningBriefPreferenceContract);
      const suggestions = app(proactiveSuggestionsContract);
      const feed = app(feedContract);

      const [initialBrief, initialSuggestions, initialSources] =
        await Promise.all([
          accept(morningBrief.get({ headers: agentHeaders }), [200]),
          accept(suggestions.get({ headers: agentHeaders }), [200]),
          accept(feed.sources({ headers: agentHeaders }), [200]),
        ]);
      expect(initialBrief.body).toStrictEqual({
        status: "paused",
        enabled: false,
        unavailableReason: null,
      });
      expect(initialSuggestions.body).toStrictEqual({
        status: "paused",
        enabled: false,
        unavailableReason: null,
      });
      expect(initialSources.body).toStrictEqual({
        suggestions: true,
        whatsNew: true,
        offers: true,
        systemUpdates: true,
      });

      const [enabledBrief, pausedSuggestions] = await Promise.all([
        accept(
          morningBrief.update({
            headers: agentHeaders,
            body: { enabled: true },
          }),
          [200],
        ),
        accept(
          suggestions.updateWithFeed({
            headers: agentHeaders,
            body: { enabled: false },
          }),
          [200],
        ),
      ]);
      expect(enabledBrief.body).toStrictEqual({
        status: "enabled",
        enabled: true,
        unavailableReason: null,
      });
      expect(pausedSuggestions.body).toStrictEqual({
        status: "paused",
        enabled: false,
        unavailableReason: null,
      });

      const updatedSourcesWhilePaused = await accept(
        feed.updateSources({
          headers: agentHeaders,
          body: { offers: false, whatsNew: false },
        }),
        [200],
      );
      expect(updatedSourcesWhilePaused.body).toStrictEqual({
        suggestions: false,
        whatsNew: false,
        offers: false,
        systemUpdates: true,
      });

      const enabledSuggestions = await accept(
        suggestions.updateWithFeed({
          headers: agentHeaders,
          body: { enabled: true },
        }),
        [200],
      );
      expect(enabledSuggestions.body).toStrictEqual({
        status: "enabled",
        enabled: true,
        unavailableReason: null,
      });

      const webHeaders = sessionHeaders(actor);
      const [webBrief, webSuggestions, webSources] = await Promise.all([
        accept(morningBrief.get({ headers: webHeaders }), [200]),
        accept(suggestions.get({ headers: webHeaders }), [200]),
        accept(feed.sources({ headers: webHeaders }), [200]),
      ]);
      expect(webBrief.body).toStrictEqual({
        status: "enabled",
        enabled: true,
        unavailableReason: null,
      });
      expect(webSuggestions.body).toStrictEqual({
        status: "enabled",
        enabled: true,
        unavailableReason: null,
      });
      expect(webSources.body).toStrictEqual({
        suggestions: true,
        whatsNew: false,
        offers: false,
        systemUpdates: true,
      });

      await run.cancel();

      const [, endedBrief, endedSuggestions, endedSources] = await Promise.all([
        run.acknowledgeCancel(),
        accept(
          morningBrief.update({
            headers: agentHeaders,
            body: { enabled: false },
          }),
          [403],
        ),
        accept(
          suggestions.updateWithFeed({
            headers: agentHeaders,
            body: { enabled: false },
          }),
          [403],
        ),
        accept(
          feed.updateSources({
            headers: agentHeaders,
            body: { offers: true },
          }),
          [403],
        ),
      ]);
      expect(endedBrief.body.error.code).toBe("FORBIDDEN");
      expect(endedSuggestions.body.error.code).toBe("FORBIDDEN");
      expect(endedSources.body.error.code).toBe("FORBIDDEN");
    },
  );
});
