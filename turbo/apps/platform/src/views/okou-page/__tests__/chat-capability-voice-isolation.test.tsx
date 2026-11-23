import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { cleanup, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { findEnabledButton } from "./chat-run-test-fixtures.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";

const context = testContext();

async function visitAs(id: string) {
  const app = createTestRuntime(context);
  await setupPage({
    context: app,
    path: "/",
    auth: { user: { id, fullName: id } },
  });
  return app;
}

test.each(["delivered", "withheld"] as const)(
  "chat-capability-voice-isolation-001 the next member starts with a clean composer while the previous voice model is %s",
  async (response) => {
    const started = context.mocks.deferred<void>();
    const model = context.mocks.deferred<void>();
    const released = context.mocks.deferred<void>();
    context.mocks.browser.voiceInput({
      rms: 0.25,
      vadModelReady() {
        started.resolve();
        return model.promise;
      },
      onVadRelease() {
        released.resolve();
      },
    });
    const original = await visitAs("first-dictating-member");
    click(await findEnabledButton("Voice input"));
    click(await findEnabledButton("Stop recording"));
    await waitFor(() => {
      expect(started.settled()).toBeTruthy();
    });
    cleanup();
    original.dispose();
    try {
      await visitAs("next-dictating-member");
      const editor = await findComposerEditor();
      if (response === "delivered") {
        model.resolve();
      }
      await waitFor(() => {
        expect(released.settled()).toBe(response === "delivered");
      });
      expect(editor.textContent).toBe("");
      expect(queryFastControl("button", "Use recording")).toBeNull();
    } finally {
      if (!model.settled()) {
        model.resolve();
      }
    }
  },
);

test("chat-capability-voice-isolation-002 a new member can start dictation after the previous member's recording failed", async () => {
  context.mocks.browser.voiceInput({ rms: 0.25 });
  context.mocks.http.post("*" + voiceIoTranscribeContract.segment.path, () => {
    return HttpResponse.json(
      { error: { code: "FAILED", message: "Cannot transcribe the recording" } },
      { status: 503 },
    );
  });
  const original = await visitAs("previous-recording-owner");
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await findFastControl("button", "Use recording");
  cleanup();
  original.dispose();
  await visitAs("new-recording-owner");
  await expect(findEnabledButton("Voice input")).resolves.toBeEnabled();
  expect(queryFastControl("button", "Use recording")).toBeNull();
});
