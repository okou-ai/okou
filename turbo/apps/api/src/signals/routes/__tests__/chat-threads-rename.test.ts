import {
  chatThreadMetadataContract,
  chatThreadRenameContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { createStore } from "ccstate";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { chatThreadRenameRoutes } from "../chat-threads-rename";
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
    displayName: "Chat thread rename agent",
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

function renameClient() {
  return setupApp({ context, routes: chatThreadRenameRoutes })(
    chatThreadRenameContract,
  );
}

function metadataClient() {
  return setupApp({ context, routes: chatThreadGetRoutes })(
    chatThreadMetadataContract,
  );
}

describe("POST /api/chat-threads/:id/rename", () => {
  it("renames a thread with an Okou run token carrying chat-thread:write", async () => {
    const fixture = await seedChatThread("Original title");
    const token = await claimedToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
    });

    const response = await accept(
      renameClient().rename({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: { title: "CLI renamed title" },
      }),
      [204],
    );
    expect(response.status).toBe(204);

    const metadataResponse = await accept(
      metadataClient().get({
        headers: {
          authorization: `Bearer ${await claimedToken({ userId: fixture.userId, orgId: fixture.orgId })}`,
        },
        params: { id: fixture.threadId },
      }),
      [200],
    );
    expect(metadataResponse.body).toStrictEqual({
      id: fixture.threadId,
      agentId: fixture.agentId,
      title: "CLI renamed title",
      pinnedAt: null,
      archived: false,
      hidden: false,
      muted: false,
      selectedModel: "auto",
      modelSettings: {},
      serviceTier: null,
      computerUseHostId: null,
      cloudBrowserEnabled: true,
    });
  });

  it("keeps the metadata title aligned with concurrent ordered rename events", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Concurrent renames",
    });
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "Original title",
    });
    const eventIds = [randomUUID(), randomUUID()];
    await Promise.all(
      eventIds.map(async (eventId, index) => {
        await chat.requestRenameThread(
          actor,
          thread.id,
          `Title ${index}`,
          [204],
          eventId,
        );
      }),
    );
    const listed = await accept(
      chat.requestThreadEvents(actor, {}, [200]),
      [200],
    );
    const renames = listed.body.events
      .filter((event) => {
        return event.chatThreadId === thread.id && event.kind === "renamed";
      })
      .sort((left, right) => {
        return left.seqId - right.seqId;
      });
    expect(
      renames
        .map((event) => {
          return event.id;
        })
        .sort(),
    ).toStrictEqual([...eventIds].sort());
    const metadata = await accept(
      chat.requestReadThreadMetadata(actor, thread.id, [200]),
      [200],
    );
    expect(metadata.body.title).toBe(renames.at(-1)?.title);
  });

  it("retains a caller's event identity when the same rename is delivered twice", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Rename delivery identity",
    });
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "Original title",
    });
    const eventId = randomUUID();
    await chat.requestRenameThread(
      actor,
      thread.id,
      "Member title",
      [204],
      eventId,
    );
    await chat.requestRenameThread(
      actor,
      thread.id,
      "Member title",
      [204],
      eventId,
    );
    const listed = await accept(
      chat.requestThreadEvents(actor, {}, [200]),
      [200],
    );
    const renames = listed.body.events.filter((event) => {
      return event.chatThreadId === thread.id && event.kind === "renamed";
    });
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatchObject({ id: eventId, title: "Member title" });
    const metadata = await accept(
      chat.requestReadThreadMetadata(actor, thread.id, [200]),
      [200],
    );
    expect(metadata.body.title).toBe("Member title");
  });

  it("does not rename a same-user thread from another org", async () => {
    const fixture = await seedChatThread("Original title");
    const otherOrgId = `org_${randomUUID()}`;
    await store.set(
      seedOrgMembership$,
      { orgId: otherOrgId, userId: fixture.userId },
      context.signal,
    );

    const response = await accept(
      renameClient().rename({
        headers: {
          authorization: `Bearer ${await claimedToken({ userId: fixture.userId, orgId: otherOrgId })}`,
        },
        params: { id: fixture.threadId },
        body: { title: "Wrong org title" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });

    const metadataResponse = await accept(
      metadataClient().get({
        headers: {
          authorization: `Bearer ${await claimedToken({ userId: fixture.userId, orgId: fixture.orgId })}`,
        },
        params: { id: fixture.threadId },
      }),
      [200],
    );
    expect(metadataResponse.body.title).toBe("Original title");
  });
});
