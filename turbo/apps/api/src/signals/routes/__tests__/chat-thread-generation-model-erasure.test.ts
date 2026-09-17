import { randomUUID } from "node:crypto";

import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { createStore } from "ccstate";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
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
  setChatThreadAgentFixture,
  withChatThreadContentBarrierFixture,
} from "../../../test-fixtures/chat-thread-content-erasure";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedOrgMembership$ } from "./helpers/org-membership";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const api = createRunsApi(context);
const BLOCKED = { interval: 10, timeout: 10_000 } as const;

interface GenerationModelFixture {
  readonly actor: ApiTestUser;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
}

/** Creates an org route, an Agent and a chat thread through the product
 * routes, so every later pin write is an ordinary client write. */
async function createGenerationModelFixture(
  title: string,
): Promise<GenerationModelFixture> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const { providerId } = await api.ensureOrgModelProvider(actor);
  await api.updateOrgModelPolicies(actor, [
    {
      model: "claude-sonnet-5",
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
  ]);
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat thread generation model agent",
    visibility: "private",
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title,
    model: "claude-sonnet-5",
  });
  const { orgId } = actor;
  if (!orgId) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  await store.set(
    seedOrgMembership$,
    { orgId, userId: actor.userId },
    context.signal,
  );
  return {
    actor,
    userId: actor.userId,
    orgId,
    agentId: agent.agentId,
    threadId: thread.id,
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

interface EventIdOption {
  readonly eventId?: string;
}

type PinStatus = 204 | 400 | 401 | 403 | 404;

/**
 * One of the two direct generation-model settings writers. Each entry binds its
 * own catalog literals, so the shared cases below never pass an image model to
 * the video route or the other way round, and the barrier stop identifies which
 * endpoint's pin `UPDATE` a test pauses on.
 */
interface GenerationModelEndpoint {
  readonly label: string;
  readonly kind: "image_model_updated" | "video_model_updated";
  readonly barrierStop: "image-model-update" | "video-model-update";
  readonly pinKey: "selectedImageModel" | "selectedVideoModel";
  readonly baselineModel: string;
  readonly nextModel: string;
  /** The accepted `nextModel` pin write. */
  readonly pinNext: (
    actor: ApiTestUser,
    threadId: string,
    options?: EventIdOption,
  ) => Promise<void>;
  readonly requestPinNext: (
    actor: ApiTestUser | null,
    threadId: string,
    statuses: readonly PinStatus[],
    options?: EventIdOption,
  ) => Promise<{ readonly status: number }>;
  readonly pinBaseline: (actor: ApiTestUser, threadId: string) => Promise<void>;
  /** The same `nextModel` pin driven through an app whose operation signal the
   * caller owns, returned unnarrowed so a cancelled operation's off-contract
   * response can be asserted. */
  readonly pinNextWithOperationSignal: (
    signal: AbortSignal,
    actor: ApiTestUser,
    threadId: string,
  ) => Promise<unknown>;
  /** The pin a production metadata reader returns for this endpoint. */
  readonly pinOf: (pins: GenerationModelPins) => string | null;
}

interface GenerationModelPins {
  readonly selectedImageModel: string | null;
  readonly selectedVideoModel: string | null;
}

function imageEndpoint(): GenerationModelEndpoint {
  return {
    label: "image",
    kind: "image_model_updated",
    barrierStop: "image-model-update",
    pinKey: "selectedImageModel",
    baselineModel: "gpt-image-2",
    nextModel: "fal-ai/qwen-image",
    async pinNext(actor, threadId, options) {
      await chat.updateThreadImageModel(
        actor,
        threadId,
        "fal-ai/qwen-image",
        options,
      );
    },
    async requestPinNext(actor, threadId, statuses, options) {
      return await chat.requestUpdateThreadImageModel(
        actor,
        threadId,
        "fal-ai/qwen-image",
        statuses,
        options,
      );
    },
    async pinBaseline(actor, threadId) {
      await chat.updateThreadImageModel(actor, threadId, "gpt-image-2");
    },
    async pinNextWithOperationSignal(signal, actor, threadId) {
      return await chat
        .generationModelWritesWithOperationSignal(signal)
        .updateImageModel(actor, threadId, "fal-ai/qwen-image");
    },
    pinOf(pins) {
      return pins.selectedImageModel;
    },
  };
}

function videoEndpoint(): GenerationModelEndpoint {
  return {
    label: "video",
    kind: "video_model_updated",
    barrierStop: "video-model-update",
    pinKey: "selectedVideoModel",
    baselineModel: "MiniMax-H3",
    nextModel: "fal-ai/veo3.1/fast",
    async pinNext(actor, threadId, options) {
      await chat.updateThreadVideoModel(
        actor,
        threadId,
        "fal-ai/veo3.1/fast",
        options,
      );
    },
    async requestPinNext(actor, threadId, statuses, options) {
      return await chat.requestUpdateThreadVideoModel(
        actor,
        threadId,
        "fal-ai/veo3.1/fast",
        statuses,
        options,
      );
    },
    async pinBaseline(actor, threadId) {
      await chat.updateThreadVideoModel(actor, threadId, "MiniMax-H3");
    },
    async pinNextWithOperationSignal(signal, actor, threadId) {
      return await chat
        .generationModelWritesWithOperationSignal(signal)
        .updateVideoModel(actor, threadId, "fal-ai/veo3.1/fast");
    },
    pinOf(pins) {
      return pins.selectedVideoModel;
    },
  };
}

function generationModelEndpoints(): readonly GenerationModelEndpoint[] {
  return [imageEndpoint(), videoEndpoint()];
}

async function readEventPage(fixture: GenerationModelFixture) {
  const response = await chat.requestThreadEvents(fixture.actor, {}, [200]);
  if (!("events" in response.body)) {
    throw new Error("Expected the sidebar event page");
  }
  return response.body.events;
}

interface GenerationModelEvent {
  readonly seqId: number;
  readonly kind: string;
}

/** Both routes' durable sidebar events for this thread, as a client reads
 * them. One accepted update appends exactly one, so it consumes exactly one
 * sequence id. */
async function generationModelEvents(
  fixture: GenerationModelFixture,
): Promise<readonly GenerationModelEvent[]> {
  return (await readEventPage(fixture))
    .filter((event) => {
      return (
        (event.kind === "image_model_updated" ||
          event.kind === "video_model_updated") &&
        event.chatThreadId === fixture.threadId
      );
    })
    .map((event) => {
      return { seqId: event.seqId, kind: event.kind };
    });
}

async function eventIds(
  fixture: GenerationModelFixture,
): Promise<readonly string[]> {
  return (await readEventPage(fixture)).map((event) => {
    return event.id;
  });
}

/** The last sequence id this actor's sidebar stream has consumed, whichever
 * event kind consumed it, so a denied write is measured against the whole
 * durable sequence rather than only these two kinds. */
async function lastStreamSeqId(
  fixture: GenerationModelFixture,
): Promise<number> {
  const seqId = (await readEventPage(fixture)).at(-1)?.seqId;
  if (seqId === undefined) {
    throw new Error("Expected at least one durable thread event");
  }
  return seqId;
}

/** Both pins a production metadata reader returns, so a denied write to one
 * endpoint also proves it did not disturb the other. */
async function readPins(
  fixture: GenerationModelFixture,
): Promise<GenerationModelPins> {
  const metadata = await chat.readThreadMetadata(
    fixture.actor,
    fixture.threadId,
  );
  return {
    selectedImageModel: metadata.selectedImageModel,
    selectedVideoModel: metadata.selectedVideoModel,
  };
}

/**
 * The thread's `updated_at`, which both routes set alongside their pin. No chat
 * thread read contract returns it, so
 * {@link readChatThreadTitleStateFixture} — a read-only fixture that already
 * exists for exactly this gap — is what proves a denied or rolled back pin left
 * the timestamp alone.
 */
async function readUpdatedAt(fixture: GenerationModelFixture): Promise<string> {
  return (await readChatThreadTitleStateFixture(fixture.threadId)).updatedAt;
}

/** The `threadListChanged` invalidations published so far, counted from a
 * cleared mock so an earlier setup write is never attributed to this one. */
function threadListInvalidations(): number {
  return context.mocks.ably.publish.mock.calls.filter((call) => {
    return call[0] === "threadListChanged";
  }).length;
}

async function flushedInvalidations(): Promise<number> {
  await flushWaitUntilForTest();
  return threadListInvalidations();
}

describe.each(generationModelEndpoints())(
  "account erasure fences direct chat-thread $label model writes",
  (endpoint) => {
    it("denies the pin for a closed thread user and keeps the pin, timestamp, event and sequence", async () => {
      const fixture = await createGenerationModelFixture(
        `Closed user ${endpoint.label}`,
      );
      await endpoint.pinBaseline(fixture.actor, fixture.threadId);
      const before = await generationModelEvents(fixture);
      const pins = await readPins(fixture);
      expect(endpoint.pinOf(pins)).toBe(endpoint.baselineModel);
      const updatedAt = await readUpdatedAt(fixture);
      const lastSeqId = await lastStreamSeqId(fixture);

      const closed = await closeSubject({
        subjectKind: "user",
        subjectId: fixture.userId,
      });

      context.mocks.ably.publish.mockClear();
      await endpoint.requestPinNext(fixture.actor, fixture.threadId, [404]);

      await expect(readPins(fixture)).resolves.toStrictEqual(pins);
      await expect(readUpdatedAt(fixture)).resolves.toBe(updatedAt);
      await expect(generationModelEvents(fixture)).resolves.toStrictEqual(
        before,
      );
      await expect(flushedInvalidations()).resolves.toBe(0);

      // The denied attempt left the durable sequence untouched, so the next
      // accepted pin takes the very next sidebar sequence id.
      await removeErasureSubjectsFixture([closed.jobId]);
      await endpoint.pinNext(fixture.actor, fixture.threadId);
      const after = await generationModelEvents(fixture);
      expect(after.slice(before.length)).toStrictEqual([
        { seqId: lastSeqId + 1, kind: endpoint.kind },
      ]);
      await expect(readPins(fixture)).resolves.toMatchObject({
        [endpoint.pinKey]: endpoint.nextModel,
      });
    });

    it("denies the pin for a closed distinct Agent owner and for a closed organization", async () => {
      const shared = await createGenerationModelFixture(
        `Shared owner ${endpoint.label}`,
      );
      const sharedBefore = await readPins(shared);
      const sharedOwner = `user_${randomUUID()}`;
      await transferAgentOwnerFixture({
        agentId: shared.agentId,
        owner: sharedOwner,
      });
      await closeSubject({ subjectKind: "user", subjectId: sharedOwner });

      await endpoint.requestPinNext(shared.actor, shared.threadId, [404]);
      await expect(readPins(shared)).resolves.toStrictEqual(sharedBefore);
      await expect(generationModelEvents(shared)).resolves.toStrictEqual([]);

      const organization = await createGenerationModelFixture(
        `Closed org ${endpoint.label}`,
      );
      const organizationBefore = await readPins(organization);
      await closeSubject({
        subjectKind: "organization",
        subjectId: organization.orgId,
      });

      await endpoint.requestPinNext(
        organization.actor,
        organization.threadId,
        [404],
      );
      await expect(readPins(organization)).resolves.toStrictEqual(
        organizationBefore,
      );
      await expect(generationModelEvents(organization)).resolves.toStrictEqual(
        [],
      );

      // An unrelated owner is untouched by either closure.
      const unrelated = await createGenerationModelFixture(
        `Unrelated ${endpoint.label}`,
      );
      await endpoint.pinNext(unrelated.actor, unrelated.threadId);
      await expect(readPins(unrelated)).resolves.toMatchObject({
        [endpoint.pinKey]: endpoint.nextModel,
      });
    });

    it("makes a closure wait for an admitted pin and fences the next one", async () => {
      const fixture = await createGenerationModelFixture(
        `Admitted ${endpoint.label}`,
      );
      const unrelated = await createGenerationModelFixture(
        `Unrelated admitted ${endpoint.label}`,
      );
      const before = await readPins(fixture);
      const baselineEvents = await generationModelEvents(fixture);
      const lastSeqId = await lastStreamSeqId(fixture);
      context.mocks.ably.publish.mockClear();
      context.mocks.ably.channelGet.mockClear();

      const closed = await withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "commit",
          work: async (barrier) => {
            const pinning = endpoint.pinNext(fixture.actor, fixture.threadId);
            const settings = await barrier.entered;
            expect(settings.lockTimeout).toBe("1s");
            expect(settings.statementTimeout).toBe("5s");

            const closing = closeErasureSubjectFixture({
              subjectKind: "user",
              subjectId: fixture.userId,
            });
            // The admitted writer still holds its shared subject barrier with
            // the pin, the durable sequence and the sidebar event already
            // written, so the exclusive closure cannot commit ahead of it.
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);

            // A separate reader still sees the baseline pin and no new event,
            // and no invalidation has escaped to any tab.
            await expect(readPins(fixture)).resolves.toStrictEqual(before);
            await expect(generationModelEvents(fixture)).resolves.toStrictEqual(
              baselineEvents,
            );
            await expect(flushedInvalidations()).resolves.toBe(0);

            // An unrelated owner is not serialized behind that barrier.
            await endpoint.pinNext(unrelated.actor, unrelated.threadId);

            barrier.release();
            await pinning;
            return await closing;
          },
        },
        context.signal,
      );
      onTestFinished(async () => {
        await removeErasureSubjectsFixture([closed.jobId]);
      });

      const admitted = await generationModelEvents(fixture);
      expect(admitted.slice(baselineEvents.length)).toStrictEqual([
        { seqId: lastSeqId + 1, kind: endpoint.kind },
      ]);
      await expect(readPins(fixture)).resolves.toMatchObject({
        [endpoint.pinKey]: endpoint.nextModel,
      });
      // The accepted write published exactly one invalidation, on this
      // caller's own admitted user/org channel.
      await flushWaitUntilForTest();
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        "threadListChanged",
        null,
      );
      expect(context.mocks.ably.channelGet.mock.calls).toContainEqual([
        `user-org:${fixture.userId}:${fixture.orgId}`,
      ]);

      // The closure landed behind the admitted write, so the next pin is
      // rejected and changes nothing.
      const pinned = await readPins(fixture);
      await endpoint.requestPinNext(fixture.actor, fixture.threadId, [404]);
      await expect(readPins(fixture)).resolves.toStrictEqual(pinned);
      await expect(generationModelEvents(fixture)).resolves.toStrictEqual(
        admitted,
      );
    });

    it("rolls the pin, the timestamp and the sequence back when the event insert conflicts", async () => {
      const fixture = await createGenerationModelFixture(
        `Rolled back ${endpoint.label}`,
      );
      await endpoint.pinBaseline(fixture.actor, fixture.threadId);
      const before = await generationModelEvents(fixture);
      const pins = await readPins(fixture);
      const updatedAt = await readUpdatedAt(fixture);
      const lastSeqId = await lastStreamSeqId(fixture);

      const eventId = randomUUID();
      const holder = await holdChatThreadEventIdFixture({
        eventId,
        userId: fixture.userId,
        orgId: fixture.orgId,
        chatThreadId: fixture.threadId,
        signal: context.signal,
      });
      context.mocks.ably.publish.mockClear();
      // The pin `UPDATE` has already run and the durable sequence is already
      // reserved when the append blocks on the held event id and fails on its
      // own bounded budget. A genuine transaction failure is neither a 204 nor
      // the closure 404.
      await expect(
        endpoint.requestPinNext(fixture.actor, fixture.threadId, [204, 404], {
          eventId,
        }),
      ).rejects.toThrow(/Unknown response status 500/);
      holder.release();
      await holder.done;

      await expect(readPins(fixture)).resolves.toStrictEqual(pins);
      await expect(readUpdatedAt(fixture)).resolves.toBe(updatedAt);
      await expect(generationModelEvents(fixture)).resolves.toStrictEqual(
        before,
      );
      await expect(eventIds(fixture)).resolves.not.toContain(eventId);
      await expect(flushedInvalidations()).resolves.toBe(0);

      // The reserved sequence was not consumed, so the next accepted pin still
      // takes the very next sidebar sequence id.
      await endpoint.pinNext(fixture.actor, fixture.threadId);
      const after = await generationModelEvents(fixture);
      expect(after.slice(before.length)).toStrictEqual([
        { seqId: lastSeqId + 1, kind: endpoint.kind },
      ]);
    });

    it("rolls the pin back when the operation is cancelled after the pin UPDATE", async () => {
      const fixture = await createGenerationModelFixture(
        `Cancelled ${endpoint.label}`,
      );
      await endpoint.pinBaseline(fixture.actor, fixture.threadId);
      const before = await readPins(fixture);
      const baselineEvents = await generationModelEvents(fixture);
      const updatedAt = await readUpdatedAt(fixture);
      const controller = new AbortController();
      context.mocks.ably.publish.mockClear();

      await withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: endpoint.barrierStop,
          work: async (barrier) => {
            const pinning = endpoint.pinNextWithOperationSignal(
              controller.signal,
              fixture.actor,
              fixture.threadId,
            );
            const entered = await barrier.entered;
            // The pin `UPDATE` already changed its row, so this is not a
            // pre-write lock timeout, and the baseline pin is still what any
            // other caller reads.
            expect(entered.rowCount).toBe(1);
            await expect(readPins(fixture)).resolves.toStrictEqual(before);

            controller.abort(new DOMException("Operation ended", "AbortError"));
            barrier.release();
            // A cancelled operation keeps its own failure: neither the accepted
            // 204 nor the closure 404.
            await expect(pinning).rejects.toThrow(
              /Unknown response status 500/,
            );
          },
        },
        context.signal,
      );

      await expect(readPins(fixture)).resolves.toStrictEqual(before);
      await expect(readUpdatedAt(fixture)).resolves.toBe(updatedAt);
      await expect(generationModelEvents(fixture)).resolves.toStrictEqual(
        baselineEvents,
      );
      await expect(flushedInvalidations()).resolves.toBe(0);

      // A rolled back attempt is not a durable denial: the same request is
      // accepted once its operation is no longer cancelled.
      await endpoint.pinNext(fixture.actor, fixture.threadId);
      await expect(readPins(fixture)).resolves.toMatchObject({
        [endpoint.pinKey]: endpoint.nextModel,
      });
    });

    it("finds a thread deleted under the locks and writes no pin", async () => {
      const fixture = await createGenerationModelFixture(
        `Deleted ${endpoint.label}`,
      );
      context.mocks.ably.publish.mockClear();

      const pinned = await withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "agent-lock",
          work: async (barrier) => {
            const pinning = endpoint.requestPinNext(
              fixture.actor,
              fixture.threadId,
              [404],
            );
            await barrier.entered;
            await chat.deleteThread(fixture.actor, fixture.threadId);
            // The deletion publishes its own invalidation; clear it so the
            // count below measures only what the resumed pin attempt does.
            await flushWaitUntilForTest();
            context.mocks.ably.publish.mockClear();
            barrier.release();
            return await pinning;
          },
        },
        context.signal,
      );

      // The thread vanished under the retained locks, so the attempt resolved
      // as the route's existing not-found and restored nothing.
      expect(pinned.status).toBe(404);
      const readBack = await chat.requestReadThread(
        fixture.actor,
        fixture.threadId,
        [404],
      );
      expect(readBack.status).toBe(404);
      await expect(flushedInvalidations()).resolves.toBe(0);
    });

    it("propagates a held parent lock as a failure rather than a closure 404", async () => {
      const fixture = await createGenerationModelFixture(
        `Blocked ${endpoint.label}`,
      );
      await endpoint.pinBaseline(fixture.actor, fixture.threadId);
      const before = await readPins(fixture);

      const holder = await holdChatThreadRowLockFixture({
        threadId: fixture.threadId,
        signal: context.signal,
      });
      await expect(
        endpoint.requestPinNext(fixture.actor, fixture.threadId, [204, 404]),
      ).rejects.toThrow(/Unknown response status 500/);
      holder.release();
      await holder.done;

      await expect(readPins(fixture)).resolves.toStrictEqual(before);
      await endpoint.pinNext(fixture.actor, fixture.threadId);
      await expect(readPins(fixture)).resolves.toMatchObject({
        [endpoint.pinKey]: endpoint.nextModel,
      });
    });

    it("keeps the existing 404 for a wrong user, a missing thread and a null Agent", async () => {
      const fixture = await createGenerationModelFixture(
        `Denied ${endpoint.label}`,
      );
      const stranger = await createGenerationModelFixture(
        `Stranger ${endpoint.label}`,
      );
      await endpoint.pinBaseline(fixture.actor, fixture.threadId);
      const before = await readPins(fixture);
      const baselineEvents = await generationModelEvents(fixture);

      await endpoint.requestPinNext(stranger.actor, fixture.threadId, [404]);
      await endpoint.requestPinNext(fixture.actor, randomUUID(), [404]);

      await setChatThreadAgentFixture({
        chatThreadId: fixture.threadId,
        agentId: null,
      });
      await endpoint.requestPinNext(fixture.actor, fixture.threadId, [404]);
      await setChatThreadAgentFixture({
        chatThreadId: fixture.threadId,
        agentId: fixture.agentId,
      });

      await expect(readPins(fixture)).resolves.toStrictEqual(before);
      await expect(generationModelEvents(fixture)).resolves.toStrictEqual(
        baselineEvents,
      );
    });
  },
);

