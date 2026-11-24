import {
  ATTACHMENT_THREAD_ID,
  queryNamedButtons,
  findNamedButton,
  mockAttachmentChat,
  mockPrivateUrlSequence,
  userMessage,
} from "./chat-attachment-test-helpers.ts";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

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

test("Show a recording error when the audio worklet fails to load", async () => {
  context.mocks.browser.voiceInput({
    rms: 0.12,
    pcmWorkletReady: () => {
      return Promise.reject(
        new DOMException("Audio worklet is unavailable", "NotSupportedError"),
      );
    },
  });
  installAvailableVoiceQuota();
  installRunChat();
  await setupPage({ context, path: RUN_PATH });

  click(await readyVoiceInput());

  await expect(
    screen.findByText("Could not start recording."),
  ).resolves.toBeVisible();
  await findEnabledButton("Voice input");
});

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

  await userEvent.type(currentComposer(), "New words", { skipClick: true });
  expect(normalizedComposerText()).toBe("New words");
});

test("Send a recording from the composer as a voice-only message", async () => {
  const fileId = "b0000000-0000-4000-a000-000000000611";
  const uploadUrl = "https://storage.example.test/private-voice";
  mockPrivateUrlSequence(context, {
    [fileId]: ["https://private-files.example/recording.wav"],
  });
  const filename = "Voice recording.wav";
  const url = new URL(artifactReferencePath(fileId, filename), location.origin)
    .href;
  const submitted: unknown[] = [];
  installRunChat({
    onRunCreate: ({ userMessage }) => {
      submitted.push(userMessage);
    },
  });
  context.mocks.browser.voiceInput({ rms: 0.12 });
  const dictationRequests: string[] = [];
  context.mocks.http.post(
    "*/api/voice-io/transcribe/segment",
    ({ request }) => {
      dictationRequests.push(request.url);
      return HttpResponse.json({
        transcript: "Unexpected dictation",
        language: "en",
      });
    },
  );
  context.mocks.http.post("*/api/voice-io/polish/segments", ({ request }) => {
    dictationRequests.push(request.url);
    return HttpResponse.json({ text: "Unexpected dictation" });
  });
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, {
      switches: {},
      effectiveSwitches: { composerVoiceMessages: true },
    });
  });
  context.mocks.api(uploadsContract.preparePrivate, ({ body, respond }) => {
    expect(body.requirePrivateArtifact).toBeTruthy();
    expect(body.contentType).toBe("audio/wav");
    return respond(200, {
      id: fileId,
      filename,
      url,
      contentType: body.contentType,
      size: body.size,
      uploadUrl,
      uploadHeaders: {},
    });
  });
  context.mocks.http.put(uploadUrl, () => {
    return new HttpResponse(null, { status: 200 });
  });
  context.mocks.api(uploadsContract.complete, ({ body, respond }) => {
    return respond(200, {
      id: body.id,
      filename,
      url,
      contentType: "audio/wav",
      size: 32_044,
    });
  });
  await setupPage({ context, path: RUN_PATH });
  click(await readyVoiceInput());
  click(await activeVoiceDraftStopButton());
  const composer = currentComposer();
  const play = await findNamedButton("Play voice message", composer);
  const [audio, metadata] = play.querySelectorAll("audio");
  if (!audio || !metadata) {
    throw new Error("Missing recording media");
  }
  vi.spyOn(audio, "play").mockResolvedValue();
  vi.spyOn(audio, "pause").mockImplementation(() => {});
  Object.defineProperty(metadata, "duration", { value: 12 });
  fireEvent.durationChange(metadata);
  await waitFor(() => {
    expect(play).toHaveTextContent("0:12");
  });
  click(play);
  click(await findNamedButton("Pause voice message", composer));
  await findNamedButton("Play voice message", composer);
  expect(submitted).toHaveLength(0);
  click(await findEnabledButton("Send"));
  await waitFor(() => {
    expect(submitted).toStrictEqual([
      { version: 1, parts: [{ type: "voice", clips: [{ fileId }] }] },
    ]);
  });
  expect(dictationRequests).toHaveLength(0);
});

test("Removing a draft recording preserves neighboring text, references and recordings", async () => {
  const fileId = "b0000000-0000-4000-a000-000000000612";
  const clip = { type: "voice" as const, clips: [{ fileId }] };
  const reference = {
    type: "chat_thread" as const,
    threadId: ATTACHMENT_THREAD_ID,
    titleSnapshot: "Project notes",
  };
  const text = { type: "text" as const, text: "Please summarize " };
  const submitted: unknown[] = [];
  mockAttachmentChat(context, {
    draft: {
      draftUserMessage: { version: 1, parts: [clip, text, reference, clip] },
      draftAttachments: null,
    },
    onSendRequest: (body) => {
      submitted.push(body.userMessage);
    },
  });
  mockPrivateUrlSequence(context, {
    [fileId]: ["https://private-files.example/recording.wav"],
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(queryNamedButtons("Remove voice draft", editor)).toHaveLength(2);
  });
  const remove = queryNamedButtons("Remove voice draft", editor);
  click(remove[0]!);
  await waitFor(() => {
    expect(queryNamedButtons("Play voice message", editor)).toHaveLength(1);
  });
  expect(editor).toHaveTextContent("Please summarize");
  expect(editor).toHaveTextContent("Project notes");
  click(await findEnabledButton("Send"));
  await waitFor(() => {
    expect(submitted).toStrictEqual([userMessage([text, reference, clip])]);
  });
});
