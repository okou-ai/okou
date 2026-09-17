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
const BLOCKED = { interval: 10, timeout: 10_000 } as const;
/**
 * The barrier-driven cases pause a real transaction while a second session
 * observes it, on top of the full send path this suite exercises. That does not
 * fit the default case budget, so they state their own. It bounds how long the
 * case may take; it weakens no assertion inside it.
 */
const BARRIER_TIMEOUT_MS = 30_000;
const PROMPT = "Prepare the launch checklist";
const GENERATED_TITLE = "Late generated title";

beforeEach(() => {
  mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
});

interface SidebarRename {
  readonly seqId: number;
  readonly title: string | null;
}

/**
 * One thread whose eager generated title is paused inside the provider request.
 * The send has already answered `201` by the time `entered` resolves, so every
 * case below acts on a thread whose title generation is genuinely in flight and
 * outside the request that started it.
 */
interface PausedTitle {
  readonly actor: ReturnType<typeof bdd.user>;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
  /** Resolves once the title provider request is in flight. */
  readonly entered: Promise<void>;
  readonly release: () => void;
  /** Releases the provider and drains the background title work. */
  readonly complete: () => Promise<void>;
  readonly renames: () => Promise<readonly SidebarRename[]>;
  readonly title: () => Promise<string | null>;
}

