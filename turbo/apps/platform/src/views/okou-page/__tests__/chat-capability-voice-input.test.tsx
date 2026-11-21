import { findEnabledButton } from "./chat-run-test-fixtures.ts";
import { voiceIoPolishSegmentsContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { HttpResponse } from "msw";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
async function openConversation() {
  const reply = "The launch update is scheduled for the team.";
  createChatCapabilityHelpers(context).installCapabilityChat({
    events: completedConversation("The launch plan has been approved.", reply),
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText(reply);
  return await screen.findByRole("textbox", { name: "Message" });
}
async function record() {
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
}
function positionCaret(editor: HTMLElement, offset: number) {
  editor.focus();
  const node = editor.querySelector("p")!.firstChild!;
  window.getSelection()!.collapse(node, offset);
  fireEvent(document, new Event("selectionchange"));
  fireEvent.mouseUp(editor);
}
test("chat-capability-voice-input-003 inserts the polished launch update at the chosen caret and accepts more typing there", async () => {
  const response = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({ rms: 0.12 });
  context.mocks.http.post(
    "*" + voiceIoTranscribeContract.segment.path,
    async () => {
      await response.promise;
      return HttpResponse.json({
        transcript: "send launch update tomorrow",
        language: "en",
      });
    },
  );
  context.mocks.api(voiceIoPolishSegmentsContract.post, ({ respond }) => {
    return respond(200, { text: "Send the launch update tomorrow." });
  });
  const editor = await openConversation();
  await fill(editor, "Opening  closing");
  positionCaret(editor, 8);
  click(await findEnabledButton("Voice input"));
  const stop = await findEnabledButton("Stop recording");
  positionCaret(editor, editor.textContent!.length);
  click(stop);
  await screen.findByText("Transcribing");
  positionCaret(editor, 8);
  response.resolve();
  await waitFor(() => {
    expect(editor.textContent?.replace(/\s+/gu, " ")).toBe(
      "Opening Send the launch update tomorrow. closing",
    );
  });
  expect(editor).toHaveFocus();
  expect(window.getSelection()?.isCollapsed).toBeTruthy();
  await userEvent.keyboard(" Additional note.");
  expect(editor.textContent?.replace(/\s+/gu, " ")).toBe(
    "Opening Send the launch update tomorrow. Additional note. closing",
  );
});
test("chat-capability-voice-input-004 returns an empty composer after silent audio", async () => {
  context.mocks.browser.voiceInput({
    rms: 0,
    vadProbability: 0,
    onPcmCapture(emit) {
      emit(new Float32Array(16_000));
    },
    finalPcmSamples: new Float32Array(0),
  });
  const editor = await openConversation();
  await record();
  await screen.findByText("No speech detected. Please record again.");
  await expect(findEnabledButton("Voice input")).resolves.toBeEnabled();
  expect(editor.textContent).toBe("");
});
test("chat-capability-voice-input-006 preserves the selected draft on a no-content transcription and accepts replacement text", async () => {
  context.mocks.browser.voiceInput({ rms: 0.12 });
  const noContent = context.mocks.deferred<void>();
  context.mocks.http.post(
    "*" + voiceIoTranscribeContract.segment.path,
    async () => {
      await noContent.promise;
      return new HttpResponse(null, { status: 204 });
    },
  );
  const editor = await openConversation();
  const saved = "Keep the existing draft";
  await fill(editor, saved);
  await userEvent.keyboard("{Control>}a{/Control}");
  await record();
  await screen.findByText("Transcribing");
  noContent.resolve();
  await expect(findEnabledButton("Voice input")).resolves.toBeEnabled();
  expect(editor.textContent).toBe(saved);
  expect(window.getSelection()?.toString()).toBe(saved);
  await expect(findEnabledButton("Add")).resolves.toBeVisible();
  await expect(findEnabledButton("Send")).resolves.toBeEnabled();
  await userEvent.keyboard("New words.");
  expect(editor.textContent).toBe("New words.");
});
