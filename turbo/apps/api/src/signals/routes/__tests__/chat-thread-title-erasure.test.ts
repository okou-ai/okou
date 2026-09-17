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
  // Background title work is drained per case: `flushWaitUntilForTest` is
  // global, so a paused generation left in flight would be awaited by, and
  // counted against, whichever case runs next.
  onTestFinished(async () => {
    release();
    await flushWaitUntilForTest();
  });
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
    "discards a title whose Agent owner moves inside the same organization",
    async () => {
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
    },
    BARRIER_TIMEOUT_MS,
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
    BARRIER_TIMEOUT_MS,
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
    BARRIER_TIMEOUT_MS,
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
    BARRIER_TIMEOUT_MS,
  );

  it(
    "appends one renamed event when a second send races the same late title",
    async () => {
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
    },
    BARRIER_TIMEOUT_MS,
  );
});
