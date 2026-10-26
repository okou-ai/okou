import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  assistantEvent,
  findButton,
  findEnabledButton,
  queryButton,
  readyChat,
  RUN_PATH,
  createChatRunFixtures,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

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

async function activeVoiceDraftStopButton(): Promise<HTMLElement> {
  const stop = await findButton("Stop recording");
  await waitFor(() => {
    expect(stop).toBeEnabled();
  });
  expect(stop).toHaveTextContent("Done");
  expect(
    screen.getByText(/^\d{2}:\d{2}$/u, { selector: "time" }),
  ).toBeVisible();
  expect(screen.queryByLabelText("Add")).toBeNull();
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

test("Start and stop voice input from the focused composer shortcut", async () => {
  context.mocks.browser.voiceInput({ rms: 0.12 });
  installAvailableVoiceQuota();
  context.mocks.http.post("*/api/voice-io/polish/segments", () => {
    return HttpResponse.json({ text: "Shortcut voice note" });
  });
  context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
    return HttpResponse.json({
      transcript: "um shortcut voice note",

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
  await waitFor(() => {
    expect(normalizedComposerText()).toBe("Shortcut voice note");
  });
  await findEnabledButton("Voice input");
});

test("Transcribe a voice draft with its editor context", async () => {
  const user = userEvent.setup({ delay: null });
  const transcriptionStarted = context.mocks.deferred<void>();
  const transcriptionReady = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({ rms: 0.12 });
  installAvailableVoiceQuota();
  context.mocks.http.post(
    "*/api/voice-io/polish/segments",
    async ({ request }) => {
      await expect(request.json()).resolves.toStrictEqual({
        segments: ["um send the launch update tomorrow"],
      });
      return HttpResponse.json({ text: "Send the launch update tomorrow." });
    },
  );
  context.mocks.http.post(
    "*/api/voice-io/transcribe/segment",
    async ({ request }) => {
      const body = await request.formData();
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
  placeCaret(currentComposer(), "Opening  closing", 16);
  const voiceTray = stop.closest("[data-composer-voice-tray]");
  click(stop);
  await transcriptionStarted.promise;
  // Finishing capture must retain the component that owns this operation.
  expect(voiceTray).toBeInTheDocument();
  expect(voiceTray).toHaveAttribute("role", "status");
  expect(queryButton("Use recording")).toBeNull();
  expect(queryButton("Voice input")).toBeNull();

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

test("Keep a silent voice draft recording until the user stops it", async () => {
  const voiceActivityObserved = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({
    finalPcmSamples: new Float32Array(16_000),
    onPcmCapture: (emit) => {
      emit(new Float32Array(4096));
    },
    rms: () => {
      if (!voiceActivityObserved.settled()) {
        voiceActivityObserved.resolve(undefined);
      }
      return 0;
    },
  });
  installAvailableVoiceQuota();
  context.mocks.http.post("*/api/voice-io/polish/segments", () => {
    return HttpResponse.json({ text: "Extended voice draft." });
  });
  context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
    return HttpResponse.json({
      transcript: "Extended voice draft",

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
  click(stop);

  await expect(
    screen.findByText("No speech detected. Please record again."),
  ).resolves.toBeInTheDocument();
  await findEnabledButton("Voice input");
  expect(normalizedComposerText()).toBe("");
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
  await findEnabledButton("Voice input");
}

test("Discard a failed recording without removing typed notes", async () => {
  await removeFailedRecordingWithTypedNotes();
  expect(normalizedComposerText()).toBe("Keep typed notes");
});

test("Finish a provider no-speech response and preserve the input", async () => {
  const initialText = "Keep the existing draft";
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
  await expect(findEnabledButton("Add")).resolves.toBeVisible();
  expect(queryButton("Send")).toBeEnabled();
  expect(screen.queryByText("Voice transcription failed.")).toBeNull();

  await userEvent.type(currentComposer(), "New words", { skipClick: true });
  expect(normalizedComposerText()).toBe("New words");
});
