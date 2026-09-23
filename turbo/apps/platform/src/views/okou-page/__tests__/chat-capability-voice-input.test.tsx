import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  assistantEvent,
  context,
  findButton,
  findEnabledButton,
  installRunChat,
  queryButton,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

function installAvailableVoiceQuota(limit: number | null = 60): void {
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: true, count: 0, limit });
  });
}

async function readyVoiceInput(): Promise<HTMLElement> {
  await readyChat();
  return await findEnabledButton("Voice input");
}

function currentComposer(): HTMLElement {
  return screen.getByRole("textbox", { name: "Message" });
}

function normalizedComposerText(): string {
  return currentComposer().textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function captureVoiceTranscriptionErrors(): unknown[][] {
  const errorSpy = vi.spyOn(console, "error");
  const defaultErrorHandler = errorSpy.getMockImplementation();
  if (!defaultErrorHandler) {
    throw new Error("Expected the shared unexpected-console-error guard");
  }
  const errors: unknown[][] = [];
  errorSpy.mockImplementation((...args: unknown[]) => {
    if (
      args[0] === "[E][Composer:VoiceDraft]" ||
      args[0] === "[E][VoiceIO:STT]"
    ) {
      errors.push(args);
      return;
    }
    defaultErrorHandler(...args);
  });
  return errors;
}

async function activeVoiceDraftStopButton(): Promise<HTMLElement> {
  const stop = await findButton("Stop recording");
  await waitFor(() => {
    expect(stop).toBeEnabled();
  });
  expect(stop).toHaveTextContent("Done");
  expect(
    screen.getByText(/^\d{2}:\d{2}$/u, { selector: "time" }),
  ).toBeVisible();
  expect(queryButton("Attach")).toBeNull();
  return stop;
}

function placeCaret(
  composer: HTMLElement,
  textNodeContent: string,
  offset: number,
  endOffset = offset,
): void {
  const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && node.textContent !== textNodeContent) {
    node = walker.nextNode();
  }
  if (!node) {
    throw new Error(`Expected composer text node ${textNodeContent}`);
  }
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, endOffset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  composer.focus();
}

