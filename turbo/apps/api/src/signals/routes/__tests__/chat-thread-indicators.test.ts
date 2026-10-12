import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";

import {
  chatThreadsContract,
  type ChatEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { createStore } from "ccstate";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadRoutes } from "../chat-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedOrgMembership$ } from "./helpers/org-membership";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
function createIndicatorCredentials() {
  const owners = new Map<string, ReturnType<typeof publicRunOwner>>();
  const tokens = new Map<string, string>();
  beforeEach(() => {
    owners.clear();
    tokens.clear();
  });
  function actorKey(actor: ApiTestUser) {
    return JSON.stringify([actor.userId, actor.orgId]);
  }
  async function claim(actor: ApiTestUser, runId: string) {
    const owner = owners.get(actorKey(actor));
    if (!owner) {
      throw new Error("Expected an owned indicator Run");
    }
    await api.heartbeatRunner();
    const claim = await owner.claim(runId);
    const token = claim.platformEnvironment?.OKOU_TOKEN;
    if (!token) {
      throw new Error("Expected an issued indicator credential");
    }
    tokens.set(actorKey(actor), token);
    return claim;
  }

  return {
    claim,
    register(actor: ApiTestUser, owner: ReturnType<typeof publicRunOwner>) {
      owners.set(actorKey(actor), owner);
    },
    token(actor: ApiTestUser) {
      const token = tokens.get(actorKey(actor));
      if (!token) {
        throw new Error("Expected a previously claimed Run");
      }
      return token;
    },
  };
}
const indicatorCredentials = createIndicatorCredentials();

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
  await api.ensurePersonalSubscriptionModel(actor);
  await api.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agent = await bdd.createAgent(actor, {
    displayName,
    visibility: "private",
  });
  const restoreEnvironment = captureConnectorExternalState(context);
  indicatorCredentials.register(
    actor,
    publicRunOwner(context, actor, { restoreEnvironment, clockTime: now }),
  );
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
  const sent = await chat.sendAndLaunch(args.actor, {
    agentId: args.agentId,
    prompt: args.prompt,
    model: "claude-fable-5-1",
  });
  const claim = await indicatorCredentials.claim(args.actor, sent.runId);
  await api.requestCancelRun(args.actor, sent.runId, [200]);
  await createWebhookCallbackApi(context).requestAgentComplete(
    { runId: sent.runId, exitCode: 1, error: "Run cancelled" },
    { authorization: `Bearer ${claim.sandboxToken}` },
    [200],
  );
  await flushWaitUntilForTest();

  let finished: ReturnType<typeof terminalEvent>;
  await flushWaitUntilForTest();
  await expect(
    (async () => {
      const page = await chat.listThreadEvents(args.actor, sent.threadId);
      finished = terminalEvent(page.events, sent.runId);
      return finished?.createdAt ?? null;
    })(),
  ).resolves.not.toBeNull();
  if (!finished) {
    throw new Error("Expected the cancelled Run to append a terminal event");
  }
  return { threadId: sent.threadId, unreadAt: finished.createdAt };
}

function client() {
  return setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract);
}

