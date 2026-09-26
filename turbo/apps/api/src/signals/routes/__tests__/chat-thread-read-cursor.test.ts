import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const SETTLED = { interval: 50, timeout: 10_000 } as const;

interface CursorFixture {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly threadId: string;
  readonly orgId: string;
}

function actorOrgId(actor: ApiTestUser): string {
  const { orgId } = actor;
  if (orgId === null) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  return orgId;
}

/**
 * An owned thread whose creation cursor is already set and which carries no
 * terminal Run event. Mark-read on it is an accepted 200 that advances
 * nothing, which is the success a denial must not be confused with.
 */
async function createCursorFixture(): Promise<CursorFixture> {
  const actor = bdd.user();
  const agent = await chat.createAgentForChatThread(actor);
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: `Read cursor ${randomUUID()}`,
  });
  return {
    actor,
    agentId: agent.agentId,
    threadId: thread.id,
    orgId: actorOrgId(actor),
  };
}

function prepareChatRuntime(): void {
  runs.configureRunnerGroup();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  chatCallbacks.acceptChatObjectStorage();
  chatCallbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
}

/**
 * An owned thread carrying one terminal Run event newer than its creation
 * cursor, so an admitted mark-read actually advances the persisted cursor and
 * clears the thread's unread indicator.
 */
async function createUnreadCursorFixture(): Promise<CursorFixture> {
  prepareChatRuntime();
  const actor = bdd.user();
  await runs.grantProEntitlement(actor);
  // The Run must still be active when it is cancelled, so it uses Fable,
  // which model policy keeps queued for the native Runner instead of Pi.
  await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
  const agent = await bdd.createAgent(actor, {
    displayName: `Read cursor unread ${randomUUID().slice(0, 8)}`,
    visibility: "private",
  });
  const sent = await chat.requestSendEvent(
    actor,
    { agentId: agent.agentId, prompt: `read cursor ${randomUUID()}` },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the entitled Chat send to create a Run");
  }
  await runs.requestCancelRun(actor, sent.body.runId, [200]);
  await flushWaitUntilForTest();

  const { threadId } = sent.body;
  await expect
    .poll(async () => {
      return await chat.listUnreadChatThreadIds(actor);
    }, SETTLED)
    .toContain(threadId);
  return { actor, agentId: agent.agentId, threadId, orgId: actorOrgId(actor) };
}

/** The persisted cursor a production thread reader returns. */
async function readCursor(fixture: CursorFixture): Promise<string | null> {
  const detail = await chat.readThread(fixture.actor, fixture.threadId);
  return detail.lastReadAt;
}

/** The thread ids the sidebar currently shows as unread for this owner. */
async function unreadThreadIds(
  fixture: CursorFixture,
): Promise<readonly string[]> {
  return await chat.listUnreadChatThreadIds(fixture.actor);
}

describe("chat thread read cursor", () => {
  it("advances a read to the latest terminal marker and repeats without a second invalidation", async () => {
    const fixture = await createUnreadCursorFixture();
    const before = await readCursor(fixture);
    context.mocks.ably.channelGet.mockClear();
    context.mocks.ably.publish.mockClear();

    const first = await chat.markThreadRead(fixture.actor, fixture.threadId);
    expect(first.lastReadAt).not.toBe(before);
    expect(context.mocks.ably.channelGet.mock.calls).toStrictEqual([
      [`user-org:${fixture.actor.userId}:${fixture.orgId}`],
    ]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "chatThreadReadCursorUpdated",
      {
        threadId: fixture.threadId,
        agentId: fixture.agentId,
        lastReadAt: first.lastReadAt,
      },
    );

    // The repeat advances nothing, so it reports the stored cursor and
    // publishes no second invalidation.
    context.mocks.ably.publish.mockClear();
    const repeated = await chat.markThreadRead(fixture.actor, fixture.threadId);
    expect(repeated.lastReadAt).toBe(first.lastReadAt);
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    await expect(readCursor(fixture)).resolves.toBe(first.lastReadAt);
  });

  it("keeps user-only authorization and publishes to the Agent organization", async () => {
    const fixture = await createCursorFixture();
    const orgless = bdd.user({
      userId: fixture.actor.userId,
      orgId: null,
    });
    const otherOrg = bdd.user({ userId: fixture.actor.userId });

    context.mocks.ably.channelGet.mockClear();
    context.mocks.ably.publish.mockClear();
    await expect(
      chat.markThreadUnread(orgless, fixture.threadId),
    ).resolves.toMatchObject({ lastReadAt: null });
    // No organization is required, and the invalidation still targets the
    // Agent's actual organization rather than the request's active one.
    expect(context.mocks.ably.channelGet.mock.calls).toStrictEqual([
      [`user-org:${fixture.actor.userId}:${fixture.orgId}`],
    ]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "chatThreadReadCursorUpdated",
      {
        threadId: fixture.threadId,
        agentId: fixture.agentId,
        lastReadAt: null,
      },
    );
    await expect(
      chat.markThreadRead(otherOrg, fixture.threadId),
    ).resolves.toMatchObject({ lastReadAt: null });
  });

  it("returns 404 for another user's thread and for a missing thread", async () => {
    const fixture = await createCursorFixture();
    const foreign = bdd.user({ orgId: fixture.orgId });
    context.mocks.ably.publish.mockClear();

    await chat.requestMarkThreadRead(foreign, fixture.threadId, [404]);
    await chat.requestMarkThreadUnread(foreign, fixture.threadId, [404]);
    await chat.requestMarkThreadRead(fixture.actor, randomUUID(), [404]);
    await chat.requestMarkThreadUnread(fixture.actor, randomUUID(), [404]);

    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("clears the cursor on mark-unread and shows the thread as unread again", async () => {
    const fixture = await createUnreadCursorFixture();
    await chat.markThreadRead(fixture.actor, fixture.threadId);
    await expect(unreadThreadIds(fixture)).resolves.not.toContain(
      fixture.threadId,
    );

    await chat.markThreadUnread(fixture.actor, fixture.threadId);

    await expect(readCursor(fixture)).resolves.toBeNull();
    await expect(unreadThreadIds(fixture)).resolves.toContain(fixture.threadId);
  });
});
