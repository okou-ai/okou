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
  async function readExecution(actor: ApiTestUser, runId: string) {
    const owner = owners.get(actorKey(actor));
    if (!owner) {
      throw new Error("Expected an owned indicator Run");
    }
    const execution = await owner.executionInput(runId);
    const token = execution.platformEnvironment?.OKOU_TOKEN;
    if (!token) {
      throw new Error("Expected an issued indicator credential");
    }
    tokens.set(actorKey(actor), token);
    return execution;
  }

  return {
    executionInput: readExecution,
    register(actor: ApiTestUser, owner: ReturnType<typeof publicRunOwner>) {
      owners.set(actorKey(actor), owner);
    },
    token(actor: ApiTestUser) {
      const token = tokens.get(actorKey(actor));
      if (!token) {
        throw new Error("Expected a previously dispatched Run");
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

async function prepareChatRuntime(): Promise<void> {
  await api.configureRunnerGroup();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  chatCallbacks.acceptChatObjectStorage();
  chatCallbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
}

async function prepareEntitledMember(actor: ApiTestUser): Promise<void> {
  await api.grantProEntitlement(actor);
  await api.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });

  const restoreEnvironment = captureConnectorExternalState(context);
  indicatorCredentials.register(
    actor,
    publicRunOwner(context, actor, { restoreEnvironment, clockTime: now }),
  );
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
  readonly prompt: string;
}): Promise<SeededThread> {
  const sent = await chat.sendAndLaunch(args.actor, {
    prompt: args.prompt,
    model: "claude-fable-5-1",
  });
  const executionInput = await indicatorCredentials.executionInput(
    args.actor,
    sent.runId,
  );
  await api.requestCancelRun(args.actor, sent.runId, [200]);
  await createWebhookCallbackApi(context).requestAgentComplete(
    { runId: sent.runId, exitCode: 1, error: "Run cancelled" },
    { authorization: `Bearer ${executionInput.sandboxToken}` },
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
    await prepareChatRuntime();
    const actor = bdd.user();
    await prepareEntitledMember(actor);
    const unread = await createCancelledThread({
      actor,
      prompt: "Unread indicator thread",
    });
    const read = await createCancelledThread({
      actor,
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
    await prepareChatRuntime();
    const owner = bdd.user();
    const peer = bdd.user({ orgId: orgIdOf(owner) });
    const otherOrg = bdd.user({ userId: owner.userId });
    await prepareEntitledMember(owner);
    await prepareEntitledMember(peer);
    await prepareEntitledMember(otherOrg);
    const ownerUnread = await createCancelledThread({
      actor: owner,
      prompt: "Owner unread thread",
    });
    await createCancelledThread({
      actor: peer,
      prompt: "Peer unread thread",
    });
    await createCancelledThread({
      actor: otherOrg,
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
      threads: { [ownerUnread.threadId]: "unread" },
      unreadAt: { [ownerUnread.threadId]: ownerUnread.unreadAt },
    });
  });

  it("reports read-cursor changes through indicators while mark responses carry no unread snapshot", async () => {
    await prepareChatRuntime();
    const actor = bdd.user();
    await prepareEntitledMember(actor);
    const toggled = await createCancelledThread({
      actor,
      prompt: "Toggled read cursor thread",
    });
    const untouched = await createCancelledThread({
      actor,
      prompt: "Untouched unread thread",
    });

    await expect(
      chat.markThreadRead(actor, toggled.threadId),
    ).resolves.toStrictEqual({ lastReadAt: expect.any(String) });
    await expect(chat.listThreadUnreads(actor)).resolves.toStrictEqual([
      untouched,
    ]);

    await expect(
      chat.markThreadUnread(actor, toggled.threadId),
    ).resolves.toStrictEqual({ lastReadAt: null });
    const unreads = await chat.listThreadUnreads(actor);
    expect(unreads).toHaveLength(2);
    expect(unreads).toStrictEqual(expect.arrayContaining([toggled, untouched]));
  });

  it("keeps an archived active thread unread on request until its terminal watermark is acknowledged", async () => {
    await prepareChatRuntime();
    const actor = bdd.user();
    await prepareEntitledMember(actor);
    const rerun = await createCancelledThread({
      actor,
      prompt: "Rerun indicator thread",
    });
    const unread = await createCancelledThread({
      actor,
      prompt: "Still unread indicator thread",
    });
    await chat.sendAndLaunch(actor, {
      threadId: rerun.threadId,
      prompt: "Follow-up active Run",
    });
    await chat.markThreadUnread(actor, rerun.threadId);
    await chat.requestSetThreadArchived(actor, rerun.threadId, true, [204]);
    await seedMembership(actor);

    const headers = {
      authorization: `Bearer ${indicatorCredentials.token(actor)}`,
    };
    const indicators = await accept(
      client().indicators({
        headers,
      }),
      [200],
    );
    expect(indicators.body).toStrictEqual({
      threads: {
        [rerun.threadId]: "active",
        [unread.threadId]: "unread",
      },
      unreadAt: { [unread.threadId]: unread.unreadAt },
    });
    await expect(
      accept(
        client().indicators({
          headers,
          query: { includeActiveUnread: "ignored" },
        }),
        [200],
      ),
    ).resolves.toMatchObject({ body: indicators.body });

    const currentIndicators = async () => {
      const response = await accept(
        client().indicators({
          headers,
          query: { includeActiveUnread: "true" },
        }),
        [200],
      );
      return response.body;
    };
    await expect(currentIndicators()).resolves.toStrictEqual({
      ...indicators.body,
      unreadAt: {
        [unread.threadId]: unread.unreadAt,
        [rerun.threadId]: rerun.unreadAt,
      },
    });

    await expect(
      chat.markThreadRead(actor, rerun.threadId),
    ).resolves.toStrictEqual({
      lastReadAt: rerun.unreadAt,
    });
    await expect(currentIndicators()).resolves.toStrictEqual(indicators.body);

    await chat.markThreadUnread(actor, rerun.threadId);
    await chat.requestSetThreadMuted(actor, rerun.threadId, true, [204]);
    await expect(currentIndicators()).resolves.toStrictEqual(indicators.body);
  });

  it("keeps the 50 most recent active threads independent of unread state", async () => {
    await prepareChatRuntime();
    // Every send must start a Run (runs, not waiting inputs, feed the active
    // indicator), so lift the organization concurrency limit.
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
    const actor = bdd.user();
    await prepareEntitledMember(actor);

    const older = await createCancelledThread({
      actor,
      prompt: "Older unread reply",
    });
    const restarted = await chat.sendAndLaunch(actor, {
      threadId: older.threadId,
      prompt: "Oldest active Run",
    });
    await chat.markThreadUnread(actor, older.threadId);
    await indicatorCredentials.executionInput(actor, restarted.runId);

    const recent: Record<string, string> = {};
    for (let index = 0; index < 50; index += 1) {
      const sent = await chat.sendAndLaunch(actor, {
        prompt: `Later active indicator ${index}`,
      });
      recent[sent.threadId] = "active";
    }
    await seedMembership(actor);

    const headers = {
      authorization: `Bearer ${indicatorCredentials.token(actor)}`,
    };
    const indicators = await accept(client().indicators({ headers }), [200]);
    expect(indicators.body).toStrictEqual({
      threads: recent,
      unreadAt: {},
    });

    const readIndependentIndicators = async () => {
      const response = await accept(
        client().indicators({
          headers,
          query: { includeActiveUnread: "true" },
        }),
        [200],
      );
      return response.body;
    };
    await expect(readIndependentIndicators()).resolves.toStrictEqual({
      threads: { ...recent, [older.threadId]: "unread" },
      unreadAt: { [older.threadId]: older.unreadAt },
    });
    await expect(
      chat.markThreadRead(actor, older.threadId),
    ).resolves.toStrictEqual({ lastReadAt: older.unreadAt });
    await expect(readIndependentIndicators()).resolves.toStrictEqual(
      indicators.body,
    );
  }, 180_000);
});