describe("GET /api/indicators", () => {
  it("reports unread timestamps for an Okou token without changing read state", async () => {
    prepareChatRuntime();
    const actor = bdd.user();
    const agentId = await createEntitledAgent(actor, "Unread indicator agent");
    const unread = await createCancelledThread({
      actor,
      agentId,
      prompt: "Unread indicator thread",
    });
    const read = await createCancelledThread({
      actor,
      agentId,
      prompt: "Read indicator thread",
    });
    await chat.markThreadRead(actor, read.threadId);
    await seedMembership(actor);
    const headers = {
      authorization: `Bearer ${indicatorCredentials.token(actor)}`,
    };
    const before = {
      unread: (await chat.readThread(actor, unread.threadId)).lastReadAt,
      read: (await chat.readThread(actor, read.threadId)).lastReadAt,
    };

    const indicators = await accept(client().indicators({ headers }), [200]);
    expect(indicators.body).toStrictEqual({
      agents: { [agentId]: "unread" },
      threads: { [unread.threadId]: "unread" },
      unreadAt: { [unread.threadId]: unread.unreadAt },
    });
    await expect(
      chat.readThread(actor, unread.threadId),
    ).resolves.toMatchObject({ lastReadAt: before.unread });
    await expect(chat.readThread(actor, read.threadId)).resolves.toMatchObject({
      lastReadAt: before.read,
    });
  });

  it("scopes unread indicators to the token user and organization", async () => {
    prepareChatRuntime();
    const owner = bdd.user();
    const peer = bdd.user({ orgId: orgIdOf(owner) });
    const otherOrg = bdd.user({ userId: owner.userId });
    const ownerAgentId = await createEntitledAgent(
      owner,
      "Owner indicator agent",
    );
    const peerAgentId = await createEntitledAgent(peer, "Peer indicator agent");
    const otherOrgAgentId = await createEntitledAgent(
      otherOrg,
      "Other organization indicator agent",
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
      authorization: `Bearer ${indicatorCredentials.token(owner)}`,
    };

    const indicators = await accept(client().indicators({ headers }), [200]);
    expect(indicators.body).toStrictEqual({
      agents: { [ownerAgentId]: "unread" },
      threads: { [ownerUnread.threadId]: "unread" },
      unreadAt: { [ownerUnread.threadId]: ownerUnread.unreadAt },
    });
  });

  it("reports read-cursor changes through indicators while mark responses carry no unread snapshot", async () => {
    prepareChatRuntime();
    const actor = bdd.user();
    const agentId = await createEntitledAgent(actor, "Read cursor agent");
    const toggled = await createCancelledThread({
      actor,
      agentId,
      prompt: "Toggled read cursor thread",
    });
    const untouched = await createCancelledThread({
      actor,
      agentId,
      prompt: "Untouched unread thread",
    });

    await expect(
      chat.markThreadRead(actor, toggled.threadId),
    ).resolves.toStrictEqual({ lastReadAt: expect.any(String) });
    await expect(chat.listThreadUnreads(actor, agentId)).resolves.toStrictEqual(
      [untouched],
    );

    await expect(
      chat.markThreadUnread(actor, toggled.threadId),
    ).resolves.toStrictEqual({ lastReadAt: null });
    const unreads = await chat.listThreadUnreads(actor, agentId);
    expect(unreads).toHaveLength(2);
    expect(unreads).toStrictEqual(expect.arrayContaining([toggled, untouched]));
  });

  it("reports a finished thread with a new active Run as active instead of unread", async () => {
    prepareChatRuntime();
    const actor = bdd.user();
    const agentId = await createEntitledAgent(actor, "Rerun indicator agent");
    const rerun = await createCancelledThread({
      actor,
      agentId,
      prompt: "Rerun indicator thread",
    });
    const unread = await createCancelledThread({
      actor,
      agentId,
      prompt: "Still unread indicator thread",
    });
    await chat.sendAndLaunch(actor, {
      agentId,
      threadId: rerun.threadId,
      prompt: "Follow-up active Run",
    });
    await seedMembership(actor);

    const indicators = await accept(
      client().indicators({
        headers: {
          authorization: `Bearer ${indicatorCredentials.token(actor)}`,
        },
      }),
      [200],
    );
    expect(indicators.body).toStrictEqual({
      agents: { [agentId]: "unread" },
      threads: {
        [rerun.threadId]: "active",
        [unread.threadId]: "unread",
      },
      unreadAt: { [unread.threadId]: unread.unreadAt },
    });
  });

  it("limits active threads after filtering out inaccessible Agents", async () => {
    prepareChatRuntime();
    // Every send must start a Run (runs, not waiting inputs, feed the active
    // indicator), so lift the organization concurrency limit.
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
    const actor = bdd.user();
    const peer = bdd.user({ orgId: orgIdOf(actor) });
    const visibleAgentId = await createEntitledAgent(
      actor,
      "Visible active indicator agent",
    );
    const hiddenAgent = await bdd.createAgent(peer, {
      displayName: "Hidden active indicator agent",
      visibility: "public",
    });
    const visible = await chat.sendAndLaunch(actor, {
      agentId: visibleAgentId,
      prompt: "Visible active indicator",
    });

    await indicatorCredentials.claim(actor, visible.runId);

    for (let index = 0; index < 50; index += 1) {
      await chat.sendAndLaunch(actor, {
        agentId: hiddenAgent.agentId,
        prompt: `Later hidden active indicator ${index}`,
      });
    }
    await bdd.updateAgent(peer, hiddenAgent.agentId, {
      visibility: "private",
    });
    await seedMembership(actor);

    const indicators = await accept(
      client().indicators({
        headers: {
          authorization: `Bearer ${indicatorCredentials.token(actor)}`,
        },
      }),
      [200],
    );
    expect(indicators.body).toStrictEqual({
      agents: { [visibleAgentId]: "active" },
      threads: { [visible.threadId]: "active" },
      unreadAt: {},
    });
  }, 180_000);
});