async function pauseGeneratedTitle(): Promise<PausedTitle> {
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
  const agent = await chat.createAgentForChatThread(actor);

  const entered = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  const release = () => {
    if (!released.settled()) {
      released.resolve(undefined);
    }
  };
  onTestFinished(release);
  createChatCallbacksApi(context).mockOpenRouterCompletions(async (body) => {
    if (
      body.messages[0]?.content.includes("Generate a short, descriptive title")
    ) {
      entered.resolve(undefined);
      await released.promise;
      return GENERATED_TITLE;
    }
    return "Thinking";
  });

  const sent = await accept(
    chat.requestSendEvent(
      actor,
      { agentId: agent.agentId, prompt: PROMPT, model: "claude-sonnet-5" },
      [201],
    ),
    [201],
  );
  const { threadId } = sent.body;
  const renames = async () => {
    const listed = await chat.requestThreadEvents(actor, {}, [200]);
    if (!("events" in listed.body)) {
      throw new Error("Expected the sidebar event page");
    }
    return listed.body.events
      .filter((event) => {
        return event.kind === "renamed" && event.chatThreadId === threadId;
      })
      .map((event) => {
        return { seqId: event.seqId, title: event.title };
      });
  };

  return {
    actor,
    orgId,
    agentId: agent.agentId,
    threadId,
    entered: entered.promise,
    release,
    complete: async () => {
      release();
      await flushWaitUntilForTest();
    },
    renames,
    title: async () => {
      return (await chat.readThreadMetadata(actor, threadId)).title;
    },
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
      subject: (paused: PausedTitle): ErasureSubject => {
        return { subjectKind: "user", subjectId: paused.actor.userId };
      },
    },
    {
      name: "a distinct Agent owner",
      subject: async (paused: PausedTitle): Promise<ErasureSubject> => {
        const sharedOwner = `user_${randomUUID()}`;
        await transferAgentOwnerFixture({
          agentId: paused.agentId,
          owner: sharedOwner,
        });
        return { subjectKind: "user", subjectId: sharedOwner };
      },
    },
    {
      name: "the Agent organization",
      subject: (paused: PausedTitle): ErasureSubject => {
        return { subjectKind: "organization", subjectId: paused.orgId };
      },
    },
  ])(
    "discards a title generated for $name once it closes during the provider request",
    async ({ subject }) => {
      const paused = await pauseGeneratedTitle();
      await paused.entered;
      // The send already succeeded and the response is delivered; only the
      // optional title is still in flight.
      await expect(paused.title()).resolves.toBeNull();
      const lastSeqId = await lastSidebarSeqId(paused);

      const closed = await closeSubject(await subject(paused));
      await paused.complete();

      await expect(paused.title()).resolves.toBeNull();
      await expect(paused.renames()).resolves.toStrictEqual([]);

      // Nothing the provider returned reached the thread, and the closure
      // consumed none of this owner's durable sidebar sequence.
      await removeErasureSubjectsFixture([closed.jobId]);
      await expectSequenceUnconsumed(paused, lastSeqId);
    },
  );

  it(
    "starts no title generation once its subject closes before admission",
    async () => {
      const actor = bdd.user();
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      runs.configureRunnerGroup();
      await runs.grantProEntitlement(actor);
      await runs.ensureOrgModelProvider(actor);
      const agent = await chat.createAgentForChatThread(actor);
      const thread = await chat.createThread(actor, { agentId: agent.agentId });

      let titleRequests = 0;
      createChatCallbacksApi(context).mockOpenRouterCompletions((body) => {
        if (
          body.messages[0]?.content.includes(
            "Generate a short, descriptive title",
          )
        ) {
          titleRequests += 1;
        }
        return "Thinking";
      });

      const closed = await withChatThreadContentBarrierFixture(
        {
          chatThreadId: thread.id,
          stopAt: "identity",
          work: async (barrier) => {
            // The send succeeds while the subject is still open, so the run
            // itself is admitted by its own existing barrier. Only the eager
            // title's capture transaction is paused, before it admits anything.
            await accept(
              chat.requestSendEvent(
                actor,
                {
                  agentId: agent.agentId,
                  threadId: thread.id,
                  prompt: PROMPT,
                  model: "claude-sonnet-5",
                },
                [201],
              ),
              [201],
            );
            const draining = flushWaitUntilForTest();
            await barrier.entered;
            const closing = closeErasureSubjectFixture({
              subjectKind: "user",
              subjectId: actor.userId,
            });
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

      // The closure committed before admission, so generation never began: the
      // provider was never called and the thread stayed untitled.
      expect(titleRequests).toBe(0);
      await expect(
        chat.readThreadMetadata(actor, thread.id),
      ).resolves.toMatchObject({ title: null });
    },
    BARRIER_TIMEOUT_MS,
  );

  it(
    "makes a closure wait for an admitted late title and fences the next one",
    async () => {
      const paused = await pauseGeneratedTitle();
      const unrelated = await pauseGeneratedTitle();
      await paused.entered;
      await unrelated.entered;
      const lastSeqId = await lastSidebarSeqId(paused);

      const closed = await withChatThreadContentBarrierFixture(
        {
          chatThreadId: paused.threadId,
          stopAt: "commit",
          work: async (barrier) => {
            paused.release();
            const draining = flushWaitUntilForTest();
            const settings = await barrier.entered;
            // The late persistence runs under the fence's own bounded budget,
            // not under an unbounded background wait.
            expect(settings.lockTimeout).toBe("1s");
            expect(settings.statementTimeout).toBe("5s");

            const closing = closeErasureSubjectFixture({
              subjectKind: "user",
              subjectId: paused.actor.userId,
            });
            // The admitted writer still holds its shared subject barrier with the
            // title, the sequence and the renamed event already written, so the
            // exclusive closure cannot commit ahead of it.
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);

            // An unrelated owner's own late title is not serialized behind it.
            await unrelated.complete();
            await expect(unrelated.title()).resolves.toBe(GENERATED_TITLE);

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
      await expect(paused.renames()).resolves.toStrictEqual([
        { seqId: lastSeqId + 1, title: GENERATED_TITLE },
      ]);
      // The closure that waited now fences the next write on the same thread.
      await chat.requestRenameThread(
        paused.actor,
        paused.threadId,
        "Post closure title",
        [404],
      );
      await expect(paused.title()).resolves.toBe(GENERATED_TITLE);
    },
    BARRIER_TIMEOUT_MS,
  );

  it("discards a title whose Agent owner moves inside the same organization", async () => {
    const paused = await pauseGeneratedTitle();
    await paused.entered;
    const lastSeqId = await lastSidebarSeqId(paused);

    // Same organization, same thread user: only `agents.owner` moves, which a
    // check limited to user and organization would not notice.
    const survivor = `user_${randomUUID()}`;
    await transferAgentOwnerFixture({
      agentId: paused.agentId,
      owner: survivor,
    });
    await paused.complete();

    await expect(paused.title()).resolves.toBeNull();
    await expect(paused.renames()).resolves.toStrictEqual([]);
    await expectSequenceUnconsumed(paused, lastSeqId);
  });

  it("discards a title whose Agent moves to another organization", async () => {
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
  });

  it("recreates nothing for a thread deleted during the provider request", async () => {
    const paused = await pauseGeneratedTitle();
    await paused.entered;
    await chat.deleteThread(paused.actor, paused.threadId);

    await paused.complete();

    await chat.requestReadThread(paused.actor, paused.threadId, [404]);
    await expect(paused.renames()).resolves.toStrictEqual([]);
  });

  it(
    "re-resolves an owner that moves between identity selection and the retained locks",
    async () => {
      const paused = await pauseGeneratedTitle();
      await paused.entered;
      const lastSeqId = await lastSidebarSeqId(paused);

      await withChatThreadContentBarrierFixture(
        {
          chatThreadId: paused.threadId,
          stopAt: "agent-lock",
          work: async (barrier) => {
            paused.release();
            const draining = flushWaitUntilForTest();
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
      await expect(paused.title()).resolves.toBeNull();
      await expect(paused.renames()).resolves.toStrictEqual([]);
      await expectSequenceUnconsumed(paused, lastSeqId);
    },
    BARRIER_TIMEOUT_MS,
  );

  it("lets a manual rename win over a late generated title", async () => {
    const paused = await pauseGeneratedTitle();
    await paused.entered;
    await chat.renameThread(paused.actor, paused.threadId, "Manual title");

    await paused.complete();

    await expect(paused.title()).resolves.toBe("Manual title");
    await expect(paused.renames()).resolves.toStrictEqual([
      { seqId: expect.any(Number), title: "Manual title" },
    ]);
  });

  it("appends one renamed event when a second send races the same late title", async () => {
    const paused = await pauseGeneratedTitle();
    await paused.entered;

    // A second send on the same thread schedules its own title generation. It
    // also appends its own sidebar event, so it consumes a sequence id of its
    // own before the late title reaches one: what this case pins is that the
    // two racing completions together append exactly one `renamed` event.
    await accept(
      chat.requestSendEvent(
        paused.actor,
        {
          agentId: paused.agentId,
          threadId: paused.threadId,
          prompt: "And the rollout plan",
        },
        [201],
      ),
      [201],
    );
    await paused.complete();

    await expect(paused.title()).resolves.toBe(GENERATED_TITLE);
    await expect(paused.renames()).resolves.toStrictEqual([
      { seqId: expect.any(Number), title: GENERATED_TITLE },
    ]);
  });

  it("rolls a blocked late title back completely instead of reporting a closure", async () => {
    const paused = await pauseGeneratedTitle();
    await paused.entered;
    const lastSeqId = await lastSidebarSeqId(paused);

    const holder = await holdChatThreadRowLockFixture({
      threadId: paused.threadId,
      signal: context.signal,
    });
    // The fenced transaction blocks on the held parent row and fails on its own
    // `1s` lock timeout. That is a real database failure, not an erasure.
    await paused.complete();
    holder.release();
    await holder.done;

    await expect(paused.title()).resolves.toBeNull();
    await expect(paused.renames()).resolves.toStrictEqual([]);
    // Nothing was written and nothing was consumed: the owner is untouched and
    // its next accepted rename still takes the very next sequence id.
    await expectSequenceUnconsumed(paused, lastSeqId);
  });
});
