import { randomUUID } from "node:crypto";

import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  transferAgentOrganizationFixture,
  transferAgentOwnerFixture,
} from "../../../test-fixtures/account-erasure-subject";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import {
  holdChatThreadEventIdFixture,
  readChatThreadTitleStateFixture,
  withChatThreadContentBarrierFixture,
} from "../../../test-fixtures/chat-thread-content-erasure";
import { createDeferredPromise } from "../../utils";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
/**
 * Every case here drives the real send route, real PostgreSQL and a background
 * drain, and the barrier-driven ones also pause a real transaction while a
 * second session observes it. That does not fit the default case budget, so
 * they state their own. It bounds how long a case may take; it weakens no
 * assertion inside it.
 */
const CASE_TIMEOUT_MS = 30_000;
/** Polling a live PostgreSQL wait state, never a sleep standing in for one. */
const BLOCKED = { interval: 10, timeout: 10_000 } as const;
const TITLE_SYSTEM_PROMPT = "Generate a short, descriptive title";
const GENERATED_TITLE = "Late generated title";
/**
 * `TITLE_FENCE_DEADLINE_MS` in `chat-title.service.ts`. It is duplicated rather
 * than exported so the production module keeps its current surface; a case that
 * arms the deadline seam below asserts the value is actually observed, so a
 * drift here fails instead of silently disarming the case.
 */
const TITLE_FENCE_DEADLINE_MS = 30_000;

beforeEach(() => {
  mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
});

interface SidebarRename {
  readonly seqId: number;
  readonly title: string | null;
}

function draftBody(text: string) {
  return {
    draftUserMessage: {
      version: 1 as const,
      parts: [{ type: "text" as const, text }],
    },
    draftAttachments: null,
  };
}

/**
 * One owner whose eager generated title is held inside the provider request.
 * The send has already answered `201` by the time `entered` resolves, so every
 * case acts on a thread whose generation is genuinely in flight and outside the
 * request that started it.
 *
 * `titleRequests` counts only requests carrying this owner's own prompt.
 * `flushWaitUntilForTest` is global, so another case's background title can
 * still be draining, and an unscoped counter would attribute it here.
 */
interface PausedTitle {
  readonly actor: ReturnType<typeof bdd.user>;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly prompt: string;
  /** The runner group this owner's runs are dispatched to. */
  readonly runnerGroup: string;
  /** Resolves once the first title provider request is in flight. */
  readonly entered: Promise<void>;
  /**
   * Resolves once `count` title provider requests for this owner are in flight
   * together. Every entered request stays held until `release`, so awaiting
   * this is an observation of real concurrent provider entry rather than a
   * poll that a completed first request could satisfy.
   */
  readonly enteredAt: (count: number) => Promise<void>;
  /** Title provider requests this owner's prompts have actually entered. */
  readonly titleRequests: () => number;
  readonly send: (prompt: string) => Promise<void>;
  /** The created run id, or `null` when the send only queued the message. */
  readonly sendForRun: (prompt: string) => Promise<string | null>;
  readonly release: () => void;
  /** Releases the provider and drains the background title work. */
  readonly complete: () => Promise<void>;
  readonly renames: () => Promise<readonly SidebarRename[]>;
  readonly title: () => Promise<string | null>;
}

/**
 * `agentOwner` moves the Agent **before** the thread exists, so the captured pin
 * already names that owner and the identity never changes afterwards. A transfer
 * performed after capture would let a pin mismatch discard the title on its own,
 * which would pass whether or not that owner's B1 admission was checked at all.
 */
