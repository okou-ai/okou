import {
  chatThreadConnectorSelectionContract,
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { personalModelProvidersByTypeContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { welcomeChatThreadsContract } from "@okouai/api-contracts/contracts/welcome-chat-threads";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { meModelProvidersResetSubscriptionRoutes } from "../me-model-providers-reset-subscription";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { welcomeChatThreadRoutes } from "../welcome-chat-threads";
import { createRunExecutionCredentials } from "./helpers/run-execution-credentials";

import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const personalModelProviderTestRoutes = Object.freeze([
  ...meModelProvidersListRoutes,
  ...meModelProvidersUpsertRoutes,
  ...meModelProvidersDeleteRoutes,
  ...meModelProvidersResetSubscriptionRoutes,
]);

const context = testContext();
const credentials = createRunExecutionCredentials(context);
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const MODEL = "claude-fable-5-1";

function headers(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function welcomeClient() {
  return setupApp({ context, routes: welcomeChatThreadRoutes })(
    welcomeChatThreadsContract,
  );
}

function threadsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract);
}

function metadataClient() {
  return setupApp({ context, routes: chatThreadGetRoutes })(
    chatThreadMetadataContract,
  );
}

async function fixture(
  options: {
    readonly orgId?: string;
  } = {},
) {
  const actor = bdd.user({ orgId: options.orgId });
  await runs.grantProEntitlement(actor, {
    periodEndUnix: Math.floor(now() / 1000) - 90 * 86_400,
  });
  return { actor };
}

async function create(
  actor: ApiTestUser,
  clientThreadId: string = randomUUID(),
) {
  return await accept(
    welcomeClient().create({
      headers: headers(actor),
      body: { clientThreadId },
    }),
    [201],
  );
}

async function createdEvents(actor: ApiTestUser, threadId: string) {
  const result = await accept(
    threadsClient().events({ headers: headers(actor), query: {} }),
    [200],
  );
  return result.body.events.filter((event) => {
    return event.chatThreadId === threadId && event.kind === "created";
  });
}

describe("POST /api/welcome-chat-threads", () => {
  it("requires authentication", async () => {
    const clientThreadId = randomUUID();
    const response = await accept(
      welcomeClient().create({ headers: {}, body: { clientThreadId } }),
      [401],
    );
    expect(response.status).toBe(401);
  });

  it("requires an active workspace", async () => {
    const clientThreadId = randomUUID();
    const response = await accept(
      welcomeClient().create({
        headers: headers(bdd.user({ orgId: null })),
        body: { clientThreadId },
      }),
      [401],
    );
    expect(response.status).toBe(401);
  });

  it("rejects an execution credential after the member leaves the organization", async () => {
    const actor = bdd.user();
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const token = await credentials.okouToken(member);
    await credentials.removeMember(member, actor);
    const clientThreadId = randomUUID();
    await accept(
      welcomeClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: { clientThreadId },
      }),
      [401],
    );
    await expect(createdEvents(actor, clientThreadId)).resolves.toStrictEqual(
      [],
    );
  });

  it("creates a runless personal welcome with the default model and connector state", async () => {
    const { actor } = await fixture();
    await runs.ensurePersonalSubscriptionModel(actor);
    context.mocks.ably.publish.mockRejectedValue(
      new Error("Notification unavailable"),
    );
    const { body } = await create(actor);
    const metadata = await accept(
      metadataClient().get({
        headers: headers(actor),
        params: { id: body.id },
      }),
      [200],
    );
    expect(metadata.body).toMatchObject({
      id: body.id,
      title: "Welcome to Okou",
      selectedModel: MODEL,
      serviceTier: null,
      cloudBrowserEnabled: true,
    });
    const rows = await chat.listThreadEventRows(actor, body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "output.message",
      runId: null,
      seqId: 1,
      contextId: null,
      runEventId: null,
    });
    expect(rows[0]?.payload?.content).toContain("# 👋 Hi, I'm Okou");
    const content = rows[0]?.payload?.content ?? "";
    expect(content).toContain(
      "**Your preferences belong in personal Instructions.**",
    );
    await expect(createdEvents(actor, body.id)).resolves.toHaveLength(1);
    // The only retry a client performs is a new deliberate action with a new
    // id, which creates its own thread.
    const second = await create(actor);
    expect(second.body.id).not.toBe(body.id);
    await expect(
      chat.listThreadEventRows(actor, second.body.id),
    ).resolves.toHaveLength(1);
    const selections = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadConnectorSelectionContract,
      ).get({ headers: headers(actor), params: { id: body.id } }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([]);
    context.mocks.ably.publish.mockResolvedValue(undefined);
    await expect(
      chat.listThreadEventRows(actor, body.id),
    ).resolves.toStrictEqual(rows);
    await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadModelSelectionContract,
      ).update({
        headers: headers(actor),
        params: { id: body.id },
        body: { model: MODEL },
      }),
      [204],
    );
    const sent = await chat.requestSendEvent(
      actor,
      { threadId: body.id, prompt: "Tell me about these examples" },
      [201],
    );
    expect(sent.body).toMatchObject({ threadId: body.id });
    expect((await chat.listThreadEventRows(actor, body.id))[0]).toStrictEqual(
      rows[0],
    );
  });

  it("falls back to the fixed default model and does not require generation credits", async () => {
    const { actor } = await fixture();
    await runs.ensurePersonalSubscriptionModel(actor);
    await accept(
      setupApp({ context, routes: personalModelProviderTestRoutes })(
        personalModelProvidersByTypeContract,
      ).delete({
        headers: headers(actor),
        params: { type: "claude-code-oauth-token" },
      }),
      [204],
    );
    const before = await runs.readBillingStatus(actor);
    expect(before.credits).toBe(0);
    const { body } = await create(actor);
    const metadata = await accept(
      metadataClient().get({
        headers: headers(actor),
        params: { id: body.id },
      }),
      [200],
    );
    expect(metadata.body.selectedModel).toBe("auto");
    expect((await runs.readBillingStatus(actor)).credits).toBe(0);
    await expect(
      chat.listThreadEventRows(actor, body.id),
    ).resolves.toMatchObject([{ eventType: "output.message", runId: null }]);
  });

  it.each([
    "en-US",
    "pt-BR",
    "ja-JP",
    "ko-KR",
    "id-ID",
    "de-DE",
    "es-ES",
    "it-IT",
    "fr-FR",
    "hi-IN",
    "zh-Hans",
    "zh-Hant",
  ] as const)(
    "delivers the My Okou welcome by default in %s without legacy media",
    async (locale) => {
      const { actor } = await fixture();
      await bdd.updateUserLocale(actor, locale);
      mockEnv("APP_URL", "https://pr-33252-app.omby.ai");
      const { body } = await create(actor);
      const rows = await chat.listThreadEventRows(actor, body.id);
      expect(rows).toHaveLength(1);
      const content = rows[0]?.payload?.content ?? "";
      expect(content).toContain("Instructions");
      expect(content).toContain("Workflow");
      expect(content).toContain(
        "https://pr-33252-app.omby.ai/?settings=my-okou&focus=instructions)",
      );
      expect(content).toContain(
        "https://pr-33252-app.omby.ai/?settings=people",
      );
      expect(content).toContain(
        "https://pr-33252-www.omby.ai/en/workflow-automation-examples",
      );
      expect(content).not.toContain("{{");
      expect(content).toContain(
        "https://my-okou-quickstart-20261112-review.okou.app",
      );
      for (const filename of [
        "my-okou-instructions-8ec43cd079ea.png",
        "my-okou-workflow-instructions-5f1222f7d3ea.png",
        "my-okou-workflow-settings-5c32a5d6a9c6.png",
      ]) {
        expect(content).toContain(
          `https://my-okou-quickstart-20261112-review.okou.app/assets/${filename}`,
        );
      }
      expect(content).not.toContain("new-agent.png");
      expect(content).not.toContain("https://4nnp6iwpss.okou.app");
    },
  );

  it("inherits the member's chat model at creation", async () => {
    const { actor } = await fixture();
    await runs.ensurePersonalSubscriptionModel(actor);
    await accept(
      setupApp({ context, routes: userModelPreferenceRoutes })(
        userModelPreferenceContract,
      ).update({
        headers: headers(actor),
        body: {
          selectedModel: MODEL,
          serviceTier: null,
        },
      }),
      [200],
    );
    const { body } = await create(actor);
    const metadata = await accept(
      metadataClient().get({
        headers: headers(actor),
        params: { id: body.id },
      }),
      [200],
    );
    expect(metadata.body).toMatchObject({
      selectedModel: MODEL,
    });
  });
});
