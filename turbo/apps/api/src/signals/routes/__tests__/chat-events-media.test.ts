import { randomUUID } from "node:crypto";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_MODEL_ENV,
} from "@okouai/core/image-model-catalog";
import { DEFAULT_VIDEO_MODEL } from "@okouai/core/video-model-catalog";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { setChatThreadVideoModelFixture } from "../../../test-fixtures/chat-thread-events";
import {
  readRunImageModelSnapshotFixture,
  setRetiredChatThreadImageModelFixture,
  setRetiredOrgMemberImageModelFixture,
} from "../../../test-fixtures/run-image-model";
import {
  readRunChatThreadIdFixture,
  readRunVideoModelFixture,
  setOrgMemberVideoModelFixture,
} from "../../../test-fixtures/run-video-model";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createChatEventsFixture,
  claimEnvironment,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  entitledChatActor,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
} = createChatEventsFixture(context);

/** Creation-time pinning is org-scoped, so a video test resolves the org too. */
async function videoModelSelectionActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly orgId: string;
}> {
  const { actor, agentId } = await entitledChatActor();
  const orgId = actor.orgId;
  if (!orgId) {
    throw new Error("Expected an entitled chat actor to own an org");
  }
  return { actor, agentId, orgId };
}

/** The image snapshot is org-scoped, so these tests resolve the org too. */
async function imageModelSnapshotActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly orgId: string;
  readonly runnerGroup: string;
}> {
  const { actor, agentId, runnerGroup } = await entitledChatActor();
  const orgId = actor.orgId;
  if (!orgId) {
    throw new Error("Expected an entitled chat actor to own an org");
  }
  return { actor, agentId, orgId, runnerGroup };
}

describe("CHAT-02: run media model snapshot precedence", () => {
  it("resolves video and image fallback independently", async () => {
    const { actor, agentId } = await videoModelSelectionActor();
    await chat.updateUserModelPreference(
      actor,
      null,
      "gpt-image-2",
      "MiniMax-H3",
    );

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "anchor run for mixed media model precedence",
    });
    await cancelChatRun(actor, anchor.runId);

    await chat.updateThreadVideoModel(
      actor,
      anchor.threadId,
      "fal-ai/veo3.1/fast",
    );
    await chat.updateThreadImageModel(actor, anchor.threadId, null);
    const imageFallback = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "thread video with member image fallback",
    });
    await expect(readRunVideoModelFixture(imageFallback.runId)).resolves.toBe(
      "fal-ai/veo3.1/fast",
    );
    await expect(
      readRunImageModelSnapshotFixture(imageFallback.runId),
    ).resolves.toBe("gpt-image-2");
    await cancelChatRun(actor, imageFallback.runId);

    await chat.updateThreadVideoModel(actor, anchor.threadId, null);
    await chat.updateThreadImageModel(
      actor,
      anchor.threadId,
      "fal-ai/flux-pro/v1.1",
    );
    const videoFallback = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "member video fallback with thread image",
    });
    await expect(readRunVideoModelFixture(videoFallback.runId)).resolves.toBe(
      "MiniMax-H3",
    );
    await expect(
      readRunImageModelSnapshotFixture(videoFallback.runId),
    ).resolves.toBe("fal-ai/flux-pro/v1.1");
    await cancelChatRun(actor, videoFallback.runId);
  }, 90_000);
});

