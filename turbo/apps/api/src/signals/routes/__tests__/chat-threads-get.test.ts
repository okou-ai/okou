import { chatThreadMetadataContract } from "@okouai/api-contracts/contracts/chat-threads";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createClaimedRunCredentials } from "./helpers/claimed-run-credentials";
import { seedOrgMembership$ } from "./helpers/org-membership";

const context = testContext();
const claimedToken = createClaimedRunCredentials(context).okouToken;
const store = createStore();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);

interface ChatThreadFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
}

/** Creates an agent and chat thread through the product routes. */
async function seedChatThread(title: string): Promise<ChatThreadFixture> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat thread metadata agent",
    visibility: "private",
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title,
  });
  if (!actor.orgId) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  await store.set(
    seedOrgMembership$,
    { orgId: actor.orgId, userId: actor.userId },
    context.signal,
  );
  return {
    userId: actor.userId,
    orgId: actor.orgId,
    agentId: agent.agentId,
    threadId: thread.id,
  };
}

function client() {
  return setupApp({ context, routes: chatThreadGetRoutes })(
    chatThreadMetadataContract,
  );
}

describe("GET /api/chat-threads/:id/metadata", () => {
  it("returns thread metadata with an Okou run token carrying chat-thread:read", async () => {
    const fixture = await seedChatThread("Launch plan");
    const token = await claimedToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
    });

    const response = await accept(
      client().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      id: fixture.threadId,
      agentId: fixture.agentId,
      title: "Launch plan",
      selectedModel: "auto",
      modelSettings: {},
      serviceTier: null,
      pinnedAt: null,
      archived: false,
      hidden: false,
      muted: false,
      computerUseHostId: null,
      cloudBrowserEnabled: true,
    });
  });
});