async function setupShortcutTranscription() {
  const requested = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({ rms: 0.12 });
  installAvailableVoiceQuota();
  context.mocks.http.post("*/api/voice-io/transcribe/segment", async () => {
    requested.resolve();
    await response.promise;
    return HttpResponse.json({
      transcript: "um shortcut voice note",
      polishedText: "Shortcut voice note",
      language: "en-US",
    });
  });
  installRunChat();
  await setupPage({ context, path: RUN_PATH });
  const voiceInput = await readyVoiceInput();
  expect(voiceInput).toHaveAttribute(
    "aria-keyshortcuts",
    "Meta+Shift+E Control+Shift+E",
  );
  const composer = currentComposer();
  composer.focus();
  const startEvent = new KeyboardEvent("keydown", {
    key: "e",
    code: "KeyE",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  composer.dispatchEvent(startEvent);
  expect(startEvent.defaultPrevented).toBeTruthy();
  const stopRecording = await activeVoiceDraftStopButton();
  expect(stopRecording).toHaveAttribute(
    "aria-keyshortcuts",
    "Meta+Shift+E Control+Shift+E",
  );
  fireEvent.keyDown(currentComposer(), {
    key: "e",
    code: "KeyE",
    ctrlKey: true,
    shiftKey: true,
  });
  await requested.promise;
  expect(screen.getByRole("status")).toHaveTextContent("Transcribing");
  expect(screen.getByText("Text is taking shape")).toBeVisible();
  expect(queryButton("Stop recording")).toBeNull();
  return response;
}

async function finishShortcutTranscription(
  response: Awaited<ReturnType<typeof setupShortcutTranscription>>,
) {
  response.resolve();
  await waitFor(() => {
    expect(normalizedComposerText()).toBe("Shortcut voice note");
  });
  await findEnabledButton("Voice input");
}

test("Start and stop voice input from the focused composer shortcut", async () => {
  const response = await setupShortcutTranscription();
  await finishShortcutTranscription(response);
  expect(normalizedComposerText()).toBe("Shortcut voice note");
});

test("Transcribe a voice draft using the latest assistant reference", async () => {
  const user = userEvent.setup({ delay: null });
  const transcriptionStarted = context.mocks.deferred<void>();
  const transcriptionReady = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({ rms: 0.12 });
  installAvailableVoiceQuota();
  context.mocks.http.post(
    "*/api/voice-io/transcribe/segment",
    async ({ request }) => {
      const body = await request.formData();
      expect(body.get("lastAssistantMessage")).toBe(
        "Use LaunchPad for the rollout.",
      );
      expect(JSON.parse(String(body.get("editorContext")))).toStrictEqual({
        before: "Opening  closing",
        selected: "",
        after: "",
      });
      const files = body.getAll("file");
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ type: "audio/wav", size: 32_044 });
      transcriptionStarted.resolve(undefined);
      await transcriptionReady.promise;
      return HttpResponse.json({
        transcript: "um send the launch update tomorrow",
        polishedText: "Send the launch update tomorrow.",
        language: "en-US",
      });
    },
  );
  installRunChat({
    chatEvents: [
      assistantEvent({
        id: "earlier-assistant-reply",
        runId: "run-voice-context",
        seqId: 1,
        text: "Use the earlier project name.",
      }),
      assistantEvent({
        id: "latest-assistant-reply",
        runId: "run-voice-context",
        seqId: 2,
        text: "Use LaunchPad for the rollout.",
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  const voiceInput = await readyVoiceInput();
  await fill(currentComposer(), "Opening  closing");
  click(voiceInput);
  const stop = await activeVoiceDraftStopButton();
  expect(queryButton("Send")).toBeNull();
  placeCaret(currentComposer(), "Opening  closing", 16);
  click(stop);
  await transcriptionStarted.promise;

  expect(screen.getByRole("status")).toHaveTextContent("Transcribing");
  expect(queryButton("Send")).toBeNull();
  placeCaret(currentComposer(), "Opening  closing", 8);

  transcriptionReady.resolve(undefined);

  await waitFor(() => {
    expect(normalizedComposerText()).toBe(
      "Opening Send the launch update tomorrow. closing",
    );
  });
  await findEnabledButton("Send");
  expect(window.getSelection()?.isCollapsed).toBeTruthy();
  expect(currentComposer()).toHaveFocus();
  await user.keyboard(" Additional note.");
  expect(normalizedComposerText()).toBe(
    "Opening Send the launch update tomorrow. Additional note. closing",
  );
});

test("Show microphone startup before the voice-draft waveform", async () => {
  const microphoneReady = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({
    getUserMediaReady: microphoneReady.promise,
    rms: 0,
  });
  installAvailableVoiceQuota();
  installRunChat();

  await setupPage({
    context,
    path: RUN_PATH,
  });

  const voiceInput = await readyVoiceInput();
  click(voiceInput);

  const starting = await findButton("Starting voice input");
  expect(starting).toBeDisabled();
  expect(starting).toHaveAttribute("aria-busy", "true");
  expect(queryButton("Stop recording")).toBeNull();
  expect(queryButton("Attach")).toBeVisible();
  expect(document.querySelector("[data-voice-level-waveform]")).toBeNull();

  microphoneReady.resolve(undefined);

  await activeVoiceDraftStopButton();
  expect(
    document.querySelector("[data-voice-level-waveform]"),
  ).toBeInTheDocument();
});

test("Keep a silent voice draft recording until the user stops it", async () => {
  const voiceActivityObserved = context.mocks.deferred<void>();
  let multimodalCalls = 0;
  context.mocks.browser.voiceInput({
    rms: () => {
      if (!voiceActivityObserved.settled()) {
        voiceActivityObserved.resolve(undefined);
      }
      return 0;
    },
  });
  installAvailableVoiceQuota();
  context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
    multimodalCalls += 1;
    return HttpResponse.json({
      transcript: "Extended voice draft",
      polishedText: "Extended voice draft.",
      language: "en-US",
    });
  });
  installRunChat();

  await setupPage({
    context,
    path: RUN_PATH,
  });

  const voiceInput = await readyVoiceInput();
  click(voiceInput);
  await voiceActivityObserved.promise;

  const stop = await findEnabledButton("Stop recording");
  expect(stop).toBeEnabled();
  expect(multimodalCalls).toBe(0);

  click(stop);

  await waitFor(() => {
    expect(normalizedComposerText()).toBe("Extended voice draft.");
  });
  expect(multimodalCalls).toBe(1);
  await findEnabledButton("Voice input");
});

async function removeFailedRecordingWithTypedNotes() {
  context.mocks.browser.voiceInput({ rms: 0.12 });
  installAvailableVoiceQuota();
  context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
    return HttpResponse.json(
      {
        error: {
          code: "PROVIDER_UNAVAILABLE",
          message: "Transcription unavailable",
        },
      },
      { status: 503 },
    );
  });
  installRunChat();
  await setupPage({
    context,
    path: RUN_PATH,
  });
  const voiceInput = await readyVoiceInput();
  await fill(currentComposer(), "Keep typed notes");
  click(voiceInput);
  click(await activeVoiceDraftStopButton());
  click(await findButton("Remove voice draft"));
  await waitFor(() => {
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Removing voice draft...");
    expect(status).toHaveTextContent("Returning to composer");
  });
  await findEnabledButton("Voice input");
}

test("Discard a failed recording without removing typed notes", async () => {
  await removeFailedRecordingWithTypedNotes();
  expect(normalizedComposerText()).toBe("Keep typed notes");
});

test("Silently finish a recording with no speech and preserve the input", async () => {
  const initialText = "Keep the existing draft";
  const consoleErrors = captureVoiceTranscriptionErrors();
  context.mocks.browser.voiceInput({ rms: 0 });
  installAvailableVoiceQuota();
  installRunChat();
  context.mocks.http.post(`*${voiceIoTranscribeContract.segment.path}`, () => {
    return new HttpResponse(null, { status: 204 });
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  const voiceInput = await readyVoiceInput();
  await fill(currentComposer(), initialText);
  await userEvent.keyboard("{Control>}a{/Control}");
  click(voiceInput);
  const stop = await activeVoiceDraftStopButton();
  click(stop);

  await findEnabledButton("Voice input");
  expect(normalizedComposerText()).toBe(initialText);
  expect(queryButton("Attach")).toBeVisible();
  expect(queryButton("Send")).toBeEnabled();
  expect(consoleErrors).toStrictEqual([]);
  expect(
    screen.queryByText("Voice transcription failed. Try again."),
  ).toBeNull();

  await userEvent.type(currentComposer(), "New words", { skipClick: true });
  expect(normalizedComposerText()).toBe("New words");
});
