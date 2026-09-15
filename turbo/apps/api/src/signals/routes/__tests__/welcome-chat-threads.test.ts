import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  chatThreadConnectorSelectionContract,
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { welcomeChatThreadsContract } from "@okouai/api-contracts/contracts/welcome-chat-threads";
import { modelProvidersByTypeContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { SUPPORTED_USER_LOCALES } from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { DEFAULT_IMAGE_MODEL } from "@okouai/core/image-model-catalog";
import { DEFAULT_VIDEO_MODEL } from "@okouai/core/video-model-catalog";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { seedLegacyPrivateDefaultAgentFixture } from "../../../test-fixtures/legacy-default-agent";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { welcomeChatThreadRoutes } from "../welcome-chat-threads";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { modelProvidersRoutes } from "../model-providers";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const MODEL = "claude-sonnet-5";

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

async function enable(actor: ApiTestUser, value = true) {
  if (!actor.orgId) {
    throw new Error("Expected a workspace");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    {
      [FeatureSwitchKey.WelcomeThread]: value,
    },
  );
}

async function fixture() {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  await runs.grantProEntitlement(actor, {
    periodEndUnix: Math.floor(now() / 1000) - 90 * 86_400,
  });
  const agentId = await bdd.bootstrapLimitedFreeOnboarding(actor, {
    displayName: "Editable agent name must not replace the public brand",
  });
  await enable(actor);
  return { actor, agentId };
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
  it("requires authentication, an active workspace, and the effective persisted switch", async () => {
    const clientThreadId = randomUUID();
    await accept(
      welcomeClient().create({ headers: {}, body: { clientThreadId } }),
      [401],
    );
    await accept(
      welcomeClient().create({
        headers: headers(bdd.user({ orgId: null })),
        body: { clientThreadId },
      }),
      [401],
    );
    await accept(
      welcomeClient().create({
        headers: headers(bdd.user()),
        body: { clientThreadId },
      }),
      [403],
    );
    const { actor } = await fixture();
    await enable(actor, false);
    await accept(
      welcomeClient().create({
        headers: headers(actor),
        body: { clientThreadId },
      }),
      [403],
    );
    await accept(
      metadataClient().get({
        headers: headers(actor),
        params: { id: clientThreadId },
      }),
      [404],
    );
    await expect(createdEvents(actor, clientThreadId)).resolves.toStrictEqual(
      [],
    );
    await enable(actor);
    expect((await create(actor, clientThreadId)).body.id).toBe(clientThreadId);
  });

  it("requires write capability and current membership for agent credentials", async () => {
    const { actor } = await fixture();
    if (!actor.orgId) {
      throw new Error("Expected a workspace");
    }
    const orgId = actor.orgId;
    const clientThreadId = randomUUID();
    const token = (userId: string, capabilities: Capability[]) => {
      return signSandboxJwtForTests({
        scope: "okou",
        userId,
        orgId,
        runId: randomUUID(),
        capabilities,
        iat: Math.floor(now() / 1000),
        exp: Math.floor(now() / 1000) + 600,
      });
    };
    await accept(
      welcomeClient().create({
        headers: {
          authorization: `Bearer ${token(actor.userId, ["chat-thread:read"])}`,
        },
        body: { clientThreadId },
      }),
      [403],
    );
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });
    await accept(
      welcomeClient().create({
        headers: {
          authorization: `Bearer ${token(`user_${randomUUID()}`, ["chat-thread:write"])}`,
        },
        body: { clientThreadId },
      }),
      [401],
    );
    await expect(createdEvents(actor, clientThreadId)).resolves.toStrictEqual(
      [],
    );
  });

  it("reports an unavailable default agent without provisioning or creating a thread", async () => {
    const actor = bdd.user();
    await enable(actor);
    const clientThreadId = randomUUID();
    const unavailable = await accept(
      welcomeClient().create({
        headers: headers(actor),
        body: { clientThreadId },
      }),
      [409],
    );
    expect(unavailable.body.error.code).toBe("CONFLICT");
    await accept(
      metadataClient().get({
        headers: headers(actor),
        params: { id: clientThreadId },
      }),
      [404],
    );
    await expect(createdEvents(actor, clientThreadId)).resolves.toStrictEqual(
      [],
    );
  });

  it("does not grant access to another member's private default agent", async () => {
    const { actor, agentId } = await fixture();
    // Current agent APIs prevent private defaults. Preserve access-denial
    // coverage for historical data through the explicit legacy fixture.
    await seedLegacyPrivateDefaultAgentFixture(agentId);
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    await enable(member);
    const clientThreadId = randomUUID();
    const rejected = await accept(
      welcomeClient().create({
        headers: headers(member),
        body: { clientThreadId },
      }),
      [409],
    );
    expect(rejected.body.error.code).toBe("CONFLICT");
    await expect(createdEvents(member, clientThreadId)).resolves.toStrictEqual(
      [],
    );
  });

  it("creates a complete ordinary runless welcome with default model/media and connector state", async () => {
    const { actor, agentId } = await fixture();
    await runs.ensureOrgModelProvider(actor);
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
      agentId,
      title: "Welcome to Okou",
      selectedModel: MODEL,
      serviceTier: null,
      selectedVideoModel: DEFAULT_VIDEO_MODEL,
      selectedImageModel: DEFAULT_IMAGE_MODEL,
      cloudBrowserEnabled: false,
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
    expect(rows[0]?.payload?.content).toContain("# Hi, I'm Okou");
    const content = rows[0]?.payload?.content ?? "";
    const sections = [
      "## Here is what I can deliver",
      "### Images",
      "### Presentations",
      "### Videos",
      "### Automation recommendations",
      "## Why teams get more from Okou",
      "## How to work with me as a team",
      "## Talk to me in Slack",
      "[Set up Slack]",
      "[Invite your teammates]",
      "[Read the docs]",
    ];
    let previous = -1;
    for (const section of sections) {
      const index = content.indexOf(section);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    for (const expected of [
      "Qualify inbound leads",
      "Turn meetings into follow-ups",
      "Weekly growth review",
      "**Run the task with me once.**",
      "**Save it as a workflow.**",
      "**Change its visibility to Public.**",
      "**Run it by name.**",
      "Only workspace admins can install",
      "you can attach a file to a direct message",
    ]) {
      expect(content).toContain(expected);
    }
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
    await enable(actor, false);
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
      { agentId, threadId: body.id, prompt: "Tell me about these examples" },
      [201],
    );
    expect(sent.body).toMatchObject({ threadId: body.id });
    expect((await chat.listThreadEventRows(actor, body.id))[0]).toStrictEqual(
      rows[0],
    );
  });

  it("allows an unresolved default model and does not require generation credits", async () => {
    const { actor } = await fixture();
    await runs.ensureOrgModelProvider(actor);
    await accept(
      setupApp({ context, routes: modelProvidersRoutes })(
        modelProvidersByTypeContract,
      ).delete({
        headers: headers(actor),
        params: { type: "anthropic-api-key" },
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
    expect(metadata.body.selectedModel).toBeNull();
    expect((await runs.readBillingStatus(actor)).credits).toBe(0);
    await expect(
      chat.listThreadEventRows(actor, body.id),
    ).resolves.toMatchObject([{ eventType: "output.message", runId: null }]);
  });

  it.each(SUPPORTED_USER_LOCALES)(
    "persists the complete %s copy and deployment-aware links",
    async (locale) => {
      const { actor } = await fixture();
      await bdd.updateUserLocale(actor, locale);
      mockEnv("APP_URL", "https://pr-33252-app.omby.ai");
      const { body } = await create(actor);
      const rows = await chat.listThreadEventRows(actor, body.id);
      const content = rows[0]?.payload?.content;
      expect(content).toBeDefined();
      expect(content).toContain("Okou");
      expect(content).not.toContain("{{");
      expect(content).not.toContain("okou://welcome-diagram");
      expect(content).not.toContain("Editable agent name");
      expect(content).toContain("`campaign-visual.jpg`");
      expect(content).toContain("`sproutpop-launch-deck.html`");
      expect(content).toContain("`product-launch-film.mp4`");
      expect(content).toContain(
        "https://static.vm0.io/vm0/artifact-templates/illustration/assets/bb2f13d1-f849-4a5c-a493-524bc0eda5c2/ref-bookshop-interior.jpg",
      );
      expect(content).toContain(
        "https://static.vm0.io/vm0/artifact-templates/presentation/daf7c2d1-5195-4c09-ad4b-8d85778fc104/playful-launch-presentation.html",
      );
      expect(content).toContain(
        "https://static.vm0.io/vm0/artifact-templates/video/df99de74-8eea-420c-86d1-c104ba5ba6b6/video-df99de74.mp4",
      );
      expect(content?.match(/```mermaid\nflowchart/gu)).toHaveLength(3);
      expect(content).toContain("`/okou`");
      expect(content).toContain("https://pr-33252-app.omby.ai/works");
      expect(content).toContain(
        "https://pr-33252-app.omby.ai/?settings=people",
      );
      expect(content).toContain("https://pr-33252-www.omby.ai/docs");
    },
  );

  it("inherits the member's media and model preference at creation", async () => {
    const { actor } = await fixture();
    await runs.ensureOrgModelProvider(actor);
    await accept(
      setupApp({ context, routes: userModelPreferenceRoutes })(
        userModelPreferenceContract,
      ).update({
        headers: headers(actor),
        body: {
          selectedModel: MODEL,
          serviceTier: null,
          selectedVideoModel: "MiniMax-H3",
          selectedImageModel: "fal-ai/qwen-image",
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
      selectedVideoModel: "MiniMax-H3",
      selectedImageModel: "fal-ai/qwen-image",
    });
  });
});
