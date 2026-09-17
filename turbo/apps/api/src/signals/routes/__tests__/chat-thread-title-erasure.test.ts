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
import { withChatThreadContentBarrierFixture } from "../../../test-fixtures/chat-thread-content-erasure";
import { createDeferredPromise } from "../../utils";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
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
  /** Resolves once the first title provider request is in flight. */
  readonly entered: Promise<void>;
  /** Title provider requests this owner's prompt has actually entered. */
  readonly titleRequests: () => number;
  readonly send: (prompt: string) => Promise<void>;
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
  runs.configureRunnerGroup();
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
  const entered = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  let titleRequests = 0;
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
      content.includes(prompt)
    ) {
      titleRequests += 1;
      entered.resolve(undefined);
      await released.promise;
      return GENERATED_TITLE;
    }
    return "Thinking";
  });

  const thread = await chat.createThread(actor, { agentId: agent.agentId });
  const send = async (text: string) => {
    await accept(
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
    entered: entered.promise,
    titleRequests: () => {
      return titleRequests;
    },
    send,
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

      const closed = await closeSubject(subject(paused, owner ?? ""));
      await paused.complete();

      // The generation ran to completion against the provider; only the
      // database copy was refused.
      expect(paused.titleRequests()).toBe(1);
      await expect(paused.title()).resolves.toBeNull();
      await expect(paused.renames()).resolves.toStrictEqual([]);

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

      await paused.complete();

      expect(paused.titleRequests()).toBe(1);
      await expect(paused.title()).resolves.toBe(GENERATED_TITLE);
      await expect(paused.renames()).resolves.toStrictEqual([
        { seqId: expect.any(Number), title: GENERATED_TITLE },
      ]);
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
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "rolls a blocked late title back completely instead of reporting a closure",
    async () => {
      const paused = await pauseGeneratedTitle({ send: false });

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
      const lastSeqId = await lastSidebarSeqId(paused);
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
});