/**
 * Canonical-parent movement is split across the two routes rather than repeated
 * on both: the shared helper resolves, admits and revalidates one identity for
 * either endpoint, and both already carry the three-subject closure matrix and
 * the writer-first case above.
 *
 * | Case                              | Endpoint |
 * | --------------------------------- | -------- |
 * | Agent owner transfer under locks  | image    |
 * | Agent organization move under locks | video  |
 * | Thread deletion under locks       | both     |
 */
describe("account erasure re-resolves moved parents for the generation model routes", () => {
  it("re-resolves a transferred Agent owner instead of pinning an image model under a stale label", async () => {
    const image = imageEndpoint();
    const fixture = await createGenerationModelFixture("Transferred owner");
    await image.pinBaseline(fixture.actor, fixture.threadId);
    const before = await readPins(fixture);
    const baselineEvents = await generationModelEvents(fixture);
    const newOwner = `user_${randomUUID()}`;
    await closeSubject({ subjectKind: "user", subjectId: newOwner });
    context.mocks.ably.publish.mockClear();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "agent-lock",
        work: async (barrier) => {
          const pinning = image.requestPinNext(
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
          await pinning;
        },
      },
      context.signal,
    );

    // The retry reselected the moved owner, admitted it and found it closed, so
    // nothing was written under the stale label and nothing was published.
    await expect(readPins(fixture)).resolves.toStrictEqual(before);
    await expect(generationModelEvents(fixture)).resolves.toStrictEqual(
      baselineEvents,
    );
    await expect(flushedInvalidations()).resolves.toBe(0);
  });

  it("re-resolves a changed Agent organization and never publishes a video pin to the stale one", async () => {
    const video = videoEndpoint();
    const fixture = await createGenerationModelFixture("Moved organization");
    await video.pinBaseline(fixture.actor, fixture.threadId);
    const before = await readPins(fixture);
    const baselineEvents = await generationModelEvents(fixture);
    const newOrgId = `org_${randomUUID()}`;
    await closeSubject({ subjectKind: "organization", subjectId: newOrgId });
    context.mocks.ably.publish.mockClear();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "agent-lock",
        work: async (barrier) => {
          const pinning = video.requestPinNext(
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
          await pinning;
        },
      },
      context.signal,
    );

    await expect(flushedInvalidations()).resolves.toBe(0);
    await transferAgentOrganizationFixture({
      agentId: fixture.agentId,
      orgId: fixture.orgId,
    });
    await expect(readPins(fixture)).resolves.toStrictEqual(before);
    await expect(generationModelEvents(fixture)).resolves.toStrictEqual(
      baselineEvents,
    );
  });
});

