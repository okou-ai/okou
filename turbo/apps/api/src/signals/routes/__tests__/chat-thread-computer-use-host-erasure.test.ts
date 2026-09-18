import { randomUUID } from "node:crypto";

import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  transferAgentOwnerFixture,
} from "../../../test-fixtures/account-erasure-subject";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import {
  holdChatThreadEventIdFixture,
  readStoredChatThreadMetadataFixture,
  setChatThreadAgentFixture,
  withChatThreadContentBarrierFixture,
} from "../../../test-fixtures/chat-thread-content-erasure";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const cu = createComputerUseBddApi(context);
const BLOCKED = { interval: 10, timeout: 10_000 } as const;

interface HostSelectionFixture {
  readonly actor: ReturnType<typeof bdd.user>;
  readonly agentId: string;
  readonly threadId: string;
  readonly orgId: string;
  readonly hostId: string;
}

async function createHostSelectionFixture(): Promise<HostSelectionFixture> {
  const actor = bdd.user();
  const agent = await chat.createAgentForChatThread(actor);
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: `Computer Use ${randomUUID()}`,
  });
  const { orgId } = actor;
  if (orgId === null) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  const host = await cu.startComputerUseHost(actor);
  return {
    actor,
    agentId: agent.agentId,
    threadId: thread.id,
    orgId,
    hostId: host.hostId,
  };
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

interface SidebarHostEvent {
  readonly seqId: number;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean | null;
}

/** The thread's own durable selection events, as a sidebar client reads them. */
async function sidebarHostEvents(
  fixture: HostSelectionFixture,
): Promise<readonly SidebarHostEvent[]> {
  const response = await chat.requestThreadEvents(fixture.actor, {}, [200]);
  if (!("events" in response.body)) {
    throw new Error("Expected the sidebar event page");
  }
  return response.body.events
    .filter((event) => {
      return (
        event.kind === "computer_use_host_updated" &&
        event.chatThreadId === fixture.threadId
      );
    })
    .map((event) => {
      // An absent key and a null flag both mean "no projected flag".
      return {
        seqId: event.seqId,
        computerUseHostId: event.computerUseHostId,
        cloudBrowserEnabled: event.cloudBrowserEnabled ?? null,
      };
    });
}

async function lastHostSeqId(fixture: HostSelectionFixture): Promise<number> {
  const events = await sidebarHostEvents(fixture);
  const seqId = events.at(-1)?.seqId;
  if (seqId === undefined) {
    throw new Error("Expected at least one durable selection event");
  }
  return seqId;
}

/** The persisted selection a production metadata reader returns. */
async function readSelection(fixture: HostSelectionFixture): Promise<{
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
}> {
  const metadata = await chat.readThreadMetadata(
    fixture.actor,
    fixture.threadId,
  );
  return {
    computerUseHostId: metadata.computerUseHostId,
    cloudBrowserEnabled: metadata.cloudBrowserEnabled,
  };
}

async function readClosedSelection(fixture: HostSelectionFixture): Promise<{
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
}> {
  const response = await chat.requestReadThreadMetadata(
    fixture.actor,
    fixture.threadId,
    [404],
  );
  expect(response.status).toBe(404);
  const metadata = await readStoredChatThreadMetadataFixture(fixture.threadId);
  return {
    computerUseHostId: metadata.computerUseHostId,
    cloudBrowserEnabled: metadata.cloudBrowserEnabled,
  };
}

/** The `threadListChanged` invalidations this request published, counted from
 * a cleared mock so an earlier setup write is never attributed to it. */
function countThreadListInvalidations(): number {
  return context.mocks.ably.publish.mock.calls.filter((call) => {
    return call[0] === "threadListChanged";
  }).length;
}

async function observedInvalidations(
  request: () => Promise<unknown>,
): Promise<number> {
  context.mocks.ably.publish.mockClear();
  await request();
  await flushWaitUntilForTest();
  return countThreadListInvalidations();
}

/** Every write shape this route accepts, so one closed subject is exercised
 * against binding, rebinding, clearing and both cloud-browser transitions. */