describe("CHAT-02: run video model snapshot", () => {
  it("pins a thread at creation and resolves later runs through that pin", async () => {
    const { actor, agentId, orgId } = await videoModelSelectionActor();

    const catalogDefault = await sendChatRun(actor, {
      agentId,
      prompt: "a thread created with no member default takes the catalog one",
    });
    await expect(readRunVideoModelFixture(catalogDefault.runId)).resolves.toBe(
      DEFAULT_VIDEO_MODEL,
    );
    await cancelChatRun(actor, catalogDefault.runId);

    await setOrgMemberVideoModelFixture({
      orgId,
      userId: actor.userId,
      selectedVideoModel: "MiniMax-H3",
    });

    // The pin the thread already carries survives the new member default. A
    // thread that followed the live default would answer "MiniMax-H3" here.
    const afterDefaultChanged = await sendChatRun(actor, {
      agentId,
      threadId: catalogDefault.threadId,
      prompt: "an existing thread keeps the model it was created with",
    });
    await expect(
      readRunVideoModelFixture(afterDefaultChanged.runId),
    ).resolves.toBe(DEFAULT_VIDEO_MODEL);
    await cancelChatRun(actor, afterDefaultChanged.runId);

    // A thread created after the change does take the new member default.
    const memberDefault = await sendChatRun(actor, {
      agentId,
      prompt: "a thread created later takes the member default",
    });
    await expect(readRunVideoModelFixture(memberDefault.runId)).resolves.toBe(
      "MiniMax-H3",
    );
    await cancelChatRun(actor, memberDefault.runId);

    await setChatThreadVideoModelFixture(
      catalogDefault.threadId,
      "fal-ai/veo3.1/fast",
    );
    const threadPinned = await sendChatRun(actor, {
      agentId,
      threadId: catalogDefault.threadId,
      prompt: "video model comes from the thread pin",
    });
    await expect(readRunVideoModelFixture(threadPinned.runId)).resolves.toBe(
      "fal-ai/veo3.1/fast",
    );

    // Re-pinning while that run is still in flight must not reach it. This is
    // the whole reason the model is snapshotted onto the run instead of being
    // read back off the thread when generation happens.
    await setChatThreadVideoModelFixture(
      catalogDefault.threadId,
      "dreamina-seedance-2-5-260628",
    );
    await expect(readRunVideoModelFixture(threadPinned.runId)).resolves.toBe(
      "fal-ai/veo3.1/fast",
    );
    await cancelChatRun(actor, threadPinned.runId);

    // The next run does pick the re-pinned model up.
    const rePinned = await sendChatRun(actor, {
      agentId,
      threadId: catalogDefault.threadId,
      prompt: "the run after the re-pin uses the new thread pin",
    });
    await expect(readRunVideoModelFixture(rePinned.runId)).resolves.toBe(
      "dreamina-seedance-2-5-260628",
    );
    await cancelChatRun(actor, rePinned.runId);
  }, 90_000);

  it("still follows the member default for a thread that predates the pin", async () => {
    const { actor, agentId, orgId } = await videoModelSelectionActor();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "anchor run that creates the thread",
    });
    await cancelChatRun(actor, anchor.runId);

    // Clearing the pin reproduces the state of a thread created before
    // creation-time pinning. Those rows were deliberately left alone, so they
    // keep reading the live member default.
    await chat.updateThreadVideoModel(actor, anchor.threadId, null);
    await setOrgMemberVideoModelFixture({
      orgId,
      userId: actor.userId,
      selectedVideoModel: "MiniMax-H3",
    });

    const legacy = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "a thread with no pin follows the member default",
    });
    await expect(readRunVideoModelFixture(legacy.runId)).resolves.toBe(
      "MiniMax-H3",
    );
    await cancelChatRun(actor, legacy.runId);
  }, 90_000);

  it("keeps falling back past video models the catalog no longer lists", async () => {
    const { actor, agentId } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an entitled chat actor to own an org");
    }
    // Persisted pins are projected out of jsonb without being re-validated, so
    // a run can start against an id that has since left the catalog.
    const retiredVideoModel = "dreamina-seedance-1-0-retired";

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "anchor run that creates the thread",
    });
    await cancelChatRun(actor, anchor.runId);

    await setOrgMemberVideoModelFixture({
      orgId,
      userId: actor.userId,
      selectedVideoModel: "seedance-1-5-pro-251215",
    });
    await setChatThreadVideoModelFixture(anchor.threadId, retiredVideoModel);
    const retiredThreadPin = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "retired thread pin falls through to the member default",
    });
    await expect(
      readRunVideoModelFixture(retiredThreadPin.runId),
    ).resolves.toBe("seedance-1-5-pro-251215");
    await cancelChatRun(actor, retiredThreadPin.runId);

    await setOrgMemberVideoModelFixture({
      orgId,
      userId: actor.userId,
      selectedVideoModel: retiredVideoModel,
    });
    const retiredEverywhere = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "two retired pins fall through to the catalog default",
    });
    await expect(
      readRunVideoModelFixture(retiredEverywhere.runId),
    ).resolves.toBe(DEFAULT_VIDEO_MODEL);
    await cancelChatRun(actor, retiredEverywhere.runId);

    // `in` on a normal object also matches inherited Object.prototype keys.
    // Persisted strings must match an own catalog id exactly.
    await setOrgMemberVideoModelFixture({
      orgId,
      userId: actor.userId,
      selectedVideoModel: "MiniMax-H3",
    });
    await setChatThreadVideoModelFixture(anchor.threadId, "toString");
    const inheritedObjectKey = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "an inherited object key is not a catalog model",
    });
    await expect(
      readRunVideoModelFixture(inheritedObjectKey.runId),
    ).resolves.toBe("MiniMax-H3");
    await cancelChatRun(actor, inheritedObjectKey.runId);
  }, 90_000);

  it("snapshots a video model onto runs that own no chat thread", async () => {
    const { actor, agentId } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an entitled chat actor to own an org");
    }

    // Non-chat triggers such as telegram leave chat_thread_id null. Those runs
    // have no thread layer to read and must still resolve rather than fail.
    const withoutPreference = await api.createRun(actor, {
      agentId,
      prompt: "threadless run without any video model preference",
      modelProvider: "anthropic-api-key",
    });
    await expect(
      readRunChatThreadIdFixture(withoutPreference.runId),
    ).resolves.toBeNull();
    await expect(
      readRunVideoModelFixture(withoutPreference.runId),
    ).resolves.toBe(DEFAULT_VIDEO_MODEL);
    await cancelChatRun(actor, withoutPreference.runId);

    await setOrgMemberVideoModelFixture({
      orgId,
      userId: actor.userId,
      selectedVideoModel: "MiniMax-H3",
    });
    const withMemberDefault = await api.createRun(actor, {
      agentId,
      prompt: "threadless run picks up the member default",
      modelProvider: "anthropic-api-key",
    });
    await expect(
      readRunChatThreadIdFixture(withMemberDefault.runId),
    ).resolves.toBeNull();
    await expect(
      readRunVideoModelFixture(withMemberDefault.runId),
    ).resolves.toBe("MiniMax-H3");
    await cancelChatRun(actor, withMemberDefault.runId);
  }, 90_000);
});

