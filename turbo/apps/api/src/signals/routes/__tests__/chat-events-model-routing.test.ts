import { randomUUID } from "node:crypto";

import { personalModelProvidersByTypeContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatThreadRoutes } from "../chat-threads";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function signIn(actor: ApiTestUser): void {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId ?? null,
    actor.orgRole,
  );
}

function threads(actor: ApiTestUser) {
  signIn(actor);
  return setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract);
}

async function selectedModel(actor: ApiTestUser, id: string) {
  signIn(actor);
  const response = await accept(
    setupApp({ context, routes: chatThreadRoutes })(
      chatThreadMetadataContract,
    ).get({ headers, params: { id } }),
    [200],
  );
  return response.body.selectedModel;
}

async function threadEvents(actor: ApiTestUser) {
  const response = await accept(
    threads(actor).events({ headers, query: {} }),
    [200],
  );
  return response.body;
}

describe("CHAT-02: model-first routing", () => {
  it("chat-events-model-routing-003 rejects personal model gpt-6-luna without the caller's subscription", async () => {
    const member = createBddApi(context).user({ orgRole: "org:member" });

    const rejected = await accept(
      threads(member).create({
        headers,
        body: { clientThreadId: randomUUID(), model: "gpt-6-luna" },
      }),
      [400],
    );

    expect(rejected.body).toMatchObject({
      error: { message: expect.any(String) },
    });
  });

  it("chat-events-model-routing-008 rejects the retired Fable 5 alias once the Claude subscription is deleted", async () => {
    const member = createBddApi(context).user();
    mockClaudeCodeTokenEndpoint();
    await createRunsApi(context).createPersonalModelProvider(member, {
      type: "claude-code-oauth-token",
      secret: "personal-claude-token",
    });
    const created = await accept(
      threads(member).create({
        headers,
        body: { clientThreadId: randomUUID(), model: "claude-fable-5-1" },
      }),
      [201],
    );
    const threadId = created.body.id;
    const eventsBefore = await threadEvents(member);
    signIn(member);
    await accept(
      setupApp({ context, routes: meModelProvidersDeleteRoutes })(
        personalModelProvidersByTypeContract,
      ).delete({
        headers,
        params: { type: "claude-code-oauth-token" },
      }),
      [204],
    );

    const rejected = await createChatFilesBddApi(context).requestSendEvent(
      member,
      { prompt: "Continue", threadId, model: "claude-fable-5" },
      [400],
    );
    const [eventsAfter, model] = await Promise.all([
      threadEvents(member),
      selectedModel(member, threadId),
    ]);

    expect(rejected.status).toBe(400);
    expect(JSON.stringify(rejected.body)).toContain("Fable 5.1");
    expect(JSON.stringify(rejected.body)).toMatch(/Auto/);
    expect(JSON.stringify(rejected.body)).toMatch(/connect/i);
    expect(eventsAfter).toStrictEqual(eventsBefore);
    expect(model).toBe("claude-fable-5-1");
  });
});