async function pauseGeneratedTitle(options?: {
  readonly agentOwner?: string;
  /** Leave the send to the caller. The barrier fixture closes the database pool
   * when it arms, so a case that pauses this workflow must start it inside the
   * fixture rather than leave it in flight across that close. */
  readonly send?: boolean;
}): Promise<PausedTitle> {
  const actor = bdd.user();
  const { orgId } = actor;
  if (orgId === null) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  // Shared visibility, not the private default of `createAgentForChatThread`:
  // a private Agent can only be run by its owner, so a thread user distinct
  // from the Agent owner cannot exist for one.
  const agent = await bdd.createAgent(actor, {
    displayName: `Title fence ${randomUUID().slice(0, 8)}`,
  });
  if (options?.agentOwner !== undefined) {
    await transferAgentOwnerFixture({
      agentId: agent.agentId,
      owner: options.agentOwner,
    });
  }

  const prompt = `Prepare the launch checklist ${randomUUID()}`;
  /** Every prompt this owner has sent, so a title request is attributed to it
   * by its own content rather than by being the only one in the process. */
  const ownedPrompts: string[] = [prompt];
  const entered = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  let titleRequests = 0;
  const enteredWaiters = new Map<
    number,
    ReturnType<typeof createDeferredPromise<void>>
  >();
  const enteredAt = (count: number): Promise<void> => {
    const existing = enteredWaiters.get(count);
    if (existing) {
      return existing.promise;
    }
    const waiter = createDeferredPromise<void>(context.signal);
    enteredWaiters.set(count, waiter);
    if (titleRequests >= count) {
      waiter.resolve(undefined);
    }
    return waiter.promise;
  };
  const release = () => {
    if (!released.settled()) {
      released.resolve(undefined);
    }
  };
  // Drain this owner's background title before the case ends. The barrier
  // fixture closes the database pool when it arms, so work left in flight here
  // would be broken by, and would break, whichever case arms it next.
  onTestFinished(async () => {
    release();
    await flushWaitUntilForTest();
  });
  createChatCallbacksApi(context).mockOpenRouterCompletions(async (body) => {
    const content = body.messages[1]?.content ?? "";
    if (
      body.messages[0]?.content.includes(TITLE_SYSTEM_PROMPT) &&
      ownedPrompts.some((owned) => {
        return content.includes(owned);
      })
    ) {
      titleRequests += 1;
      if (!entered.settled()) {
        entered.resolve(undefined);
      }
      for (const [count, waiter] of enteredWaiters) {
        if (titleRequests >= count && !waiter.settled()) {
          waiter.resolve(undefined);
        }
      }
      await released.promise;
      return GENERATED_TITLE;
    }
    return "Thinking";
  });

  const thread = await chat.createThread(actor, { agentId: agent.agentId });
  const sendForRun = async (text: string): Promise<string | null> => {
    if (!ownedPrompts.includes(text)) {
      ownedPrompts.push(text);
    }
    const sent = await accept(
      chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          threadId: thread.id,
          prompt: text,
          model: "claude-sonnet-5",
        },
        [201],
      ),
      [201],
    );
    return sent.body.runId ?? null;
  };
  const send = async (text: string) => {
    await sendForRun(text);
  };
  if (options?.send !== false) {
    await send(prompt);
  }

  const renames = async () => {
    const listed = await chat.requestThreadEvents(actor, {}, [200]);
    if (!("events" in listed.body)) {
      throw new Error("Expected the sidebar event page");
    }
    return listed.body.events
      .filter((event) => {
        return event.kind === "renamed" && event.chatThreadId === thread.id;
      })
      .map((event) => {
        return { seqId: event.seqId, title: event.title };
      });
  };

  return {
    actor,
    orgId,
    agentId: agent.agentId,
    threadId: thread.id,
    prompt,
    runnerGroup,
    entered: entered.promise,
    enteredAt,
    titleRequests: () => {
      return titleRequests;
    },
    send,
    sendForRun,
    release,
    complete: async () => {
      release();
      await flushWaitUntilForTest();
    },
    renames,
    title: async () => {
      return (await chat.readThreadMetadata(actor, thread.id)).title;
    },
  };
}

/** A second owner with its own thread, used to show it keeps making progress
 * while another owner holds an admitted barrier. It registers no provider
 * handler, because a second paused title would replace the first's. */