async function requestEveryDeniedSelection(
  fixture: HostSelectionFixture,
  otherHostId: string,
): Promise<void> {
  await chat.requestUpdateThreadComputerUseHost(
    fixture.actor,
    fixture.threadId,
    otherHostId,
    [404],
    { eventId: randomUUID() },
  );
  await chat.requestUpdateThreadComputerUseHost(
    fixture.actor,
    fixture.threadId,
    null,
    [404],
    { eventId: randomUUID() },
  );
  await chat.requestUpdateThreadComputerUseHost(
    fixture.actor,
    fixture.threadId,
    null,
    [404],
    { cloudBrowserEnabled: true, eventId: randomUUID() },
  );
  await chat.requestUpdateThreadComputerUseHost(
    fixture.actor,
    fixture.threadId,
    null,
    [404],
    { cloudBrowserEnabled: false, eventId: randomUUID() },
  );
}

describe("account erasure fences chat-thread Computer Use selection", () => {
  it("denies binding, clearing and cloud-browser changes for a closed thread user", async () => {
    const fixture = await createHostSelectionFixture();
    const otherHost = await cu.startComputerUseHost(fixture.actor);
    await chat.updateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      fixture.hostId,
      { eventId: randomUUID() },
    );
    const before = await sidebarHostEvents(fixture);
    const selection = await readSelection(fixture);
    expect(selection).toStrictEqual({
      computerUseHostId: fixture.hostId,
      cloudBrowserEnabled: false,
    });

    const closed = await closeSubject({
      subjectKind: "user",
      subjectId: fixture.actor.userId,
    });
    await requestEveryDeniedSelection(fixture, otherHost.hostId);

    await expect(readClosedSelection(fixture)).resolves.toStrictEqual(
      selection,
    );
    await expect(sidebarHostEvents(fixture)).resolves.toStrictEqual(before);

    // The four denied attempts left the durable sequence untouched, so the
    // next accepted clear takes the very next sidebar sequence id.
    await removeErasureSubjectsFixture([closed.jobId]);
    await chat.updateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      null,
      { eventId: randomUUID() },
    );
    const after = await sidebarHostEvents(fixture);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)?.seqId).toBe((before.at(-1)?.seqId ?? 0) + 1);
    await expect(readSelection(fixture)).resolves.toStrictEqual({
      computerUseHostId: null,
      cloudBrowserEnabled: false,
    });
  });

  it("denies the selection writes for a closed distinct Agent owner", async () => {
    const fixture = await createHostSelectionFixture();
    const otherHost = await cu.startComputerUseHost(fixture.actor);
    await chat.updateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      null,
      { cloudBrowserEnabled: true },
    );
    const before = await sidebarHostEvents(fixture);
    const selection = await readSelection(fixture);
    expect(selection).toStrictEqual({
      computerUseHostId: null,
      cloudBrowserEnabled: true,
    });

    const sharedOwner = `user_${randomUUID()}`;
    await transferAgentOwnerFixture({
      agentId: fixture.agentId,
      owner: sharedOwner,
    });
    await closeSubject({ subjectKind: "user", subjectId: sharedOwner });

    await requestEveryDeniedSelection(fixture, otherHost.hostId);

    await expect(readClosedSelection(fixture)).resolves.toStrictEqual(
      selection,
    );
    await expect(sidebarHostEvents(fixture)).resolves.toStrictEqual(before);
  });

  it("denies the selection writes for a closed organization", async () => {
    const fixture = await createHostSelectionFixture();
    const otherHost = await cu.startComputerUseHost(fixture.actor);
    await chat.updateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      fixture.hostId,
    );
    const before = await sidebarHostEvents(fixture);
    const selection = await readSelection(fixture);

    await closeSubject({
      subjectKind: "organization",
      subjectId: fixture.orgId,
    });
    await requestEveryDeniedSelection(fixture, otherHost.hostId);

    await expect(readClosedSelection(fixture)).resolves.toStrictEqual(
      selection,
    );
    await expect(sidebarHostEvents(fixture)).resolves.toStrictEqual(before);
  });

  it("publishes no invalidation for a denied selection and one for an accepted selection", async () => {
    const fixture = await createHostSelectionFixture();
    const closed = await closeSubject({
      subjectKind: "user",
      subjectId: fixture.actor.userId,
    });

    await expect(
      observedInvalidations(() => {
        return chat.requestUpdateThreadComputerUseHost(
          fixture.actor,
          fixture.threadId,
          fixture.hostId,
          [404],
        );
      }),
    ).resolves.toBe(0);

    await removeErasureSubjectsFixture([closed.jobId]);
    await expect(
      observedInvalidations(() => {
        return chat.updateThreadComputerUseHost(
          fixture.actor,
          fixture.threadId,
          fixture.hostId,
        );
      }),
    ).resolves.toBe(1);
  });

  it("keeps an unrelated owner selecting a host while another subject is closed", async () => {
    const closed = await createHostSelectionFixture();
    const unrelated = await createHostSelectionFixture();
    await closeSubject({ subjectKind: "user", subjectId: closed.actor.userId });

    await chat.requestUpdateThreadComputerUseHost(
      closed.actor,
      closed.threadId,
      closed.hostId,
      [404],
    );
    await expect(readClosedSelection(closed)).resolves.toStrictEqual({
      computerUseHostId: null,
      cloudBrowserEnabled: false,
    });

    await chat.updateThreadComputerUseHost(
      unrelated.actor,
      unrelated.threadId,
      unrelated.hostId,
    );
    await expect(readSelection(unrelated)).resolves.toStrictEqual({
      computerUseHostId: unrelated.hostId,
      cloudBrowserEnabled: false,
    });
  });

  it("makes a closure wait for an admitted selection while an unrelated owner keeps writing", async () => {
    const fixture = await createHostSelectionFixture();
    const unrelated = await createHostSelectionFixture();

    const closed = await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        work: async (barrier) => {
          const selecting = chat.updateThreadComputerUseHost(
            fixture.actor,
            fixture.threadId,
            fixture.hostId,
          );
          const settings = await barrier.entered;
          expect(settings.lockTimeout).toBe("1s");
          expect(settings.statementTimeout).toBe("5s");

          const closing = closeErasureSubjectFixture({
            subjectKind: "user",
            subjectId: fixture.actor.userId,
          });
          // The admitted selection holds its shared subject barrier with the
          // host binding, the durable sequence and the
          // `computer_use_host_updated` event already written, so the exclusive
          // closure cannot commit ahead of it.
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);

          // An unrelated owner is not serialized behind that barrier.
          await chat.updateThreadComputerUseHost(
            unrelated.actor,
            unrelated.threadId,
            unrelated.hostId,
          );
          await expect(readSelection(unrelated)).resolves.toStrictEqual({
            computerUseHostId: unrelated.hostId,
            cloudBrowserEnabled: false,
          });

          barrier.release();
          await selecting;
          return await closing;
        },
      },
      context.signal,
    );
    onTestFinished(async () => {
      await removeErasureSubjectsFixture([closed.jobId]);
    });

    const admitted = await sidebarHostEvents(fixture);
    expect(admitted).toHaveLength(1);
    expect(admitted.at(-1)?.computerUseHostId).toBe(fixture.hostId);
    const selection = await readClosedSelection(fixture);
    expect(selection.computerUseHostId).toBe(fixture.hostId);

    // The closure landed behind the admitted write, so the next selection is
    // rejected and changes nothing.
    await chat.requestUpdateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      null,
      [404],
    );
    await expect(readClosedSelection(fixture)).resolves.toStrictEqual(
      selection,
    );
    await expect(sidebarHostEvents(fixture)).resolves.toStrictEqual(admitted);
  });

  it("re-resolves a transferred Agent owner under the locks instead of selecting under a stale label", async () => {
    const fixture = await createHostSelectionFixture();
    const newOwner = `user_${randomUUID()}`;
    await closeSubject({ subjectKind: "user", subjectId: newOwner });

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "agent-lock",
        work: async (barrier) => {
          const selecting = chat.requestUpdateThreadComputerUseHost(
            fixture.actor,
            fixture.threadId,
            fixture.hostId,
            [404],
          );
          await barrier.entered;
          await transferAgentOwnerFixture({
            agentId: fixture.agentId,
            owner: newOwner,
          });
          barrier.release();
          await selecting;
        },
      },
      context.signal,
    );

    await expect(readClosedSelection(fixture)).resolves.toStrictEqual({
      computerUseHostId: null,
      cloudBrowserEnabled: false,
    });
    await expect(sidebarHostEvents(fixture)).resolves.toStrictEqual([]);
  });

  it("finds a thread deleted under the locks and recreates no selection event", async () => {
    const fixture = await createHostSelectionFixture();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "agent-lock",
        work: async (barrier) => {
          const selecting = chat.requestUpdateThreadComputerUseHost(
            fixture.actor,
            fixture.threadId,
            fixture.hostId,
            [404],
          );
          await barrier.entered;
          await chat.deleteThread(fixture.actor, fixture.threadId);
          barrier.release();
          await selecting;
        },
      },
      context.signal,
    );

    await chat.requestReadThread(fixture.actor, fixture.threadId, [404]);
    await expect(sidebarHostEvents(fixture)).resolves.toStrictEqual([]);
  });

  it("rolls the selection, sidebar event and sequence back when the write fails after them", async () => {
    const fixture = await createHostSelectionFixture();
    await chat.updateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      fixture.hostId,
    );
    const before = await sidebarHostEvents(fixture);
    const selection = await readSelection(fixture);
    const lastSeqId = await lastHostSeqId(fixture);

    const eventId = randomUUID();
    const holder = await holdChatThreadEventIdFixture({
      eventId,
      userId: fixture.actor.userId,
      orgId: fixture.orgId,
      chatThreadId: fixture.threadId,
      signal: context.signal,
    });
    // The selection writes the binding and reserves the durable sequence, then
    // its last statement blocks on the held event id and fails on its own
    // bounded budget. A genuine transaction failure is neither a 204 nor the
    // closure 404. This exercises a failing final statement, not a failing
    // COMMIT.
    context.mocks.ably.publish.mockClear();
    await expect(
      chat.requestUpdateThreadComputerUseHost(
        fixture.actor,
        fixture.threadId,
        null,
        [204, 404],
        { cloudBrowserEnabled: true, eventId },
      ),
    ).rejects.toThrow(/Unknown response status 500/);
    holder.release();
    await holder.done;
    await flushWaitUntilForTest();

    await expect(readSelection(fixture)).resolves.toStrictEqual(selection);
    await expect(sidebarHostEvents(fixture)).resolves.toStrictEqual(before);
    expect(countThreadListInvalidations()).toBe(0);

    // No sidebar sequence was consumed: the next accepted clear still takes the
    // very next sequence id.
    await chat.updateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      null,
    );
    await expect(lastHostSeqId(fixture)).resolves.toBe(lastSeqId + 1);
  });

  it("propagates a held parent lock as a failure rather than a closure 404", async () => {
    const fixture = await createHostSelectionFixture();
    const selection = await readSelection(fixture);

    const holder = await holdChatThreadRowLockFixture({
      threadId: fixture.threadId,
      signal: context.signal,
    });
    // Neither an accepted 204 nor the closure 404: a real blocked parent lock
    // keeps its own database failure instead of being reported as erasure.
    await expect(
      chat.requestUpdateThreadComputerUseHost(
        fixture.actor,
        fixture.threadId,
        fixture.hostId,
        [204, 404],
      ),
    ).rejects.toThrow(/Unknown response status 500/);
    holder.release();
    await holder.done;

    await expect(readSelection(fixture)).resolves.toStrictEqual(selection);
    await chat.updateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      fixture.hostId,
    );
    await expect(readSelection(fixture)).resolves.toStrictEqual({
      computerUseHostId: fixture.hostId,
      cloudBrowserEnabled: false,
    });
  });

  it("propagates a cancelled request as a failure rather than a closure 404", async () => {
    const fixture = await createHostSelectionFixture();
    const selection = await readSelection(fixture);
    const cancelled = new AbortController();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "thread-lock",
        work: async (barrier) => {
          const selecting = chat.requestUpdateThreadComputerUseHost(
            fixture.actor,
            fixture.threadId,
            fixture.hostId,
            [204, 404],
            { signal: cancelled.signal },
          );
          await barrier.entered;
          cancelled.abort();
          barrier.release();
          // A cancelled request keeps its own abort failure; it is neither the
          // accepted 204 nor the closure 404.
          await expect(selecting).rejects.toThrow(
            /Unknown response status 500/,
          );
        },
      },
      context.signal,
    );

    await expect(readSelection(fixture)).resolves.toStrictEqual(selection);
    await expect(sidebarHostEvents(fixture)).resolves.toStrictEqual([]);
  });

  it("keeps the unchanged selection contract beside the fence", async () => {
    const fixture = await createHostSelectionFixture();
    const peer = bdd.user({ orgId: fixture.actor.orgId });
    const foreign = await createHostSelectionFixture();

    // Thread ownership precedes host eligibility, and a foreign host is not
    // eligible for this actor.
    await chat.requestUpdateThreadComputerUseHost(
      peer,
      fixture.threadId,
      fixture.hostId,
      [404],
    );
    await chat.requestUpdateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      foreign.hostId,
      [404],
    );
    await chat.requestUpdateThreadComputerUseHost(
      fixture.actor,
      randomUUID(),
      foreign.hostId,
      [404],
    );
    await chat.requestUpdateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      randomUUID(),
      [404],
    );
    // Mutually exclusive selections stay a 400, after the thread check.
    await chat.requestUpdateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      fixture.hostId,
      [400],
      { cloudBrowserEnabled: true },
    );
    await expect(readSelection(fixture)).resolves.toStrictEqual({
      computerUseHostId: null,
      cloudBrowserEnabled: false,
    });

    // A null host with an omitted flag keeps the stored flag; an explicit flag
    // sets it; a non-null host always forces the cloud browser off.
    await chat.updateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      null,
      {
        cloudBrowserEnabled: true,
      },
    );
    await chat.updateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      null,
    );
    await expect(readSelection(fixture)).resolves.toStrictEqual({
      computerUseHostId: null,
      cloudBrowserEnabled: true,
    });
    await chat.updateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      fixture.hostId,
    );
    await expect(readSelection(fixture)).resolves.toStrictEqual({
      computerUseHostId: fixture.hostId,
      cloudBrowserEnabled: false,
    });
    await chat.updateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      null,
      {
        cloudBrowserEnabled: false,
      },
    );
    await expect(readSelection(fixture)).resolves.toStrictEqual({
      computerUseHostId: null,
      cloudBrowserEnabled: false,
    });

    // A repeated event id is the client's own optimistic id, so the second
    // request keeps its 204 and appends no second durable event.
    const before = await sidebarHostEvents(fixture);
    const eventId = randomUUID();
    await chat.updateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      fixture.hostId,
      { eventId },
    );
    const appended = await sidebarHostEvents(fixture);
    expect(appended).toHaveLength(before.length + 1);
    await chat.updateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      null,
      { eventId },
    );
    await expect(sidebarHostEvents(fixture)).resolves.toStrictEqual(appended);
  });

  it("keeps an offline installed host selectable and rejects a revoked host", async () => {
    const fixture = await createHostSelectionFixture();
    const installed = await cu.startComputerUseHost(fixture.actor, {
      installationId: randomUUID(),
    });
    // An installed host goes offline without being revoked, which this route
    // deliberately still accepts.
    await cu.stopComputerUseHost(installed.hostToken);
    await chat.updateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      installed.hostId,
    );
    await expect(readSelection(fixture)).resolves.toStrictEqual({
      computerUseHostId: installed.hostId,
      cloudBrowserEnabled: false,
    });

    // An ephemeral host revokes on stop, and a revoked host is not selectable.
    const ephemeral = await cu.startComputerUseHost(fixture.actor);
    await cu.stopComputerUseHost(ephemeral.hostToken);
    await chat.requestUpdateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      ephemeral.hostId,
      [404],
    );
    await expect(readSelection(fixture)).resolves.toStrictEqual({
      computerUseHostId: installed.hostId,
      cloudBrowserEnabled: false,
    });
  });

  it("still requires a non-null Agent after the fence", async () => {
    const fixture = await createHostSelectionFixture();
    await setChatThreadAgentFixture({
      chatThreadId: fixture.threadId,
      agentId: null,
    });

    const denied = await chat.requestUpdateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      fixture.hostId,
      [404],
    );
    expect(denied.status).toBe(404);
    await expect(sidebarHostEvents(fixture)).resolves.toStrictEqual([]);
  });
});
