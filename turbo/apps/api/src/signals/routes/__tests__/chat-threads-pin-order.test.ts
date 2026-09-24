import { randomUUID } from "node:crypto";
import {
  chatThreadMetadataContract,
  chatThreadPinOrderContract,
  chatThreadPinContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { mockChatThreadSnapshotStorage } from "./helpers/chat-thread-snapshot-storage";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { chatThreadPinOrderRoutes } from "../chat-threads-pin-order";
import { chatThreadPinRoutes } from "../chat-threads-pin";
import { testChatThreadSnapshotCompactionContract } from "@okouai/api-contracts/contracts/test-chat-thread-snapshot-compaction";
import { testChatThreadSnapshotCompactionRoutes } from "../test-chat-thread-snapshot-compaction";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";
import { comparePinnedThreads } from "@okouai/core/chat-thread-pin-order";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);

interface ChatThreadFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly actor: ReturnType<typeof bdd.user>;
}

/** Creates an agent and chat thread through the product routes. */
async function seedChatThread(title: string): Promise<ChatThreadFixture> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat thread order agent",
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
    actor,
  };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function okouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly Capability[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 600,
  });
}

function reorderClient() {
  return setupApp({ context, routes: chatThreadPinOrderRoutes })(
    chatThreadPinOrderContract,
  );
}
function pinHeaders(fixture: ChatThreadFixture) {
  createRouteMocks(context).clerk.session(
    fixture.userId,
    fixture.orgId,
    fixture.actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}
function pinClient() {
  return setupApp({ context, routes: chatThreadPinRoutes })(
    chatThreadPinContract,
  );
}
function headers(fixture: ChatThreadFixture) {
  return {
    authorization: `Bearer ${okouToken({ ...fixture, capabilities: ["chat-thread:write", "chat-thread:read"] })}`,
  };
}
function metadataClient() {
  return setupApp({ context, routes: chatThreadGetRoutes })(
    chatThreadMetadataContract,
  );
}

describe("pinned thread ordering", () => {
  it("persists client ranks in events and compacted snapshots without changing pin time", async () => {
    const fixture = await seedChatThread("First");
    const second = await chat.createThread(fixture.actor, {
      agentId: fixture.agentId,
      title: "Second",
    });
    await chat.pinThread(fixture.actor, fixture.threadId);
    await chat.pinThread(fixture.actor, second.id);
    const before = await accept(
      metadataClient().get({
        headers: headers(fixture),
        params: { id: fixture.threadId },
      }),
      [200],
    );
    const eventId = randomUUID();
    await accept(
      reorderClient().reorder({
        headers: headers(fixture),
        params: { id: fixture.threadId },
        body: { pinOrder: "Zy", eventId },
      }),
      [204],
    );
    const after = await accept(
      metadataClient().get({
        headers: headers(fixture),
        params: { id: fixture.threadId },
      }),
      [200],
    );
    expect(after.body).toStrictEqual(before.body);
    const events = await chat.requestThreadEvents(fixture.actor, {}, [200]);
    if (events.status !== 200) {
      throw new Error("Missing events");
    }
    expect(events.body.events).toContainEqual(
      expect.objectContaining({
        id: eventId,
        kind: "sort_touched",
        pinOrder: "Zy",
      }),
    );
    expect(
      replayChatThreadEvents([], events.body.events)
        .filter((thread) => {
          return thread.pinnedAt !== null;
        })
        .sort(comparePinnedThreads)
        .map((thread) => {
          return thread.id;
        }),
    ).toStrictEqual([fixture.threadId, second.id]);
    mockChatThreadSnapshotStorage(context);
    const compact = setupApp({
      context,
      routes: testChatThreadSnapshotCompactionRoutes,
    })(testChatThreadSnapshotCompactionContract);
    await accept(
      compact.compact({
        body: {
          scopes: [{ user_id: fixture.userId, org_id: fixture.orgId }],
        },
      }),
      [200],
    );
    const snapshot = await chat.getThreadSnapshot(fixture.actor);
    const compactedPin = snapshot.chatThreads.find((thread) => {
      return thread.id === fixture.threadId;
    });
    expect(Date.parse(compactedPin?.pinnedAt ?? "")).toBe(
      Date.parse(before.body.pinnedAt ?? ""),
    );
    expect(snapshot.chatThreads).toContainEqual(
      expect.objectContaining({
        id: fixture.threadId,
        pinOrder: "Zy",
      }),
    );
  });

  it("accepts equal client ranks with deterministic id ordering", async () => {
    const fixture = await seedChatThread("First");
    const second = await chat.createThread(fixture.actor, {
      agentId: fixture.agentId,
      title: "Second",
    });
    for (const id of [fixture.threadId, second.id]) {
      await accept(
        pinClient().pin({
          headers: pinHeaders(fixture),
          params: { id },
          query: { pinOrder: "a0", eventId: randomUUID() },
        }),
        [204],
      );
    }
    const events = await chat.requestThreadEvents(fixture.actor, {}, [200]);
    if (events.status !== 200) {
      throw new Error("Missing events");
    }
    const order = replayChatThreadEvents([], events.body.events).sort(
      comparePinnedThreads,
    );
    expect(
      order.map((thread) => {
        return thread.id;
      }),
    ).toStrictEqual([fixture.threadId, second.id].sort().reverse());
  });

  it("does not reorder an unpinned or other-org thread", async () => {
    const fixture = await seedChatThread("Unpinned");
    const missing = await accept(
      reorderClient().reorder({
        headers: headers(fixture),
        params: { id: fixture.threadId },
        body: { pinOrder: "a0", eventId: randomUUID() },
      }),
      [404],
    );
    expect(missing.status).toBe(404);
    await chat.pinThread(fixture.actor, fixture.threadId);
    const orgId = `org_${randomUUID()}`;
    await store.set(
      seedOrgMembership$,
      { orgId, userId: fixture.userId },
      context.signal,
    );
    await accept(
      reorderClient().reorder({
        headers: headers({ ...fixture, orgId }),
        params: { id: fixture.threadId },
        body: { pinOrder: "a0", eventId: randomUUID() },
      }),
      [404],
    );
  });

  it("validates fractional rank keys and requires write capability", async () => {
    const fixture = await seedChatThread("Pinned");
    await chat.pinThread(fixture.actor, fixture.threadId);
    const invalid = await accept(
      reorderClient().reorder({
        headers: headers(fixture),
        params: { id: fixture.threadId },
        body: { pinOrder: "a00", eventId: randomUUID() },
      }),
      [400],
    );
    expect(invalid.status).toBe(400);
    await accept(
      pinClient().pin({
        headers: pinHeaders(fixture),
        params: { id: fixture.threadId },
        query: { pinOrder: "a00" },
      }),
      [400],
    );
    await accept(
      reorderClient().reorder({
        headers: {
          authorization: `Bearer ${okouToken({ ...fixture, capabilities: ["chat-thread:read"] })}`,
        },
        params: { id: fixture.threadId },
        body: { pinOrder: "a0", eventId: randomUUID() },
      }),
      [403],
    );
  });
});