async function createUnrelatedThread(): Promise<{
  readonly actor: ReturnType<typeof bdd.user>;
  readonly threadId: string;
}> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const agent = await chat.createAgentForChatThread(actor);
  const thread = await chat.createThread(actor, { agentId: agent.agentId });
  return { actor, threadId: thread.id };
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

/** The highest sidebar sequence id this owner has consumed so far. */
async function lastSidebarSeqId(paused: PausedTitle): Promise<number> {
  const listed = await chat.requestThreadEvents(paused.actor, {}, [200]);
  if (!("events" in listed.body)) {
    throw new Error("Expected the sidebar event page");
  }
  return listed.body.events.reduce((highest, event) => {
    return Math.max(highest, event.seqId);
  }, 0);
}

/**
 * A denied or rolled back late title must leave the durable per-owner sequence
 * exactly where it was, so the next accepted rename takes the very next id.
 */
async function expectSequenceUnconsumed(
  paused: PausedTitle,
  lastSeqId: number,
): Promise<void> {
  await chat.renameThread(paused.actor, paused.threadId, "Next manual title");
  const renames = await paused.renames();
  expect(renames.at(-1)).toStrictEqual({
    seqId: lastSeqId + 1,
    title: "Next manual title",
  });
}

/**
 * Every Ably publish paired with the channel it was routed to. The client mock
 * records `channels.get(name)` and the channel's `publish(topic)` on two
 * separate spies, so the channel is recovered from the last `get` that ran
 * before each publish rather than assumed. `publishChatDatabaseSignalNow`
 * performs both in one expression with no await between them, so that pairing
 * is exact.
 */
function publishedChannelTopics(): readonly {
  readonly channel: string;
  readonly topic: unknown;
}[] {
  const gets = context.mocks.ably.channelGet.mock;
  const publishes = context.mocks.ably.publish.mock;
  return publishes.calls.map((call, index) => {
    const publishedAt = publishes.invocationCallOrder[index] ?? 0;
    let channel = "";
    for (const [getIndex, order] of gets.invocationCallOrder.entries()) {
      if (order < publishedAt) {
        channel = String(gets.calls[getIndex]?.[0] ?? "");
      }
    }
    return { channel, topic: call[0] };
  });
}

/**
 * Sidebar invalidations actually routed to this owner's own user-org channel.
 * The send publishes other topics on that same channel, thread creation
 * publishes this topic before any title exists, and every other owner in this
 * file has its own channel — so the target and the topic are both filtered and
 * each case compares against a baseline it took itself.
 */
function threadListInvalidations(paused: PausedTitle): number {
  const channel = `user-org:${paused.actor.userId}:${paused.orgId}`;
  return publishedChannelTopics().filter((published) => {
    return (
      published.channel === channel && published.topic === "threadListChanged"
    );
  }).length;
}

/** Title, `renamed_at` and `updated_at` as one comparable persisted state. */
function titleState(paused: PausedTitle) {
  return readChatThreadTitleStateFixture(paused.threadId);
}

