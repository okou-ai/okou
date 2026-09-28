import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_MODEL_ENV,
} from "@okouai/core/image-model-catalog";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  readRunImageModelSnapshotFixture,
  setRetiredChatThreadImageModelFixture,
  setRetiredOrgMemberImageModelFixture,
} from "../../../test-fixtures/run-image-model";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createChatEventsFixture,
  claimEnvironment,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  entitledNativeChatActor,
  sendChatRun,
  sendWaitingChatInput,
  claimChatRun,
  waitForRunStatus,
  cancelChatRun,
} = createChatEventsFixture(context);

/** The image snapshot is org-scoped, so these tests resolve the org too. */
async function imageModelSnapshotActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly orgId: string;
  readonly runnerGroup: string;
}> {
  const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
  const orgId = actor.orgId;
  if (!orgId) {
    throw new Error("Expected an entitled chat actor to own an org");
  }
  return { actor, agentId, orgId, runnerGroup };
}

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

    // The pick creates the run and fails it when dispatch cannot start.
    const sent = await sendChatRun(actor, {
      agentId,
      prompt: "image snapshot survives pre-runner dispatch failure",
    });
    await waitForRunStatus(actor, sent.runId, "failed");
    await expect(readRunImageModelSnapshotFixture(sent.runId)).resolves.toBe(
      "gpt-image-2",
    );
  }, 90_000);

  it("persists the resolved image model on a run picked from the org queue", async () => {
    const { actor, agentId } = await imageModelSnapshotActor();
    await chat.updateUserModelPreference(actor, null, "fal-ai/flux-pro/v1.1");
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");

    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "occupy image snapshot concurrency",
    });
    const waiting = await sendWaitingChatInput(actor, {
      agentId,
      prompt: "queue an image model snapshot",
    });

    await cancelChatRun(actor, blocker.runId);
    await flushWaitUntilForTest();
    const picked = await waiting.launchedRun();
    await expect(readRunImageModelSnapshotFixture(picked.runId)).resolves.toBe(
      "fal-ai/flux-pro/v1.1",
    );

    await cancelChatRun(actor, picked.runId);
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