describe("CHAT-02: run image model snapshot", () => {
  it("resolves thread, member, and global image defaults into stable snapshots", async () => {
    const { actor, agentId, runnerGroup } = await imageModelSnapshotActor();

    const globalDefault = await sendChatRun(actor, {
      agentId,
      prompt: "image model comes from the global default",
    });
    await expect(
      readRunImageModelSnapshotFixture(globalDefault.runId),
    ).resolves.toBe(DEFAULT_IMAGE_MODEL);
    await cancelChatRun(actor, globalDefault.runId);

    await chat.updateUserModelPreference(actor, null, "fal-ai/flux-pro/v1.1");

    // The thread was pinned when it was created, so the new member default
    // does not reach back into it.
    const afterDefaultChanged = await sendChatRun(actor, {
      agentId,
      threadId: globalDefault.threadId,
      prompt: "an existing thread keeps the image model it was created with",
    });
    await expect(
      readRunImageModelSnapshotFixture(afterDefaultChanged.runId),
    ).resolves.toBe(DEFAULT_IMAGE_MODEL);
    await cancelChatRun(actor, afterDefaultChanged.runId);

    const memberDefault = await sendChatRun(actor, {
      agentId,
      prompt: "a thread created later takes the member default",
    });
    await expect(
      readRunImageModelSnapshotFixture(memberDefault.runId),
    ).resolves.toBe("fal-ai/flux-pro/v1.1");
    await cancelChatRun(actor, memberDefault.runId);

    const initialThreadPin = "fal-ai/bytedance/seedream/v4/text-to-image";
    await chat.updateThreadImageModel(
      actor,
      globalDefault.threadId,
      initialThreadPin,
    );
    const threadPinned = await sendChatRun(actor, {
      agentId,
      threadId: globalDefault.threadId,
      prompt: "image model comes from the thread pin",
    });
    await expect(
      readRunImageModelSnapshotFixture(threadPinned.runId),
    ).resolves.toBe(initialThreadPin);

    const nextThreadPin = "fal-ai/nano-banana-2";
    await chat.updateThreadImageModel(
      actor,
      globalDefault.threadId,
      nextThreadPin,
    );
    await expect(
      readRunImageModelSnapshotFixture(threadPinned.runId),
    ).resolves.toBe(initialThreadPin);
    const threadPinnedPrompt =
      (await api.readRun(actor, threadPinned.runId)).appendSystemPrompt ?? "";
    expect(threadPinnedPrompt).toContain("# Default built-in image model");
    expect(threadPinnedPrompt).toContain(
      "This run's default built-in image model is `seedream4`.",
    );
    expect(threadPinnedPrompt).toContain(
      "Only when the current user request explicitly names another supported built-in image model, pass `--model <model>`.",
    );
    expect(threadPinnedPrompt).toContain(
      "Otherwise omit `--model`; the server applies `seedream4`.",
    );
    expect(threadPinnedPrompt).toContain(
      "Image generation through a connected third-party service chooses its model separately; this default does not apply to that path.\n\n# Restricted Explicit Content",
    );
    await cancelChatRun(actor, threadPinned.runId);

    const rePinned = await sendChatRun(actor, {
      agentId,
      threadId: globalDefault.threadId,
      prompt: "the next run sees the updated image model pin",
    });
    await expect(
      readRunImageModelSnapshotFixture(rePinned.runId),
    ).resolves.toBe(nextThreadPin);
    const { claim: rePinnedClaim } = await claimChatRun(
      runnerGroup,
      rePinned.runId,
    );
    expect(claimEnvironment(rePinnedClaim)[DEFAULT_IMAGE_MODEL_ENV]).toBe(
      "nano-banana-2",
    );
    await cancelChatRun(actor, rePinned.runId);
  }, 90_000);

  it("falls through image model IDs that the catalog no longer supports", async () => {
    const { actor, agentId, orgId } = await imageModelSnapshotActor();
    const retiredImageModel = "fal-ai/retired-image-model";

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "anchor run for retired image model storage",
    });
    await cancelChatRun(actor, anchor.runId);

    await chat.updateUserModelPreference(actor, null, "gpt-image-2");
    // Current preference routes reject retired IDs, so this test alone injects
    // the historical stored values whose fallback behavior it exercises.
    await setRetiredChatThreadImageModelFixture(
      anchor.threadId,
      retiredImageModel,
    );
    const retiredThreadPin = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "retired thread image model falls through to the member",
    });
    await expect(
      readRunImageModelSnapshotFixture(retiredThreadPin.runId),
    ).resolves.toBe("gpt-image-2");
    await cancelChatRun(actor, retiredThreadPin.runId);

    await setRetiredOrgMemberImageModelFixture({
      orgId,
      userId: actor.userId,
      retiredImageModel,
    });
    const retiredEverywhere = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "retired image defaults fall through to the global default",
    });
    await expect(
      readRunImageModelSnapshotFixture(retiredEverywhere.runId),
    ).resolves.toBe(DEFAULT_IMAGE_MODEL);
    await cancelChatRun(actor, retiredEverywhere.runId);
  }, 90_000);

  it("persists the image snapshot when dispatch fails before runner start", async () => {
    const { actor, agentId } = await imageModelSnapshotActor();
    await chat.updateUserModelPreference(actor, null, "gpt-image-2");
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);

    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "image snapshot survives pre-runner dispatch failure",
        clientEventId: randomUUID(),
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the failed dispatch to create a run");
    }
    expect(sent.body.status).toBe("failed");
    await expect(
      readRunImageModelSnapshotFixture(sent.body.runId),
    ).resolves.toBe("gpt-image-2");
  }, 90_000);

  it("persists the resolved image model on a queued run", async () => {
    const { actor, agentId } = await imageModelSnapshotActor();
    await chat.updateUserModelPreference(actor, null, "fal-ai/flux-pro/v1.1");
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");

    const blocker = await chat.requestSendEvent(
      actor,
      { agentId, prompt: "occupy image snapshot concurrency" },
      [201],
    );
    if (blocker.status !== 201 || blocker.body.runId === null) {
      throw new Error("Expected the blocking send to create a run");
    }
    expect(blocker.body.status).toBe("pending");

    const queued = await chat.requestSendEvent(
      actor,
      { agentId, prompt: "queue an image model snapshot" },
      [201],
    );
    if (queued.status !== 201 || queued.body.runId === null) {
      throw new Error("Expected the second send to create a queued run");
    }
    expect(queued.body.status).toBe("queued");
    await expect(
      readRunImageModelSnapshotFixture(queued.body.runId),
    ).resolves.toBe("fal-ai/flux-pro/v1.1");

    await cancelChatRun(actor, queued.body.runId);
    await cancelChatRun(actor, blocker.body.runId);
  }, 90_000);

  it("snapshots direct runs and re-resolves on session continuation", async () => {
    const { actor, agentId } = await imageModelSnapshotActor();

    const first = await api.createRun(actor, {
      agentId,
      prompt: "direct image model snapshot",
      modelProvider: "anthropic-api-key",
    });
    await expect(readRunImageModelSnapshotFixture(first.runId)).resolves.toBe(
      DEFAULT_IMAGE_MODEL,
    );

    await chat.updateUserModelPreference(actor, null, "fal-ai/flux-pro/v1.1");
    const resumed = await api.createRun(actor, {
      agentId,
      sessionId: first.sessionId,
      prompt: "continued session image model snapshot",
      modelProvider: "anthropic-api-key",
    });
    expect(resumed.sessionId).toBe(first.sessionId);
    await expect(readRunImageModelSnapshotFixture(resumed.runId)).resolves.toBe(
      "fal-ai/flux-pro/v1.1",
    );
    await expect(readRunImageModelSnapshotFixture(first.runId)).resolves.toBe(
      DEFAULT_IMAGE_MODEL,
    );

    await cancelChatRun(actor, first.runId);
    await cancelChatRun(actor, resumed.runId);
  }, 90_000);
});
