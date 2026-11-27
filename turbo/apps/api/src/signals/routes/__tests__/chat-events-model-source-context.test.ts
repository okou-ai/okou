import { randomUUID } from "node:crypto";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import {
  chatThreadEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

const app = setupApp({
  context,
  routes: [...chatThreadRoutes, ...chatEventsRoutes],
});
const threadsApi = app(chatThreadsContract);
const threadEventsApi = app(chatThreadEventsContract);
const chatEventsApi = app(chatEventsContract);

function signIn(user: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    user.userId,
    user.orgId,
    user.orgRole ?? "org:admin",
  );
  return headers;
}

describe("chat send authorization, validation and cancellation", () => {
  it("chat-events-model-source-context-002 rejects invalid model settings before resolving unavailable attachments", async () => {
    const member = bdd.user();
    mockClaudeCodeTokenEndpoint();
    await createRunsApi(context).createPersonalModelProvider(member, {
      type: "claude-code-oauth-token",
      secret: `claude-token-${randomUUID()}`,
    });

    const authHeaders = signIn(member);
    const created = await accept(
      threadsApi.create({
        headers: authHeaders,
        body: { title: "Fable thread", model: "claude-fable-5-1" },
      }),
      [201],
    );
    const threadId = created.body.id;

    const eventsBefore = await accept(
      threadEventsApi.rows({
        headers: authHeaders,
        params: { threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );

    const unavailableFileId = randomUUID();
    const rejected = await accept(
      chatEventsApi.send({
        headers: authHeaders,
        body: {
          threadId,
          prompt: "Inspect this file",
          hasTextContent: true,
          clientEventId: randomUUID(),
          runOptions: { reasoningEffort: "xhigh" },
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Inspect this file" },
              {
                type: "file",
                fileId: unavailableFileId,
                filenameSnapshot: "missing.pdf",
                contentType: "application/pdf",
              },
            ],
          },
        },
      }),
      [400],
    );

    expect(rejected.body).toStrictEqual({
      error: {
        code: "BAD_REQUEST",
        message: "Reasoning effort is not supported by the selected model",
      },
    });

    const eventsAfter = await accept(
      threadEventsApi.rows({
        headers: authHeaders,
        params: { threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );
    expect(eventsAfter.body).toStrictEqual(eventsBefore.body);
  });

  it(
    "chat-events-model-source-context-004 rejects an unknown model without changing thread events",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const actor = fixture.bdd.user();
      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();
      mockClaudeCodeTokenEndpoint();
      await Promise.all([
        fixture.api.configureRunnerGroup(),
        bdd.bootstrapLimitedFreeOnboarding(actor),
        fixture.api.createPersonalModelProvider(actor, {
          type: "claude-code-oauth-token",
          secret: `claude-token-${randomUUID()}`,
        }),
      ]);

      const first = await fixture.sendChatRun(actor, {
        prompt: "Initial prompt before cancellation",
        model: "claude-fable-5-1",
      });
      await fixture.api.requestCancelRun(actor, first.runId, [200]);
      await flushWaitUntilForTest();

      const authHeaders = signIn(actor);
      const eventsBefore = await accept(
        threadEventsApi.rows({
          headers: authHeaders,
          params: { threadId: first.threadId },
          query: { sinceSeqId: 0, limit: 50 },
        }),
        [200],
      );
      const rejected = await accept(
        chatEventsApi.send({
          headers: authHeaders,
          body: {
            threadId: first.threadId,
            prompt: "Prompt selecting unknown model",
            hasTextContent: true,
            model: "unknown-model-for-context-004",
            clientEventId: randomUUID(),
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "Prompt selecting unknown model" }],
            },
          },
        }),
        [400],
      );

      expect(rejected.body).toStrictEqual({
        error: {
          code: "BAD_REQUEST",
          message: 'Unknown model "unknown-model-for-context-004"',
        },
      });
      const eventsAfter = await accept(
        threadEventsApi.rows({
          headers: authHeaders,
          params: { threadId: first.threadId },
          query: { sinceSeqId: 0, limit: 50 },
        }),
        [200],
      );
      expect(eventsAfter.body).toStrictEqual(eventsBefore.body);
    },
  );
});
