import { DEFAULT_IMAGE_MODEL } from "@okouai/core/image-model-catalog";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  readRunImageModelSnapshotFixture,
  setRetiredOrgMemberImageModelFixture,
} from "../../../test-fixtures/run-image-model";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { clearAllDetached } from "../../utils";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  entitledNativeChatActor,
  sendChatRun,
  sendWaitingChatInput,
  cancelChatRun,
} = createChatEventsFixture(context);

/** The image snapshot is org-scoped, so these tests resolve the org too. */
async function imageModelSnapshotActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly orgId: string;
}> {
  const { actor, agentId } = await entitledNativeChatActor();
  const orgId = actor.orgId;
  if (!orgId) {
    throw new Error("Expected an entitled chat actor to own an org");
  }
  return { actor, agentId, orgId };
}

describe("CHAT-02: run image model snapshot", () => {
  it("resolves the member image model, then the global default, into stable snapshots", async () => {
    const { actor, agentId } = await imageModelSnapshotActor();

    const globalDefault = await sendChatRun(actor, {
      agentId,
      prompt: "image model comes from the global default",
    });
    expect(DEFAULT_IMAGE_MODEL).toBe("gpt-image-2.5-flare");
    await expect(
      readRunImageModelSnapshotFixture(globalDefault.runId),
    ).resolves.toBe(DEFAULT_IMAGE_MODEL);
    const globalDefaultPrompt =
      (await api.readRun(actor, globalDefault.runId)).appendSystemPrompt ?? "";
    expect(globalDefaultPrompt).toContain(
      "Built-in image generation uses `gpt-image-2.5-flare`, from the user's image model setting in Settings › Built-in tools.",
    );
    await cancelChatRun(actor, globalDefault.runId);

    await chat.updateUserModelPreference(actor, null, "fal-ai/flux-pro/v1.1");

    // The member setting is not pinned at thread creation, so an existing
    // thread follows the change on its next run.
    const afterDefaultChanged = await sendChatRun(actor, {
      agentId,
      threadId: globalDefault.threadId,
      prompt: "an existing thread follows the member image model",
    });
    await expect(
      readRunImageModelSnapshotFixture(afterDefaultChanged.runId),
    ).resolves.toBe("fal-ai/flux-pro/v1.1");

    await chat.updateUserModelPreference(actor, null, "fal-ai/nano-banana-2");
    await expect(
      readRunImageModelSnapshotFixture(afterDefaultChanged.runId),
    ).resolves.toBe("fal-ai/flux-pro/v1.1");
    const afterDefaultChangedPrompt =
      (await api.readRun(actor, afterDefaultChanged.runId))
        .appendSystemPrompt ?? "";
    expect(afterDefaultChangedPrompt).toContain("# Built-in image model");
    expect(afterDefaultChangedPrompt).toContain(
      "Built-in image generation uses `flux-pro-1.1`, from the user's image model setting in Settings › Built-in tools.",
    );
    expect(afterDefaultChangedPrompt).toContain(
      "The model cannot be changed per request. Do not pass `--model` to image generation commands.",
    );
    expect(afterDefaultChangedPrompt).toContain(
      "Image generation through a connected third-party service chooses its model separately; this setting does not apply to that path.\n\n# Restricted Explicit Content",
    );
    await cancelChatRun(actor, afterDefaultChanged.runId);

    const afterSecondChange = await sendChatRun(actor, {
      agentId,
      threadId: globalDefault.threadId,
      prompt: "the next run sees the updated member image model",
    });
    await expect(
      readRunImageModelSnapshotFixture(afterSecondChange.runId),
    ).resolves.toBe("fal-ai/nano-banana-2");
    await cancelChatRun(actor, afterSecondChange.runId);
  }, 90_000);

  it("falls through image model IDs that the catalog no longer supports", async () => {
    const { actor, agentId, orgId } = await imageModelSnapshotActor();
    const retiredImageModel = "fal-ai/retired-image-model";

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "anchor run for retired image model storage",
    });
    await cancelChatRun(actor, anchor.runId);

    // Current preference routes reject retired IDs, so this test alone injects
    // the historical stored value whose fallback behavior it exercises.
    await setRetiredOrgMemberImageModelFixture({
      orgId,
      userId: actor.userId,
      retiredImageModel,
    });
    const retiredEverywhere = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt:
        "a retired member image model falls through to the global default",
    });
    await expect(
      readRunImageModelSnapshotFixture(retiredEverywhere.runId),
    ).resolves.toBe(DEFAULT_IMAGE_MODEL);
    await cancelChatRun(actor, retiredEverywhere.runId);
  }, 90_000);

  it("does not persist an image snapshot before dispatch preparation succeeds", async () => {
    const { actor, agentId } = await imageModelSnapshotActor();
    await chat.updateUserModelPreference(actor, null, "gpt-image-2");
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);
    const clientEventId = randomUUID();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        clientEventId,
        prompt: "image snapshot waits for successful run preparation",
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the chat input to be queued");
    }
    await expect(clearAllDetached()).rejects.toThrow(
      "No executor configured: set RUNNER_DEFAULT_GROUP",
    );
    const { events } = await chat.listThreadEvents(actor, sent.body.threadId);
    // The failed pick rejects its input; no run or image snapshot exists.
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: clientEventId,
        error: "internal_error",
      }),
    );
    await expect(
      api.listAgentRuns(actor, {
        status: "queued,pending,running,completed,failed,timeout,cancelled",
        limit: 100,
      }),
    ).resolves.toMatchObject({ runs: [] });
  });

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
