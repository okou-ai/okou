import { randomUUID } from "node:crypto";

import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  transferAgentOrganizationFixture,
  transferAgentOwnerFixture,
} from "../../../test-fixtures/account-erasure-subject";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import {
  setChatThreadAgentFixture,
  withChatThreadContentBarrierFixture,
} from "../../../test-fixtures/chat-thread-content-erasure";
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
const BLOCKED = { interval: 10, timeout: 10_000 } as const;
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
  await runs.ensureOrgModelProvider(actor);
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

/** Projects one dormant B1 closure and retires it with the test. */
function closeSubject(
  subject: ErasureSubject,
): Promise<{ readonly jobId: string }> {
  const closing = closeErasureSubjectFixture(subject);
  onTestFinished(async () => {
    const { jobId } = await closing;
    await removeErasureSubjectsFixture([jobId]);
  });
  return closing;
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

/**
 * Both fenced routes denied through their shared 404, with no read-state
 * invalidation escaping to any tab.
 */
async function expectReadCursorWritesDenied(
  fixture: CursorFixture,
): Promise<void> {
  context.mocks.ably.publish.mockClear();
  await chat.requestMarkThreadRead(fixture.actor, fixture.threadId, [404]);
  await chat.requestMarkThreadUnread(fixture.actor, fixture.threadId, [404]);
  expect(context.mocks.ably.publish).not.toHaveBeenCalled();
}

describe("account erasure fences direct chat-thread read-cursor writes", () => {
  it("denies mark-read and mark-unread for a closed thread user and keeps the unread cursor", async () => {
    const fixture = await createUnreadCursorFixture();
    const before = await readCursor(fixture);
    await expect(unreadThreadIds(fixture)).resolves.toContain(fixture.threadId);

    const closed = await closeSubject({
      subjectKind: "user",
      subjectId: fixture.actor.userId,
    });
    await expectReadCursorWritesDenied(fixture);

    await expect(readCursor(fixture)).resolves.toBe(before);
    await expect(unreadThreadIds(fixture)).resolves.toContain(fixture.threadId);

    // The 404 came from the closure, not from an unavailable advance: the same
    // request advances the cursor once the subject is open again.
    await removeErasureSubjectsFixture([closed.jobId]);
    const marked = await chat.markThreadRead(fixture.actor, fixture.threadId);
    expect(marked.lastReadAt).not.toBe(before);
    await expect(readCursor(fixture)).resolves.toBe(marked.lastReadAt);
    await expect(unreadThreadIds(fixture)).resolves.not.toContain(
      fixture.threadId,
    );
  });

  it("advances an admitted read to the latest terminal marker and repeats without a second invalidation", async () => {
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

    // The repeat advances nothing, so it reports the committed cursor the
    // admitted transaction now reads back for itself and publishes no second
    // invalidation.
    context.mocks.ably.publish.mockClear();
    const repeated = await chat.markThreadRead(fixture.actor, fixture.threadId);
    expect(repeated.lastReadAt).toBe(first.lastReadAt);
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    await expect(readCursor(fixture)).resolves.toBe(first.lastReadAt);
  });

  it("denies both read-cursor writes for a closed distinct Agent owner", async () => {
    const fixture = await createCursorFixture();
    const before = await readCursor(fixture);
    const sharedOwner = `user_${randomUUID()}`;
    await transferAgentOwnerFixture({
      agentId: fixture.agentId,
      owner: sharedOwner,
    });
    await closeSubject({ subjectKind: "user", subjectId: sharedOwner });

    await expectReadCursorWritesDenied(fixture);
    await expect(readCursor(fixture)).resolves.toBe(before);
  });

  it("denies both read-cursor writes for a closed Agent organization", async () => {
    const fixture = await createCursorFixture();
    const before = await readCursor(fixture);
    await closeSubject({
      subjectKind: "organization",
      subjectId: fixture.orgId,
    });

    await expectReadCursorWritesDenied(fixture);
    await expect(readCursor(fixture)).resolves.toBe(before);
  });

  it("denies an already-cleared unread and a no-terminal read instead of reporting either accepted no-op", async () => {
    const fixture = await createCursorFixture();
    await expect(
      chat.markThreadUnread(fixture.actor, fixture.threadId),
    ).resolves.toStrictEqual({ lastReadAt: null, unreads: [] });

    const closed = await closeSubject({
      subjectKind: "user",
      subjectId: fixture.actor.userId,
    });
    // Repeating the clear and reading a thread with no terminal event are both
    // accepted 200s while the subject is open, so closure must not be able to
    // masquerade as one of them.
    await expectReadCursorWritesDenied(fixture);
    await expect(readCursor(fixture)).resolves.toBeNull();

    await removeErasureSubjectsFixture([closed.jobId]);
    await expect(
      chat.markThreadRead(fixture.actor, fixture.threadId),
    ).resolves.toStrictEqual({ lastReadAt: null, unreads: [] });
    await expect(
      chat.markThreadUnread(fixture.actor, fixture.threadId),
    ).resolves.toStrictEqual({ lastReadAt: null, unreads: [] });
  });

  it("denies both read-cursor writes on a thread whose Agent reference is cleared", async () => {
    const fixture = await createCursorFixture();
    const before = await readCursor(fixture);
    await setChatThreadAgentFixture({
      chatThreadId: fixture.threadId,
      agentId: null,
    });

    await expectReadCursorWritesDenied(fixture);

    await setChatThreadAgentFixture({
      chatThreadId: fixture.threadId,
      agentId: fixture.agentId,
    });
    await expect(readCursor(fixture)).resolves.toBe(before);
  });

  it("keeps user-only authorization while the Agent organization stays the erasure subject", async () => {
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

    await closeSubject({
      subjectKind: "organization",
      subjectId: fixture.orgId,
    });
    context.mocks.ably.publish.mockClear();
    await chat.requestMarkThreadUnread(orgless, fixture.threadId, [404]);
    await chat.requestMarkThreadRead(otherOrg, fixture.threadId, [404]);
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("keeps an unrelated owner's read-cursor writes working while another subject is closed", async () => {
    const closed = await createCursorFixture();
    const unrelated = await createCursorFixture();
    await closeSubject({ subjectKind: "user", subjectId: closed.actor.userId });

    const before = await readCursor(closed);
    await expectReadCursorWritesDenied(closed);
    await expect(readCursor(closed)).resolves.toBe(before);

    await chat.markThreadUnread(unrelated.actor, unrelated.threadId);
    await expect(readCursor(unrelated)).resolves.toBeNull();
    await expect(
      chat.markThreadRead(unrelated.actor, unrelated.threadId),
    ).resolves.toMatchObject({ lastReadAt: null });
  });

  it("makes a closure wait for an admitted mark-read while an unrelated owner keeps writing", async () => {
    const fixture = await createUnreadCursorFixture();
    const unrelated = await createCursorFixture();
    const before = await readCursor(fixture);

    const closed = await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        work: async (barrier) => {
          const marking = chat.markThreadRead(fixture.actor, fixture.threadId);
          const settings = await barrier.entered;
          expect(settings.lockTimeout).toBe("1s");
          expect(settings.statementTimeout).toBe("5s");

          const closing = closeErasureSubjectFixture({
            subjectKind: "user",
            subjectId: fixture.actor.userId,
          });
          // The admitted mark-read holds its shared subject barrier with the
          // advanced cursor already written, so the exclusive closure cannot
          // commit ahead of it.
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);

          // An unrelated owner is not serialized behind that barrier.
          await chat.markThreadUnread(unrelated.actor, unrelated.threadId);
          await expect(readCursor(unrelated)).resolves.toBeNull();

          barrier.release();
          await marking;
          return await closing;
        },
      },
      context.signal,
    );
    onTestFinished(async () => {
      await removeErasureSubjectsFixture([closed.jobId]);
    });

    const advanced = await readCursor(fixture);
    expect(advanced).not.toBe(before);
    await expect(unreadThreadIds(fixture)).resolves.not.toContain(
      fixture.threadId,
    );

    // The closure landed behind the admitted write, so the next read-cursor
    // request is denied and changes nothing.
    await expectReadCursorWritesDenied(fixture);
    await expect(readCursor(fixture)).resolves.toBe(advanced);
  });

  it("makes a closure wait for an admitted mark-unread and denies the next request", async () => {
    const fixture = await createCursorFixture();

    const closed = await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        work: async (barrier) => {
          const clearing = chat.markThreadUnread(
            fixture.actor,
            fixture.threadId,
          );
          const settings = await barrier.entered;
          expect(settings.lockTimeout).toBe("1s");
          expect(settings.statementTimeout).toBe("5s");

          const closing = closeErasureSubjectFixture({
            subjectKind: "user",
            subjectId: fixture.actor.userId,
          });
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);

          barrier.release();
          await clearing;
          return await closing;
        },
      },
      context.signal,
    );
    onTestFinished(async () => {
      await removeErasureSubjectsFixture([closed.jobId]);
    });

    await expect(readCursor(fixture)).resolves.toBeNull();
    await expectReadCursorWritesDenied(fixture);
    await expect(readCursor(fixture)).resolves.toBeNull();
  });

  it("re-resolves a transferred Agent owner under the locks instead of clearing the cursor", async () => {
    const fixture = await createCursorFixture();
    const before = await readCursor(fixture);
    const newOwner = `user_${randomUUID()}`;
    await closeSubject({ subjectKind: "user", subjectId: newOwner });

    context.mocks.ably.publish.mockClear();
    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "agent-lock",
        work: async (barrier) => {
          const clearing = chat.requestMarkThreadUnread(
            fixture.actor,
            fixture.threadId,
            [404],
          );
          await barrier.entered;
          await transferAgentOwnerFixture({
            agentId: fixture.agentId,
            owner: newOwner,
          });
          barrier.release();
          await clearing;
        },
      },
      context.signal,
    );

    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    await expect(readCursor(fixture)).resolves.toBe(before);
  });

  it("re-resolves a changed Agent organization under the locks and never publishes to the stale one", async () => {
    const fixture = await createCursorFixture();
    const before = await readCursor(fixture);
    const newOrgId = `org_${randomUUID()}`;
    await closeSubject({
      subjectKind: "organization",
      subjectId: newOrgId,
    });

    context.mocks.ably.publish.mockClear();
    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "agent-lock",
        work: async (barrier) => {
          const clearing = chat.requestMarkThreadUnread(
            fixture.actor,
            fixture.threadId,
            [404],
          );
          await barrier.entered;
          await transferAgentOrganizationFixture({
            agentId: fixture.agentId,
            orgId: newOrgId,
          });
          barrier.release();
          await clearing;
        },
      },
      context.signal,
    );

    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    await transferAgentOrganizationFixture({
      agentId: fixture.agentId,
      orgId: fixture.orgId,
    });
    await expect(readCursor(fixture)).resolves.toBe(before);
  });

  it("finds a thread deleted under the locks and restores no read cursor", async () => {
    const fixture = await createCursorFixture();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "agent-lock",
        work: async (barrier) => {
          const clearing = chat.requestMarkThreadUnread(
            fixture.actor,
            fixture.threadId,
            [404],
          );
          await barrier.entered;
          await chat.deleteThread(fixture.actor, fixture.threadId);
          barrier.release();
          await clearing;
        },
      },
      context.signal,
    );

    await chat.requestReadThread(fixture.actor, fixture.threadId, [404]);
    await expect(unreadThreadIds(fixture)).resolves.not.toContain(
      fixture.threadId,
    );
  });

  it("keeps the old cursor readable and unpublished between the mark-read UPDATE and its COMMIT", async () => {
    const fixture = await createUnreadCursorFixture();
    const before = await readCursor(fixture);
    context.mocks.ably.publish.mockClear();

    const marked = await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        work: async (barrier) => {
          const marking = chat.markThreadRead(fixture.actor, fixture.threadId);
          await barrier.entered;

          // Paused with the advancing UPDATE already applied and the whole
          // transaction still open: separate real requests keep reading the old
          // cursor and the unread indicator, and nothing has been published.
          await expect(readCursor(fixture)).resolves.toBe(before);
          await expect(unreadThreadIds(fixture)).resolves.toContain(
            fixture.threadId,
          );
          expect(context.mocks.ably.publish).not.toHaveBeenCalled();

          barrier.release();
          return await marking;
        },
      },
      context.signal,
    );

    expect(marked.lastReadAt).not.toBe(before);
    await expect(readCursor(fixture)).resolves.toBe(marked.lastReadAt);
    await expect(unreadThreadIds(fixture)).resolves.not.toContain(
      fixture.threadId,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "chatThreadReadCursorUpdated",
      {
        threadId: fixture.threadId,
        agentId: fixture.agentId,
        lastReadAt: marked.lastReadAt,
      },
    );
  });

  it("keeps the old cursor readable and unpublished between the mark-unread UPDATE and its COMMIT", async () => {
    const fixture = await createCursorFixture();
    const before = await readCursor(fixture);
    expect(before).not.toBeNull();
    context.mocks.ably.publish.mockClear();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        work: async (barrier) => {
          const clearing = chat.markThreadUnread(
            fixture.actor,
            fixture.threadId,
          );
          await barrier.entered;

          await expect(readCursor(fixture)).resolves.toBe(before);
          expect(context.mocks.ably.publish).not.toHaveBeenCalled();

          barrier.release();
          await clearing;
        },
      },
      context.signal,
    );

    await expect(readCursor(fixture)).resolves.toBeNull();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "chatThreadReadCursorUpdated",
      {
        threadId: fixture.threadId,
        agentId: fixture.agentId,
        lastReadAt: null,
      },
    );
  });

  it("rolls the advanced mark-read cursor back when its operation is cancelled after the UPDATE", async () => {
    const fixture = await createUnreadCursorFixture();
    const before = await readCursor(fixture);
    const controller = new AbortController();
    const cancellable = chat.readCursorWritesWithOperationSignal(
      controller.signal,
    );
    context.mocks.ably.publish.mockClear();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "cursor-update",
        work: async (barrier) => {
          const marking = cancellable.markRead(fixture.actor, fixture.threadId);
          const entered = await barrier.entered;
          // The advancing UPDATE already changed its row, so this is not a
          // pre-write lock timeout, and the old cursor is still what any other
          // caller reads.
          expect(entered.rowCount).toBe(1);
          await expect(readCursor(fixture)).resolves.toBe(before);

          controller.abort(new DOMException("Operation ended", "AbortError"));
          barrier.release();
          await expect(marking).rejects.toThrow(/Unknown response status 500/);
        },
      },
      context.signal,
    );

    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    await expect(readCursor(fixture)).resolves.toBe(before);
    await expect(unreadThreadIds(fixture)).resolves.toContain(fixture.threadId);

    // A rolled back attempt is not a durable denial: the same request advances
    // the cursor once its operation is no longer cancelled.
    const marked = await chat.markThreadRead(fixture.actor, fixture.threadId);
    expect(marked.lastReadAt).not.toBe(before);
    await expect(readCursor(fixture)).resolves.toBe(marked.lastReadAt);
  });

  it("rolls the cleared mark-unread cursor back when its operation is cancelled after the UPDATE", async () => {
    const fixture = await createCursorFixture();
    const before = await readCursor(fixture);
    expect(before).not.toBeNull();
    const controller = new AbortController();
    const cancellable = chat.readCursorWritesWithOperationSignal(
      controller.signal,
    );
    context.mocks.ably.publish.mockClear();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "cursor-update",
        work: async (barrier) => {
          const clearing = cancellable.markUnread(
            fixture.actor,
            fixture.threadId,
          );
          const entered = await barrier.entered;
          expect(entered.rowCount).toBe(1);
          await expect(readCursor(fixture)).resolves.toBe(before);

          controller.abort(new DOMException("Operation ended", "AbortError"));
          barrier.release();
          await expect(clearing).rejects.toThrow(/Unknown response status 500/);
        },
      },
      context.signal,
    );

    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    await expect(readCursor(fixture)).resolves.toBe(before);

    await expect(
      chat.markThreadUnread(fixture.actor, fixture.threadId),
    ).resolves.toMatchObject({ lastReadAt: null });
  });

  it("keeps a committed mark-read cursor when the operation is cancelled after COMMIT, publishing nothing", async () => {
    const fixture = await createUnreadCursorFixture();
    const before = await readCursor(fixture);
    const controller = new AbortController();
    const cancellable = chat.readCursorWritesWithOperationSignal(
      controller.signal,
    );
    context.mocks.ably.publish.mockClear();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        work: async (barrier) => {
          const marking = cancellable.markRead(fixture.actor, fixture.threadId);
          await barrier.entered;
          // Cancelling here is already past the transaction's post-write abort
          // check, so releasing sends a COMMIT that succeeds. This is a race
          // the caller loses, not a rollback.
          controller.abort(new DOMException("Operation ended", "AbortError"));
          barrier.release();
          await expect(marking).rejects.toThrow(/Unknown response status 500/);
        },
      },
      context.signal,
    );

    // Publication runs after the awaited transaction, so the cancelled response
    // carries no invalidation even though the advance is durable.
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    const advanced = await readCursor(fixture);
    expect(advanced).not.toBe(before);
    await expect(unreadThreadIds(fixture)).resolves.not.toContain(
      fixture.threadId,
    );
    await expect(
      chat.markThreadRead(fixture.actor, fixture.threadId),
    ).resolves.toMatchObject({ lastReadAt: advanced });
  });

  it("keeps a committed mark-unread cursor when the operation is cancelled after COMMIT, publishing nothing", async () => {
    const fixture = await createCursorFixture();
    await expect(readCursor(fixture)).resolves.not.toBeNull();
    const controller = new AbortController();
    const cancellable = chat.readCursorWritesWithOperationSignal(
      controller.signal,
    );
    context.mocks.ably.publish.mockClear();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        work: async (barrier) => {
          const clearing = cancellable.markUnread(
            fixture.actor,
            fixture.threadId,
          );
          await barrier.entered;
          controller.abort(new DOMException("Operation ended", "AbortError"));
          barrier.release();
          await expect(clearing).rejects.toThrow(/Unknown response status 500/);
        },
      },
      context.signal,
    );

    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    await expect(readCursor(fixture)).resolves.toBeNull();
  });

  it("propagates a held parent lock as a failure rather than a closure 404", async () => {
    const fixture = await createCursorFixture();
    const before = await readCursor(fixture);

    const holder = await holdChatThreadRowLockFixture({
      threadId: fixture.threadId,
      signal: context.signal,
    });
    context.mocks.ably.publish.mockClear();
    // Neither an accepted 200 nor the closure 404: a real blocked parent lock
    // keeps its own database failure instead of being reported as erasure.
    await expect(
      chat.requestMarkThreadUnread(fixture.actor, fixture.threadId, [200, 404]),
    ).rejects.toThrow(/Unknown response status 500/);
    holder.release();
    await holder.done;

    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    await expect(readCursor(fixture)).resolves.toBe(before);
    await expect(
      chat.markThreadUnread(fixture.actor, fixture.threadId),
    ).resolves.toMatchObject({ lastReadAt: null });
  });
});