describe("the fenced generation model routes keep their own write semantics", () => {
  it("clears each pin on a null model and keeps the client event id", async () => {
    const fixture = await createGenerationModelFixture("Cleared pins");
    const imageEventId = randomUUID();
    const videoEventId = randomUUID();

    await chat.updateThreadImageModel(fixture.actor, fixture.threadId, null, {
      eventId: imageEventId,
    });
    await chat.updateThreadVideoModel(fixture.actor, fixture.threadId, null, {
      eventId: videoEventId,
    });

    const page = await readEventPage(fixture);
    expect(page).toContainEqual(
      expect.objectContaining({
        id: imageEventId,
        kind: "image_model_updated",
        selectedImageModel: null,
      }),
    );
    expect(page).toContainEqual(
      expect.objectContaining({
        id: videoEventId,
        kind: "video_model_updated",
        selectedVideoModel: null,
      }),
    );
  });

  it("reuses a caller event id so a retry appends once on each route", async () => {
    const fixture = await createGenerationModelFixture("Repeated event ids");
    const imageEventId = randomUUID();
    const videoEventId = randomUUID();

    for (const _attempt of [0, 1]) {
      await imageEndpoint().pinNext(fixture.actor, fixture.threadId, {
        eventId: imageEventId,
      });
      await videoEndpoint().pinNext(fixture.actor, fixture.threadId, {
        eventId: videoEventId,
      });
    }

    await expect(generationModelEvents(fixture)).resolves.toStrictEqual([
      { seqId: expect.any(Number), kind: "image_model_updated" },
      { seqId: expect.any(Number), kind: "video_model_updated" },
    ]);
  });

  it("lands concurrent image and video pins on one thread without losing either", async () => {
    const fixture = await createGenerationModelFixture("Concurrent pins");
    const lastSeqId = await lastStreamSeqId(fixture);

    // Both writers hold the helper's retained `FOR KEY SHARE` on this thread.
    // The pin `UPDATE` takes `FOR NO KEY UPDATE`, which is compatible with
    // that, so they serialize on the thread row instead of deadlocking on a
    // key-lock upgrade.
    await Promise.all([
      imageEndpoint().pinNext(fixture.actor, fixture.threadId),
      videoEndpoint().pinNext(fixture.actor, fixture.threadId),
    ]);

    await expect(readPins(fixture)).resolves.toStrictEqual({
      selectedImageModel: imageEndpoint().nextModel,
      selectedVideoModel: videoEndpoint().nextModel,
    });
    const events = await generationModelEvents(fixture);
    expect(
      events.map((event) => {
        return event.seqId;
      }),
    ).toStrictEqual([lastSeqId + 1, lastSeqId + 2]);
  });
});