describe("account erasure fences generated chat titles", () => {
  it.each([
    {
      name: "the thread user",
      owner: undefined,
      subject: (paused: PausedTitle): ErasureSubject => {
        return { subjectKind: "user", subjectId: paused.actor.userId };
      },
    },
    {
      name: "a distinct Agent owner",
      // Established before the thread exists, so the pin already names this
      // owner: only its B1 admission can discard the title, never a mismatch.
      owner: `user_${randomUUID()}`,
      subject: (_paused: PausedTitle, owner: string): ErasureSubject => {
        return { subjectKind: "user", subjectId: owner };
      },
    },
    {
      name: "the Agent organization",
      owner: undefined,
      subject: (paused: PausedTitle): ErasureSubject => {
        return { subjectKind: "organization", subjectId: paused.orgId };
      },
    },
  ])(
    "discards a title generated for $name once it closes during the provider request",
    async ({ owner, subject }) => {
      const paused = await pauseGeneratedTitle(
        owner === undefined ? undefined : { agentOwner: owner },
      );
      await paused.entered;
      // The send already succeeded and the response is delivered; only the
      // optional title is still in flight.
      await expect(paused.title()).resolves.toBeNull();
      const lastSeqId = await lastSidebarSeqId(paused);
      // Recorded before the closure, so the comparisons below are against the
      // state the refused title would have had to change.
      const before = await titleState(paused);
      const published = threadListInvalidations(paused);

      const closed = await closeSubject(subject(paused, owner ?? ""));
      await paused.complete();

      // The generation ran to completion against the provider; only the
      // database copy was refused.
      expect(paused.titleRequests()).toBe(1);
      await expect(paused.title()).resolves.toBeNull();
      await expect(paused.renames()).resolves.toStrictEqual([]);
      // No title, no `renamed_at` and no touched `updated_at`, and the sidebar
      // of the admitted owner was never invalidated for it.
      await expect(titleState(paused)).resolves.toStrictEqual(before);
      expect(threadListInvalidations(paused)).toBe(published);

      await removeErasureSubjectsFixture([closed.jobId]);
      await expectSequenceUnconsumed(paused, lastSeqId);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "writes the title for a distinct Agent owner that stays open",
    async () => {
      // The control for the distinct-owner case above: identical setup, an
      // unrelated subject closed instead. If that case passed without checking
      // the Agent owner's own admission, this one would be indistinguishable
      // from it — here the title must be written.
      const owner = `user_${randomUUID()}`;
      const paused = await pauseGeneratedTitle({ agentOwner: owner });
      await paused.entered;
      await closeSubject({
        subjectKind: "user",
        subjectId: `user_${randomUUID()}`,
      });
      const before = await titleState(paused);
      const published = threadListInvalidations(paused);

      await paused.complete();

      expect(paused.titleRequests()).toBe(1);
      await expect(paused.title()).resolves.toBe(GENERATED_TITLE);
      await expect(paused.renames()).resolves.toStrictEqual([
        { seqId: expect.any(Number), title: GENERATED_TITLE },
      ]);
      // The committed title moves `updated_at` and leaves the manual-rename
      // marker alone, and invalidates exactly the admitted thread user's
      // sidebar — not the distinct Agent owner's.
      const after = await titleState(paused);
      expect(after.renamedAt).toBeNull();
      expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(
        Date.parse(before.updatedAt),
      );
      expect(threadListInvalidations(paused)).toBe(published + 1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "starts no title generation once its subject closes before admission",
    async () => {
      const gated = await pauseGeneratedTitle({ send: false });
      const closed = await withChatThreadContentBarrierFixture(
        {
          chatThreadId: gated.threadId,
          stopAt: "admission",
          work: async (barrier) => {
            await gated.send(gated.prompt);
            const draining = flushWaitUntilForTest();
            // Paused between the resolved identity and B1's first statement.
            await barrier.entered;
            // Committed while the gate is paused, so admission is the first
            // thing that observes it.
            const closing = await closeErasureSubjectFixture({
              subjectKind: "user",
              subjectId: gated.actor.userId,
            });
            barrier.release();
            await draining;
            return closing;
          },
        },
        context.signal,
      );
      onTestFinished(async () => {
        await removeErasureSubjectsFixture([closed.jobId]);
      });

      // Admission refused before any content was read, so the provider was
      // never called for this thread at all.
      expect(gated.titleRequests()).toBe(0);
      await expect(gated.title()).resolves.toBeNull();
      await expect(gated.renames()).resolves.toStrictEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "discards a title whose owner moves while the gate is reading context",
    async () => {
      // The gate takes no business lock, so a transfer can commit between its
      // identity read and its bounded prior-round read. The context it then
      // holds belongs to the previous owner, and the gate's own fresh pin check
      // must discard it rather than carry it into a provider request.
      const gated = await pauseGeneratedTitle({ send: false });
      await withChatThreadContentBarrierFixture(
        {
          chatThreadId: gated.threadId,
          stopAt: "title-context",
          work: async (barrier) => {
            await gated.send(gated.prompt);
            const draining = flushWaitUntilForTest();
            await barrier.entered;
            await transferAgentOwnerFixture({
              agentId: gated.agentId,
              owner: `user_${randomUUID()}`,
            });
            barrier.release();
            await draining;
          },
        },
        context.signal,
      );

      expect(gated.titleRequests()).toBe(0);
      await expect(gated.title()).resolves.toBeNull();
      await expect(gated.renames()).resolves.toStrictEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "makes a closure wait for an admitted late title and fences the next one",
    async () => {
      const paused = await pauseGeneratedTitle({ send: false });
      const unrelated = await createUnrelatedThread();

      const closed = await withChatThreadContentBarrierFixture(
        {
          chatThreadId: paused.threadId,
          stopAt: "commit",
          work: async (barrier) => {
            await paused.send(paused.prompt);
            await paused.entered;
            // The response is delivered and only the optional title is left.
            await expect(paused.title()).resolves.toBeNull();
            paused.release();
            const draining = flushWaitUntilForTest();
            const settings = await barrier.entered;
            // The late persistence runs under the fence's own bounded budget.
            expect(settings.lockTimeout).toBe("1s");
            expect(settings.statementTimeout).toBe("5s");

            const closing = closeErasureSubjectFixture({
              subjectKind: "user",
              subjectId: paused.actor.userId,
            });
            // The admitted writer still holds its shared subject barrier with
            // the title, the sequence and the renamed event already written, so
            // the exclusive closure cannot commit ahead of it.
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);

            // An unrelated owner is not serialized behind that barrier.
            await chat.patchThread(
              unrelated.actor,
              unrelated.threadId,
              draftBody("concurrent unrelated draft"),
            );

            barrier.release();
            await draining;
            return await closing;
          },
        },
        context.signal,
      );
      onTestFinished(async () => {
        await removeErasureSubjectsFixture([closed.jobId]);
      });

      // Writer first: one coherent title, one renamed event, one sequence id.
      await expect(paused.title()).resolves.toBe(GENERATED_TITLE);
      const renames = await paused.renames();
      expect(
        renames.map((rename) => {
          return rename.title;
        }),
      ).toStrictEqual([GENERATED_TITLE]);
      // The closure that waited now fences the next write on the same thread.
      await chat.requestRenameThread(
        paused.actor,
        paused.threadId,
        "Post closure title",
        [404],
      );
      await expect(paused.title()).resolves.toBe(GENERATED_TITLE);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "re-resolves an owner that moves between identity selection and the retained locks",
    async () => {
      const paused = await pauseGeneratedTitle({ send: false });
      let before: Awaited<ReturnType<typeof titleState>> | null = null;
      let published = 0;

      await withChatThreadContentBarrierFixture(
        {
          chatThreadId: paused.threadId,
          stopAt: "agent-lock",
          work: async (barrier) => {
            await paused.send(paused.prompt);
            await paused.entered;
            paused.release();
            const draining = flushWaitUntilForTest();
            // The writer has resolved its identity and is about to take the
            // Agent lock it will revalidate under.
            await barrier.entered;
            // Taken while the writer is paused before any of its own writes,
            // so these are the values a rebound title would have had to change.
            before = await titleState(paused);
            published = threadListInvalidations(paused);
            await transferAgentOwnerFixture({
              agentId: paused.agentId,
              owner: `user_${randomUUID()}`,
            });
            barrier.release();
            await draining;
          },
        },
        context.signal,
      );

      // The reselected identity no longer matches the frozen pin, so the title
      // is discarded instead of being rebound to the survivor.
      expect(paused.titleRequests()).toBe(1);
      await expect(paused.title()).resolves.toBeNull();
      await expect(paused.renames()).resolves.toStrictEqual([]);
      await expect(titleState(paused)).resolves.toStrictEqual(before);
      expect(threadListInvalidations(paused)).toBe(published);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "refuses a late title blocked on the parent lock before its first write, without reporting a closure",
    async () => {
      // A pre-write budget case, deliberately named apart from the late-write
      // rollback case below: the writer gives up on its `FOR KEY SHARE` wait,
      // which happens **before** the title UPDATE, the sequence reservation and
      // the event insert. It proves refusal on a real lock budget, not that
      // already-executed writes roll back.
      const paused = await pauseGeneratedTitle({ send: false });
      let lastSeqId = 0;
      let before: Awaited<ReturnType<typeof titleState>> | null = null;
      let published = 0;

      await withChatThreadContentBarrierFixture(
        {
          chatThreadId: paused.threadId,
          stopAt: "agent-lock",
          work: async (barrier) => {
            await paused.send(paused.prompt);
            await paused.entered;
            paused.release();
            // The workflow continues on its own, so no drain runs inside the
            // lock window below: `flushWaitUntilForTest` is process wide and
            // would also await another file's background work, which must not
            // be made to wait on a row lock this case holds.
            await barrier.entered;
            // The writer is paused before its own first write, so these
            // baselines are taken ahead of the attempt rather than read back
            // from whatever survived it.
            lastSeqId = await lastSidebarSeqId(paused);
            before = await titleState(paused);
            published = threadListInvalidations(paused);
            // Taken while the writer is paused, so only the writer's own
            // `chat_threads` KEY SHARE can block on it.
            const holder = await holdChatThreadRowLockFixture({
              threadId: paused.threadId,
              signal: context.signal,
            });
            barrier.release();
            // Observe this writer's own `FOR KEY SHARE` block, then observe it
            // give up on its `1s` budget. Counting only KEY SHARE waiters keeps
            // the second observation from waiting on an ordinary writer that
            // has no lock timeout and is simply queued behind the holder.
            await expect
              .poll(holder.blockedKeyShareWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);
            await expect
              .poll(holder.blockedKeyShareWaiterCount, BLOCKED)
              .toBe(0);
            holder.release();
            await holder.done;
            await flushWaitUntilForTest();
          },
        },
        context.signal,
      );

      // A real blocked parent lock is neither a write nor the closure
      // disposition: nothing was written and nothing was consumed.
      expect(paused.titleRequests()).toBe(1);
      await expect(paused.title()).resolves.toBeNull();
      await expect(paused.renames()).resolves.toStrictEqual([]);
      await expect(titleState(paused)).resolves.toStrictEqual(before);
      expect(threadListInvalidations(paused)).toBe(published);
      await expectSequenceUnconsumed(paused, lastSeqId);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "discards a title whose Agent owner moves inside the same organization",
    async () => {
      const paused = await pauseGeneratedTitle();
      await paused.entered;
      const lastSeqId = await lastSidebarSeqId(paused);

      // Same organization, same thread user: only `agents.owner` moves, which a
      // check limited to user and organization would not notice.
      await transferAgentOwnerFixture({
        agentId: paused.agentId,
        owner: `user_${randomUUID()}`,
      });
      await paused.complete();

      await expect(paused.title()).resolves.toBeNull();
      await expect(paused.renames()).resolves.toStrictEqual([]);
      await expectSequenceUnconsumed(paused, lastSeqId);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "discards a title whose Agent moves to another organization",
    async () => {
      const paused = await pauseGeneratedTitle();
      await paused.entered;

      await transferAgentOrganizationFixture({
        agentId: paused.agentId,
        orgId: `org_${randomUUID()}`,
      });
      await paused.complete();

      await expect(paused.renames()).resolves.toStrictEqual([]);
      // Read back through the thread's own row rather than the moved Agent.
      await transferAgentOrganizationFixture({
        agentId: paused.agentId,
        orgId: paused.orgId,
      });
      await expect(paused.title()).resolves.toBeNull();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "recreates nothing for a thread deleted during the provider request",
    async () => {
      const paused = await pauseGeneratedTitle();
      await paused.entered;
      await chat.deleteThread(paused.actor, paused.threadId);

      await paused.complete();

      await chat.requestReadThread(paused.actor, paused.threadId, [404]);
      await expect(paused.renames()).resolves.toStrictEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "lets a manual rename win over a late generated title",
    async () => {
      const paused = await pauseGeneratedTitle();
      await paused.entered;
      await chat.renameThread(paused.actor, paused.threadId, "Manual title");

      await paused.complete();

      await expect(paused.title()).resolves.toBe("Manual title");
      await expect(paused.renames()).resolves.toStrictEqual([
        { seqId: expect.any(Number), title: "Manual title" },
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "refuses a second generation and appends exactly one renamed event",
    async () => {
      const paused = await pauseGeneratedTitle();
      await paused.entered;
      const lastSeqId = await lastSidebarSeqId(paused);
      await paused.complete();
      expect(paused.titleRequests()).toBe(1);

      // A further send on the same thread schedules another generation. Its
      // gate finds the thread already titled, so the request count stays at one
      // and no second attempt reaches the provider: the single renamed event
      // below is the eligibility CAS holding, observed rather than inferred.
      await paused.send(`${paused.prompt} again`);
      await flushWaitUntilForTest();

      expect(paused.titleRequests()).toBe(1);
      await expect(paused.title()).resolves.toBe(GENERATED_TITLE);
      await expect(paused.renames()).resolves.toStrictEqual([
        { seqId: lastSeqId + 1, title: GENERATED_TITLE },
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "rolls the title, sidebar event and sequence back when the late write fails after writing them",
    async () => {
      const paused = await pauseGeneratedTitle();
      await paused.entered;
      // Every baseline is taken **before** the attempt: the row state it would
      // change, the events it would append, the sequence id it would consume
      // and the invalidations it would publish.
      const before = await titleState(paused);
      const beforeRenames = await paused.renames();
      const lastSeqId = await lastSidebarSeqId(paused);
      const published = threadListInvalidations(paused);

      // Holding the very next `(user_id, org_id, seq_id)` slot makes the
      // writer's **last** statement block: the `renamed` insert runs after the
      // title UPDATE and after the durable sequence reservation, so the
      // transaction fails with those two writes already executed and `COMMIT`
      // never sent. That is a failing final statement, not a failing COMMIT.
      const holder = await holdChatThreadEventIdFixture({
        seqId: lastSeqId + 1,
        userId: paused.actor.userId,
        orgId: paused.orgId,
        chatThreadId: paused.threadId,
        signal: context.signal,
      });
      await paused.complete();
      holder.release();
      await holder.done;

      // The generation reached the provider and the write executed; the whole
      // transaction still rolled back, including its timestamp.
      expect(paused.titleRequests()).toBe(1);
      await expect(titleState(paused)).resolves.toStrictEqual(before);
      await expect(paused.renames()).resolves.toStrictEqual(beforeRenames);
      expect(threadListInvalidations(paused)).toBe(published);
      // The reserved sequence rolled back with it: the next accepted rename
      // still takes the id this attempt had already allocated for itself.
      await expectSequenceUnconsumed(paused, lastSeqId);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "publishes the sidebar invalidation only once the late title has committed",
    async () => {
      const paused = await pauseGeneratedTitle({ send: false });
      let published = 0;
      let precommit = -1;

      await withChatThreadContentBarrierFixture(
        {
          chatThreadId: paused.threadId,
          stopAt: "commit",
          work: async (barrier) => {
            await paused.send(paused.prompt);
            await paused.entered;
            // The send has answered and its own invalidations are recorded;
            // only the held title is still in flight, so this baseline isolates
            // the workflow under test from the request that scheduled it.
            published = threadListInvalidations(paused);
            paused.release();
            const draining = flushWaitUntilForTest();
            await barrier.entered;
            // The title, the sequence and the `renamed` event are written and
            // `COMMIT` has not been sent. No subscriber may have been told yet,
            // and no other session can read the title either.
            precommit = threadListInvalidations(paused);
            await expect(paused.title()).resolves.toBeNull();
            barrier.release();
            await draining;
          },
        },
        context.signal,
      );

      expect(precommit).toBe(published);
      await expect(paused.title()).resolves.toBe(GENERATED_TITLE);
      // Exactly one invalidation, on the admitted owner's own user-org channel.
      expect(threadListInvalidations(paused)).toBe(published + 1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "titles a thread once when the send route and the queued-claim drain overlap",
    async () => {
      const paused = await pauseGeneratedTitle({ send: false });
      const firstRunId = await paused.sendForRun(paused.prompt);
      if (firstRunId === null) {
        throw new Error("Expected the first send to create a run");
      }
      await paused.entered;

      // A second send while that run is active only queues the message, so the
      // send route schedules nothing for it. That alone is what the previous
      // contract mistook for "two in-flight generations are unreachable".
      const secondPrompt = `Draft the rollback plan ${randomUUID()}`;
      await expect(paused.sendForRun(secondPrompt)).resolves.toBeNull();
      expect(paused.titleRequests()).toBe(1);

      // The queued-claim drain is the other production scheduler. Finishing the
      // first run makes the terminal callback claim that queued message, create
      // its run and schedule a second eager title — while the first provider
      // request is still held open and the thread is therefore still untitled.
      await webhooks.requestAgentComplete(
        { runId: firstRunId, exitCode: 0 },
        {
          authorization: `Bearer ${runs.sandboxTokenForRun(
            paused.actor,
            firstRunId,
          )}`,
        },
        [200],
      );
      // Both requests are counted and both are inside the held handler, so this
      // is real overlap rather than a second attempt after the first finished.
      await paused.enteredAt(2);
      expect(paused.titleRequests()).toBe(2);

      const published = threadListInvalidations(paused);
      // Released together, so the two completions race the same eligibility CAS
      // instead of being serialized by the test.
      await paused.complete();

      await expect(paused.title()).resolves.toBe(GENERATED_TITLE);
      // One title-bearing event, so exactly one sequence id was consumed, and
      // one invalidation for it.
      const renames = await paused.renames();
      expect(
        renames.map((rename) => {
          return rename.title;
        }),
      ).toStrictEqual([GENERATED_TITLE]);
      expect(threadListInvalidations(paused)).toBe(published + 1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "abandons the late title at its own fence deadline instead of writing past it",
    async () => {
      const paused = await pauseGeneratedTitle();
      await paused.entered;
      const before = await titleState(paused);
      const lastSeqId = await lastSidebarSeqId(paused);
      const published = threadListInvalidations(paused);

      // The initiation gate has already committed — the provider request only
      // starts after it — so arming the deadline here reaches the completion
      // fence alone. This is the workflow's own `AbortSignal.timeout`, checked
      // at its cooperative boundaries: it is not the delivered response's
      // signal, and it is not the server's `1s` lock or `5s` statement budget.
      const observed: number[] = [];
      const fence = new AbortController();
      context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
        observed.push(milliseconds);
        return milliseconds === TITLE_FENCE_DEADLINE_MS
          ? fence.signal
          : undefined;
      });
      fence.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );

      await paused.complete();

      // The production deadline value is the one the workflow actually asked
      // for, so this case cannot silently stop arming anything.
      expect(observed).toContain(TITLE_FENCE_DEADLINE_MS);
      // The provider request had already completed; the deadline stopped the
      // workflow before the write, and it is a failure rather than a closure:
      // nothing was written, published or consumed, and the thread stays
      // eligible for the owner's own next rename.
      expect(paused.titleRequests()).toBe(1);
      await expect(titleState(paused)).resolves.toStrictEqual(before);
      await expect(paused.renames()).resolves.toStrictEqual([]);
      expect(threadListInvalidations(paused)).toBe(published);
      await expectSequenceUnconsumed(paused, lastSeqId);
    },
    CASE_TIMEOUT_MS,
  );
});
