import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import {
  type ChatEvent,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { chatThreadRoutes } from "../chat-threads";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);

interface SeededThread {
  readonly threadId: string;
  readonly unreadAt: string;
}

function orgIdOf(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  return actor.orgId;
}

async function seedMembership(actor: ApiTestUser): Promise<void> {
  await store.set(
    seedOrgMembership$,
    { orgId: orgIdOf(actor), userId: actor.userId },
    context.signal,
  );
}

function prepareChatRuntime(): void {
  api.configureRunnerGroup();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  chatCallbacks.acceptChatObjectStorage();
  chatCallbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
}

async function createEntitledAgent(
  actor: ApiTestUser,
  displayName: string,
): Promise<string> {
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName,
    visibility: "private",
  });
  return agent.agentId;
}

function terminalEvent(
  events: readonly ChatEvent[],
  runId: string,
): Extract<ChatEvent, { readonly eventType: "run.cancelled" }> | undefined {
  return events.find(
    (
      event,
    ): event is Extract<ChatEvent, { readonly eventType: "run.cancelled" }> => {
      return event.runId === runId && event.eventType === "run.cancelled";
    },
  );
}

async function createCancelledThread(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly prompt: string;
}): Promise<SeededThread> {
  const sent = await chat.requestSendEvent(
    args.actor,
    { agentId: args.agentId, prompt: args.prompt },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the entitled Chat send to create a Run");
  }
  await api.requestCancelRun(args.actor, sent.body.runId, [200]);
  await flushWaitUntilForTest();

  let finished: ReturnType<typeof terminalEvent>;
  await expect
    .poll(async () => {
      const page = await chat.listThreadEvents(args.actor, sent.body.threadId);
      finished = terminalEvent(page.events, sent.body.runId ?? "");
      return finished?.createdAt ?? null;
    })
    .not.toBeNull();
  if (!finished) {
    throw new Error("Expected the cancelled Run to append a terminal event");
  }
  return { threadId: sent.body.threadId, unreadAt: finished.createdAt };
}

function okouToken(args: {
  readonly actor: ApiTestUser;
  readonly capabilities: readonly Capability[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.actor.userId,
    orgId: orgIdOf(args.actor),
    runId: randomUUID(),
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 600,
  });
}

function client() {
  return setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract);
}

describe("GET /api/chat-thread-unreads", () => {
  it("lists canonical unread rows for an Okou token without changing read state", async () => {
    prepareChatRuntime();
    const actor = bdd.user();
    const agentId = await createEntitledAgent(actor, "Unread route agent");
    const emptyAgent = await bdd.createAgent(actor, {
      displayName: "Empty unread route agent",
      visibility: "private",
    });
    const unread = await createCancelledThread({
      actor,
      agentId,
      prompt: "Unread route thread",
    });
    const read = await createCancelledThread({
      actor,
      agentId,
      prompt: "Read route thread",
    });
    await chat.markThreadRead(actor, read.threadId);
    await seedMembership(actor);
    const headers = {
      authorization: `Bearer ${okouToken({
        actor,
        capabilities: ["chat-thread:read"],
      })}`,
    };
    const before = {
      unread: (await chat.readThread(actor, unread.threadId)).lastReadAt,
      read: (await chat.readThread(actor, read.threadId)).lastReadAt,
    };

    const indicators = await accept(client().indicators({ headers }), [200]);
    expect(indicators.body.threads[unread.threadId]).toBe("unread");
    expect(indicators.body.unreadAt).toStrictEqual({
      [unread.threadId]: unread.unreadAt,
    });

    await expect(chat.listThreadUnreads(actor, agentId)).resolves.toStrictEqual(
      [unread],
    );
    const first = await accept(
      client().unreads({ headers, query: { agentId } }),
      [200],
    );
    expect(first.body.unreads).toStrictEqual([unread]);
    const repeated = await accept(
      client().unreads({ headers, query: { agentId } }),
      [200],
    );
    expect(repeated.body).toStrictEqual(first.body);
    const empty = await accept(
      client().unreads({
        headers,
        query: { agentId: emptyAgent.agentId },
      }),
      [200],
    );
    expect(empty.body.unreads).toStrictEqual([]);
    await expect(
      chat.readThread(actor, unread.threadId),
    ).resolves.toMatchObject({ lastReadAt: before.unread });
    await expect(chat.readThread(actor, read.threadId)).resolves.toMatchObject({
      lastReadAt: before.read,
    });
  });

  it("returns the standard capability error for an Okou token without chat-thread:read", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Unread capability agent",
      visibility: "private",
    });
    await seedMembership(actor);
    const token = okouToken({ actor, capabilities: ["chat-event:read"] });

    const response = await accept(
      client().unreads({
        headers: { authorization: `Bearer ${token}` },
        query: { agentId: agent.agentId },
      }),
      [403],
    );
    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: chat-thread:read",
        code: "FORBIDDEN",
      },
    });
  });

  it("scopes caller-supplied Agent IDs to the token user and organization", async () => {
    prepareChatRuntime();
    const owner = bdd.user();
    const peer = bdd.user({ orgId: orgIdOf(owner) });
    const otherOrg = bdd.user({ userId: owner.userId });
    const ownerAgentId = await createEntitledAgent(owner, "Unread owner agent");
    const peerAgentId = await createEntitledAgent(peer, "Unread peer agent");
    const otherOrgAgentId = await createEntitledAgent(
      otherOrg,
      "Unread other organization agent",
    );
    const ownerUnread = await createCancelledThread({
      actor: owner,
      agentId: ownerAgentId,
      prompt: "Owner unread thread",
    });
    await createCancelledThread({
      actor: peer,
      agentId: peerAgentId,
      prompt: "Peer unread thread",
    });
    await createCancelledThread({
      actor: otherOrg,
      agentId: otherOrgAgentId,
      prompt: "Other organization unread thread",
    });
    await seedMembership(owner);
    await seedMembership(peer);
    await seedMembership(otherOrg);
    const headers = {
      authorization: `Bearer ${okouToken({
        actor: owner,
        capabilities: ["chat-thread:read"],
      })}`,
    };

    const own = await accept(
      client().unreads({ headers, query: { agentId: ownerAgentId } }),
      [200],
    );
    expect(own.body.unreads).toStrictEqual([ownerUnread]);
    for (const agentId of [peerAgentId, otherOrgAgentId, randomUUID()]) {
      const isolated = await accept(
        client().unreads({ headers, query: { agentId } }),
        [200],
      );
      expect(isolated.body.unreads).toStrictEqual([]);
    }
  });
});
