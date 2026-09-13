import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { currentLeftThread$ } from "../../../signals/chat-page/chat-thread-panes.ts";
import { createChildAbortController } from "../../../signals/utils.ts";
import { AGENT_ID } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  context,
  findButton,
  findEnabledButton,
  findLink,
  installRunChat,
  queryButton,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
  NEW_CHAT_PATH,
} from "./chat-run-test-fixtures.ts";

const refreshedContext = testContext();

function unloadVoicePage(page: AbortController): void {
  page.abort(new DOMException("Page reloaded", "AbortError"));
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
}

interface CapturedVoiceSend {
  readonly prompt: string;
}

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

function expectNoVoiceDraftNode(): void {
  const thread = context.store.get(currentLeftThread$);
  if (!thread) {
    throw new Error("Expected the current chat thread");
  }
  let found = false;
  thread.composer.editor.editor.state.doc.descendants((node) => {
    if (node.type.name === "voiceDraft") {
      found = true;
    }
  });
  expect(found).toBeFalsy();
}

async function activeVoiceStopButton(): Promise<HTMLElement> {
  const stop = await findButton("Stop recording");
  await waitFor(() => {
    const meter = Array.from(
      stop.querySelectorAll<HTMLElement>("[style]"),
    ).find((element) => {
      return element.style.getPropertyValue("--mic-volume-fill") !== "";
    });
    expect(meter?.style.getPropertyValue("--mic-volume-fill")).toBe("100%");
  });
  return stop;
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

test("Add voice transcription to the current message draft", async () => {
  const user = userEvent.setup({ delay: null });
  const delayedTranscript = context.mocks.deferred<void>();
  let transcriptionRequest = 0;
  context.mocks.browser.voiceInput({ rms: 0.12 });
  installAvailableVoiceQuota();
  context.mocks.http.post("*/api/voice-io/stt", async ({ request }) => {
    expect((await request.formData()).has("editorContext")).toBeFalsy();
    transcriptionRequest += 1;
    if (transcriptionRequest === 2) {
      await delayedTranscript.promise;
    }
    return HttpResponse.json({
      text:
        transcriptionRequest === 1 ? "Record the agenda" : "Add action owners",
    });
  });
  installRunChat();

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: false },
  });

  const voiceInput = await readyVoiceInput();
  expect(voiceInput).not.toHaveAttribute("aria-keyshortcuts");
  click(voiceInput);
  click(await activeVoiceStopButton());

  await waitFor(() => {
    expect(normalizedComposerText()).toBe("Record the agenda");
  });
  await findEnabledButton("Voice input");
  expect(normalizedComposerText()).toBe("Record the agenda");

  click(await findEnabledButton("Voice input"));
  click(await activeVoiceStopButton());
  await expect(findButton("Transcribing")).resolves.toBeDisabled();

  await user.click(currentComposer());
  await user.keyboard(" and typed notes");
  expect(normalizedComposerText()).toBe("Record the agenda and typed notes");

  delayedTranscript.resolve(undefined);

  await waitFor(() => {
    expect(normalizedComposerText()).toBe(
      "Record the agenda and typed notes Add action owners",
    );
  });
  await findEnabledButton("Voice input");
});

test("Toggle voice input v2 from the focused composer shortcut", async () => {
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

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: {
      [FeatureSwitchKey.VoiceInputV2]: true,
    },
  });

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
  fireEvent.keyDown(currentComposer(), {
    key: "e",
    code: "KeyE",
    ctrlKey: true,
    shiftKey: true,
  });
  expect(screen.getByRole("status")).toHaveTextContent("Transcribing");
  response.resolve();
  await waitFor(() => {
    expect(normalizedComposerText()).toBe("Shortcut voice note");
  });
  await findEnabledButton("Voice input");
});

test("Transcribe a voice draft using the latest assistant reference", async () => {
  const user = userEvent.setup({ delay: null });
  const transcriptionStarted = context.mocks.deferred<void>();
  const transcriptionReady = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({ rms: 0.12 });
  vi.stubGlobal("MediaRecorder", undefined);
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
    featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
  });

  const voiceInput = await readyVoiceInput();
  await fill(currentComposer(), "Opening  closing");
  click(voiceInput);
  const stop = await activeVoiceDraftStopButton();
  expectNoVoiceDraftNode();
  expect(queryButton("Send")).toBeNull();
  placeCaret(currentComposer(), "Opening  closing", 16);
  click(stop);
  await transcriptionStarted.promise;

  expect(screen.getByRole("status")).toHaveTextContent("Transcribing");
  expectNoVoiceDraftNode();
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
  expectNoVoiceDraftNode();
  expect(queryButton("Finish")).toBeNull();
});

test.each([RUN_PATH, NEW_CHAT_PATH])(
  "Read the current selection when submitting voice input at %s",
  async (path) => {
    context.mocks.browser.voiceInput({ rms: 0.12 });
    installAvailableVoiceQuota();
    context.mocks.http.post(
      "*/api/voice-io/transcribe/segment",
      async ({ request }) => {
        const body = await request.formData();
        expect(JSON.parse(String(body.get("editorContext")))).toStrictEqual({
          before: "Alpha ",
          selected: "old",
          after: " omega",
        });
        return HttpResponse.json({
          transcript: "new",
          polishedText: "new",
          language: "en-US",
        });
      },
    );
    installRunChat();
    await setupPage({
      context,
      path,
      featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
    });
    const voiceInput = await readyVoiceInput();
    await fill(currentComposer(), "Alpha old omega");
    placeCaret(currentComposer(), "Alpha old omega", 0);
    click(voiceInput);
    const stop = await activeVoiceDraftStopButton();
    // The selection at submission, rather than at microphone startup, is used.
    placeCaret(currentComposer(), "Alpha old omega", 6, 9);
    click(stop);
    await waitFor(() => {
      expect(normalizedComposerText()).toBe("Alpha new omega");
    });
  },
);

test("Keep paragraph boundaries and readable mention names in voice context", async () => {
  context.mocks.browser.voiceInput({ rms: 0.12 });
  installAvailableVoiceQuota();
  context.mocks.http.post(
    "*/api/voice-io/transcribe/segment",
    async ({ request }) => {
      const body = await request.formData();
      expect(JSON.parse(String(body.get("editorContext")))).toStrictEqual({
        before: "First paragraph\n\nAsk @Run Agent ",
        selected: "old",
        after: " about @Run conversation\nLast paragraph",
      });
      return HttpResponse.json({
        transcript: "new",
        polishedText: "new",
        language: "en-US",
      });
    },
  );
  installRunChat();
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [
          { type: "text", text: "First paragraph\n\nAsk " },
          { type: "agent", agentId: AGENT_ID, nameSnapshot: "Run Agent" },
          { type: "text", text: " old about " },
          {
            type: "chat_thread",
            threadId: RUN_THREAD_ID,
            titleSnapshot: "Run conversation",
          },
          { type: "text", text: "\nLast paragraph" },
        ],
      },
      draftAttachments: null,
    });
  });
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
  });
  const voiceInput = await readyVoiceInput();
  await waitFor(() => {
    expect(currentComposer()).toHaveTextContent("Ask Run Agent old about");
  });
  click(voiceInput);
  const stop = await activeVoiceDraftStopButton();
  placeCaret(currentComposer(), " old about ", 1, 4);
  click(stop);
  await waitFor(() => {
    expect(currentComposer()).toHaveTextContent(
      "Ask Run Agent new about Run conversation",
    );
  });
});

test("Bound editor context around the selection without trimming its whitespace", async () => {
  const before = `${"a".repeat(1100)} leading `;
  const selected = "s".repeat(1100);
  const after = ` trailing ${"z".repeat(1100)}`;
  const draft = before + selected + after;
  context.mocks.browser.voiceInput({ rms: 0.12 });
  installAvailableVoiceQuota();
  context.mocks.http.post(
    "*/api/voice-io/transcribe/segment",
    async ({ request }) => {
      const body = await request.formData();
      expect(JSON.parse(String(body.get("editorContext")))).toStrictEqual({
        before: `${"a".repeat(991)} leading `,
        selected: "s".repeat(1000),
        after: ` trailing ${"z".repeat(990)}`,
      });
      return HttpResponse.json({
        transcript: "replacement",
        polishedText: "replacement",
        language: "en-US",
      });
    },
  );
  installRunChat();
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
  });
  const voiceInput = await readyVoiceInput();
  await fill(currentComposer(), draft);
  click(voiceInput);
  const stop = await activeVoiceDraftStopButton();
  placeCaret(
    currentComposer(),
    draft,
    before.length,
    before.length + selected.length,
  );
  click(stop);
  await waitFor(() => {
    expect(normalizedComposerText()).toBe(`${before}replacement${after}`);
  });
});

test.each(["button", "keyboard"])(
  "Show microphone startup before the voice-draft waveform via %s",
  async (trigger) => {
    const user = userEvent.setup({ delay: null });
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
      featureSwitches: {
        [FeatureSwitchKey.VoiceInputV2]: true,
      },
    });

    const voiceInput = await readyVoiceInput();
    if (trigger === "button") {
      click(voiceInput);
    } else {
      currentComposer().focus();
      await user.keyboard("{Control>}{Shift>}e{/Shift}{/Control}");
    }

    const starting = await findButton("Starting voice input");
    expect(starting).toBeDisabled();
    expect(starting).toHaveAttribute("aria-busy", "true");
    expect(queryButton("Stop recording")).toBeNull();
    expect(queryButton("Attach")).toBeVisible();
    expect(document.querySelector("[data-voice-level-waveform]")).toBeNull();
    expectNoVoiceDraftNode();

    microphoneReady.resolve(undefined);

    await activeVoiceDraftStopButton();
    expectNoVoiceDraftNode();
    expect(
      document.querySelector("[data-voice-level-waveform]"),
    ).toBeInTheDocument();
  },
);

test("Keep a silent voice draft recording until the user stops it", async () => {
  const voiceActivityObserved = context.mocks.deferred<void>();
  let recorderStops = 0;
  let multimodalCalls = 0;
  let legacySttCalls = 0;
  context.mocks.browser.voiceInput({
    rms: () => {
      if (!voiceActivityObserved.settled()) {
        voiceActivityObserved.resolve(undefined);
      }
      return 0;
    },
    onRecorderStop() {
      recorderStops += 1;
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
  context.mocks.http.post("*/api/voice-io/stt", () => {
    legacySttCalls += 1;
    return HttpResponse.json({ text: "Legacy transcription" });
  });
  installRunChat();

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
  });

  const voiceInput = await readyVoiceInput();
  click(voiceInput);
  await voiceActivityObserved.promise;

  const stop = await findEnabledButton("Stop recording");
  expect(stop).toBeEnabled();
  expect(recorderStops).toBe(0);
  expect(multimodalCalls).toBe(0);
  expect(legacySttCalls).toBe(0);
  expectNoVoiceDraftNode();

  click(stop);

  await waitFor(() => {
    expect(normalizedComposerText()).toBe("Extended voice draft.");
  });
  expect(recorderStops).toBe(0);
  expect(multimodalCalls).toBe(1);
  expect(legacySttCalls).toBe(0);
  expectNoVoiceDraftNode();
  await findEnabledButton("Voice input");
});

test("Show a longer history of recent voice levels", async () => {
  context.mocks.browser.voiceInput({ rms: 0.12 });
  installAvailableVoiceQuota();
  installRunChat();

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
  });

  click(await readyVoiceInput());
  await activeVoiceDraftStopButton();

  const waveform = document.querySelector("[data-voice-level-waveform]");
  if (!(waveform instanceof HTMLElement)) {
    throw new Error("Voice level waveform not found");
  }

  await waitFor(() => {
    const bars = Array.from(waveform.children);
    expect(bars).toHaveLength(40);
    expect(bars[0]).toHaveStyle({ height: "4px" });
    expect(bars.at(-1)).toHaveStyle({ height: "16px" });
  });
});

const retryFailures = [
  {
    status: 503,
    code: "PROVIDER_UNAVAILABLE",
    message: "Voice transcription is temporarily unavailable",
  },
  {
    status: 502,
    code: "VOICE_TRANSCRIPTION_FAILED",
    message: "Voice draft transcription failed to produce a usable response",
  },
] as const;

test.each(
  retryFailures.flatMap((failure) => {
    return [
      { ...failure, phase: "failure feedback" },
      { ...failure, phase: "recovery after repeated failure" },
    ];
  }),
)("Voice retry $phase after $code", async (failure) => {
  const transcriptionFailed = context.mocks.deferred<void>();
  const retryRequest = context.mocks.deferred<void>();
  const retryResponse = context.mocks.deferred<void>();
  let transcriptionAttempts = 0;
  const recordings: ArrayBuffer[] = [];
  context.mocks.browser.voiceInput({ rms: 0.12 });
  installAvailableVoiceQuota();
  context.mocks.http.post(
    "*/api/voice-io/transcribe/segment",
    async ({ request }) => {
      const body = await request.formData();
      const file = body.get("file");
      if (!(file instanceof File)) {
        throw new Error("Expected the original voice recording");
      }
      recordings.push(await file.arrayBuffer());
      transcriptionAttempts += 1;
      if (transcriptionAttempts <= 2) {
        if (transcriptionAttempts === 1) {
          transcriptionFailed.resolve(undefined);
        } else {
          retryRequest.resolve();
          await retryResponse.promise;
        }
        return HttpResponse.json(
          {
            error: {
              code: failure.code,
              message: failure.message,
            },
          },
          { status: failure.status },
        );
      }
      return HttpResponse.json({
        transcript: "raw launch update",
        polishedText: "Polished launch update.",
        language: "en-US",
      });
    },
  );
  installRunChat();

  await setupPage({
    context,
    path: RUN_PATH,
    locale: "en-US",
    featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
  });

  const voiceInput = await readyVoiceInput();
  await fill(currentComposer(), "Keep these notes. ");
  click(voiceInput);
  click(await activeVoiceDraftStopButton());
  await transcriptionFailed.promise;

  await waitFor(() => {
    expect(screen.getByText(failure.message, { exact: false })).toBeVisible();
  });
  await expect(findButton("Retry")).resolves.toBeEnabled();
  expect(queryButton("Voice input")).toBeNull();
  expect(transcriptionAttempts).toBe(1);
  expectNoVoiceDraftNode();
  expect(queryButton("Finish")).toBeNull();
  expect(queryButton("Remove voice draft")).toBeEnabled();
  expect(normalizedComposerText()).toBe("Keep these notes.");
  expect(queryButton("Send")).toBeNull();

  click(await findEnabledButton("Retry"));
  await retryRequest.promise;
  await screen.findByText("Transcribing");
  expect(screen.getByText("Retrying saved audio")).toBeVisible();
  retryResponse.resolve();
  await findEnabledButton("Retry");
  expect(normalizedComposerText()).toBe("Keep these notes.");
  expect(transcriptionAttempts).toBe(2);
  expect(recordings[1]).toStrictEqual(recordings[0]);
  if (failure.phase === "failure feedback") {
    return;
  }
  click(await findButton("Retry"));

  await waitFor(() => {
    expect(normalizedComposerText()).toBe(
      "Keep these notes. Polished launch update.",
    );
  });
  expect(transcriptionAttempts).toBe(3);
  expect(recordings[1]).toStrictEqual(recordings[0]);
  expect(recordings[2]).toStrictEqual(recordings[0]);
  expectNoVoiceDraftNode();
  await findEnabledButton("Send");
});

test.each(retryFailures)(
  "A recovered $code recording stays cleared after navigation and reload",
  async (failure) => {
    let transcriptionAttempts = 0;
    context.mocks.browser.voiceInput({ rms: 0.12 });
    installAvailableVoiceQuota();
    context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
      transcriptionAttempts += 1;
      if (transcriptionAttempts <= 2) {
        return HttpResponse.json(
          { error: { code: failure.code, message: failure.message } },
          { status: failure.status },
        );
      }
      return HttpResponse.json({
        transcript: "raw launch update",
        polishedText: "Polished launch update.",
        language: "en-US",
      });
    });
    installRunChat();
    await setupPage({
      context,
      path: RUN_PATH,
      locale: "en-US",
      featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
    });

    const voiceInput = await readyVoiceInput();
    await fill(currentComposer(), "Keep these notes. ");
    click(voiceInput);
    click(await activeVoiceDraftStopButton());
    click(await findEnabledButton("Retry"));
    await waitFor(() => {
      expect(transcriptionAttempts).toBe(2);
      expect(queryButton("Retry")).toBeEnabled();
    });
    click(await findEnabledButton("Retry"));
    await waitFor(() => {
      expect(normalizedComposerText()).toBe(
        "Keep these notes. Polished launch update.",
      );
    });
    expect(transcriptionAttempts).toBe(3);
    await findEnabledButton("Send");

    click(await findLink("Agents"));
    await screen.findByRole("heading", { name: "Agents" });
    cleanup();
    await setupPage({
      context: refreshedContext,
      path: RUN_PATH,
      locale: "en-US",
      featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
    });
    await findEnabledButton("Voice input");
    expect(queryButton("Retry")).toBeNull();
  },
);

test.each([
  { path: RUN_PATH, failed: false, recovery: "navigation" },
  { path: RUN_PATH, failed: false, recovery: "reload" },
  { path: RUN_PATH, failed: true, recovery: "navigation" },
  { path: RUN_PATH, failed: true, recovery: "reload" },
  { path: NEW_CHAT_PATH, failed: true, recovery: "navigation" },
  { path: NEW_CHAT_PATH, failed: true, recovery: "reload" },
])(
  "Restore a retryable recording at $path after $recovery (failed: $failed)",
  async ({ path, failed, recovery }) => {
    // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
    const initialPage = createChildAbortController(context.signal);
    const firstRequest = context.mocks.deferred<void>();
    const firstResponse = context.mocks.deferred<void>();
    const recordings: ArrayBuffer[] = [];
    context.mocks.browser.voiceInput({ rms: 0.12 });
    installAvailableVoiceQuota();
    context.mocks.http.post(
      "*/api/voice-io/transcribe/segment",
      async ({ request }) => {
        const body = await request.formData();
        const file = body.get("file");
        if (!(file instanceof File)) {
          throw new Error("Expected recorded audio");
        }
        recordings.push(await file.arrayBuffer());
        if (recordings.length === 1) {
          firstRequest.resolve(undefined);
          if (!failed) {
            await firstResponse.promise;
          }
          return HttpResponse.json(
            {
              error: {
                code: "PROVIDER_UNAVAILABLE",
                message: "Transcription unavailable",
              },
            },
            { status: 503 },
          );
        }
        return HttpResponse.json({
          transcript: "saved voice note",
          polishedText: "Recovered voice note.",
          language: "en-US",
        });
      },
    );
    installRunChat();
    await setupPage({
      context: { ...context, signal: initialPage.signal },
      path,
      featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
    });
    click(await findEnabledButton("Voice input"));
    click(await activeVoiceDraftStopButton());
    await firstRequest.promise;
    const pendingRecording = failed
      ? findButton("Retry")
      : screen.findByText("Transcribing");
    await expect(pendingRecording).resolves.toBeVisible();

    if (recovery === "navigation") {
      click(await findLink("Agents"));
      await screen.findByRole("heading", { name: "Agents" });
    } else {
      // A browser reload ends the old page's daemons as well as its React tree.
      unloadVoicePage(initialPage);
    }
    if (!failed) {
      firstResponse.resolve(undefined);
    }
    if (recovery === "navigation") {
      window.history.back();
    } else {
      await setupPage({
        context: refreshedContext,
        path,
        featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
      });
    }

    await screen.findByRole("textbox", { name: "Message" });
    click(await findButton("Retry"));
    await waitFor(() => {
      expect(normalizedComposerText()).toBe("Recovered voice note.");
    });
    await findEnabledButton("Send");
    expect(recordings[1]).toStrictEqual(recordings[0]);
  },
);

test("Keep a saved voice recording isolated from another signed-in user", async () => {
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
    featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
  });
  click(await readyVoiceInput());
  click(await activeVoiceDraftStopButton());
  await expect(findButton("Retry")).resolves.toBeEnabled();

  click(await findLink("Agents"));
  await screen.findByRole("heading", { name: "Agents" });
  cleanup();
  await setupPage({
    context: refreshedContext,
    path: RUN_PATH,
    auth: { user: { id: "other-voice-user", fullName: "Other User" } },
    featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
  });
  await findEnabledButton("Voice input");
  expect(queryButton("Retry")).toBeNull();
  expect(normalizedComposerText()).toBe("");
});

test("Discard a failed recording without removing typed notes", async () => {
  // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
  const initialPage = createChildAbortController(context.signal);
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
    context: { ...context, signal: initialPage.signal },
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
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
  expect(normalizedComposerText()).toBe("Keep typed notes");

  click(await findLink("Agents"));
  await screen.findByRole("heading", { name: "Agents" });
  unloadVoicePage(initialPage);
  await setupPage({
    context: refreshedContext,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
  });
  await findEnabledButton("Voice input");
  expect(queryButton("Retry")).toBeNull();
});

test("Release a late microphone stream after navigating away during voice startup", async () => {
  const microphoneReady = context.mocks.deferred<void>();
  const tracksStopped = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({
    getUserMediaReady: microphoneReady.promise,
    rms: 0.12,
    onTrackStop() {
      tracksStopped.resolve(undefined);
    },
  });
  const microphoneRequest = vi.spyOn(navigator.mediaDevices, "getUserMedia");
  installAvailableVoiceQuota();
  installRunChat();

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
  });

  click(await readyVoiceInput());
  await expect(findButton("Starting voice input")).resolves.toBeDisabled();
  await waitFor(() => {
    expect(microphoneRequest).toHaveBeenCalledOnce();
  });
  click(await findLink("Agents"));
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();

  microphoneReady.resolve(undefined);
  await tracksStopped.promise;
  expect(
    screen.queryByText("Voice transcription failed. Try again."),
  ).toBeNull();
});

test("Release the microphone and allow retry when PCM startup fails", async () => {
  const consoleErrors = captureVoiceTranscriptionErrors();
  const workletReady = context.mocks.deferred<void>();
  const pcmWorkletReady = vi
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined)
    .mockImplementationOnce(() => {
      return workletReady.promise;
    });
  let microphoneStops = 0;
  let audioContextCloses = 0;
  context.mocks.browser.voiceInput({
    pcmWorkletReady,
    onTrackStop() {
      microphoneStops += 1;
    },
    onAudioContextClose() {
      audioContextCloses += 1;
    },
    rms: 0.12,
  });
  installAvailableVoiceQuota();
  context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
    return HttpResponse.json({
      transcript: "new voice note",
      polishedText: "New voice note.",
      language: "en-US",
    });
  });
  installRunChat();

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
  });

  const voiceInput = await readyVoiceInput();
  await fill(currentComposer(), "Keep these typed notes. ");
  click(voiceInput);
  await expect(findButton("Starting voice input")).resolves.toBeDisabled();
  expect(document.querySelector("[data-voice-level-waveform]")).toBeNull();
  await waitFor(() => {
    expect(pcmWorkletReady).toHaveBeenCalledOnce();
  });
  workletReady.reject(new Error("PCM worklet could not load"));

  await expect(
    screen.findByText("Voice transcription failed. Try again."),
  ).resolves.toBeVisible();
  const restoredVoiceInput = await findEnabledButton("Voice input");
  expect(restoredVoiceInput).toHaveAttribute("aria-busy", "false");
  expect(queryButton("Attach")).toBeVisible();
  expect(document.querySelector("[data-voice-level-waveform]")).toBeNull();
  expect(normalizedComposerText()).toBe("Keep these typed notes.");
  expect(microphoneStops).toBe(1);
  expect(audioContextCloses).toBe(1);
  await findEnabledButton("Send");

  click(restoredVoiceInput);
  click(await activeVoiceDraftStopButton());
  await waitFor(() => {
    expect(normalizedComposerText()).toBe(
      "Keep these typed notes. New voice note.",
    );
  });
  await findEnabledButton("Send");
  expectNoVoiceDraftNode();
  expect(consoleErrors).toStrictEqual([
    [
      "[E][Composer:VoiceDraft]",
      "Voice draft transcription failed",
      expect.objectContaining({ message: "PCM worklet could not load" }),
    ],
  ]);
});

test.each(["", "Keep the existing draft"])(
  "Silently finish a recording with no speech and preserve the input %j",
  async (initialText) => {
    const consoleErrors = captureVoiceTranscriptionErrors();
    context.mocks.browser.voiceInput({ rms: 0 });
    installAvailableVoiceQuota();
    installRunChat();
    context.mocks.http.post(
      `*${voiceIoTranscribeContract.segment.path}`,
      () => {
        return new HttpResponse(null, { status: 204 });
      },
    );

    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
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
    expect(queryButton("Send")).toHaveProperty("disabled", !initialText);
    expect(consoleErrors).toStrictEqual([]);
    expect(
      screen.queryByText("Voice transcription failed. Try again."),
    ).toBeNull();

    await userEvent.type(currentComposer(), "New words", { skipClick: true });
    expect(normalizedComposerText()).toBe("New words");
  },
);

test("Make voice-input startup and silent cancellation clear", async () => {
  const microphoneReady = context.mocks.deferred<void>();
  const voiceActivityObserved = context.mocks.deferred<void>();
  let audioContextCloseCount = 0;
  let transcriptionRequests = 0;
  const sends: CapturedVoiceSend[] = [];
  context.mocks.browser.voiceInput({
    getUserMediaReady: microphoneReady.promise,
    onAudioContextClose() {
      audioContextCloseCount += 1;
    },
    rms: () => {
      if (!voiceActivityObserved.settled()) {
        voiceActivityObserved.resolve(undefined);
      }
      return 0;
    },
  });
  installAvailableVoiceQuota();
  context.mocks.http.post("*/api/voice-io/stt", () => {
    transcriptionRequests += 1;
    return HttpResponse.json({ text: "Unexpected silent transcript" });
  });
  installRunChat({
    onSendRequest(body) {
      sends.push({ prompt: body.prompt });
    },
  });

  await setupPage({ context, path: RUN_PATH });

  click(await readyVoiceInput());

  await expect(findButton("Starting voice input")).resolves.toBeDisabled();

  microphoneReady.resolve(undefined);

  const stopRecording = await findButton("Stop recording");
  await voiceActivityObserved.promise;
  click(stopRecording);

  await findEnabledButton("Voice input");
  await waitFor(() => {
    expect(audioContextCloseCount).toBe(1);
  });
  expect(normalizedComposerText()).toBe("");
  expect(transcriptionRequests).toBe(0);
  expect(sends).toHaveLength(0);
});

test("Close the voice audio context when recording stops during monitor startup", async () => {
  const audioReady = context.mocks.deferred<void>();
  let audioContextCloseCount = 0;
  context.mocks.browser.voiceInput({
    audioContextReady: audioReady.promise,
    onAudioContextClose() {
      audioContextCloseCount += 1;
    },
    rms: 0.12,
  });
  installAvailableVoiceQuota();
  context.mocks.http.post("*/api/voice-io/stt", () => {
    return HttpResponse.json({ text: "first words" });
  });
  installRunChat();

  await setupPage({ context, path: RUN_PATH });

  click(await readyVoiceInput());
  click(await findButton("Stop recording"));

  await waitFor(() => {
    expect(audioContextCloseCount).toBe(1);
  });
  audioReady.resolve(undefined);

  await waitFor(() => {
    expect(normalizedComposerText()).toBe("first words");
    expect(audioContextCloseCount).toBe(1);
  });
});

test("Close the voice audio context when its activity monitor fails", async () => {
  const audioReady = context.mocks.deferred<void>();
  let audioContextCloseCount = 0;
  context.mocks.browser.voiceInput({
    audioContextReady: audioReady.promise,
    onAudioContextClose() {
      audioContextCloseCount += 1;
    },
    rms: 0.12,
  });
  installAvailableVoiceQuota();
  installRunChat();

  await setupPage({ context, path: RUN_PATH });

  click(await readyVoiceInput());
  await expect(findButton("Stop recording")).resolves.toBeEnabled();

  audioReady.reject(new Error("Audio activity monitor failed to start"));

  await waitFor(() => {
    expect(audioContextCloseCount).toBe(1);
  });
  await expect(findButton("Stop recording")).resolves.toBeEnabled();
});

test("Close the voice audio context when page navigation aborts recording", async () => {
  let audioContextCloseCount = 0;
  context.mocks.browser.voiceInput({
    onAudioContextClose() {
      audioContextCloseCount += 1;
    },
    rms: 0.12,
  });
  installAvailableVoiceQuota();
  installRunChat();

  await setupPage({ context, path: RUN_PATH });

  click(await readyVoiceInput());
  await activeVoiceStopButton();
  click(await findLink("Agents"));

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(audioContextCloseCount).toBe(1);
  });
});

test("Transcribe long voice dictation in ordered segments", async () => {
  type SpeechPhase = "first" | "pause" | "second" | "silence";
  let phase: SpeechPhase = "first";
  let requestNumber = 0;
  let recorderStarts = 0;
  const firstRequestStarted = context.mocks.deferred<void>();
  const firstTranscriptReady = context.mocks.deferred<void>();
  const secondRequestStarted = context.mocks.deferred<void>();
  const secondTranscriptReady = context.mocks.deferred<void>();
  const secondSpeechCaptured = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({
    onRecorderStart: () => {
      recorderStarts += 1;
      if (recorderStarts === 2) {
        // Resume speech at the capture boundary. Waiting for HTTP dispatch
        // would let the simulated pause reach the real silence-stop timer.
        phase = "second";
      }
    },
    rms: () => {
      if (phase === "second" && !secondSpeechCaptured.settled()) {
        secondSpeechCaptured.resolve();
      }
      return phase === "first" || phase === "second" ? 0.12 : 0;
    },
  });
  installAvailableVoiceQuota(null);
  context.mocks.http.post("*/api/voice-io/stt", async () => {
    requestNumber += 1;
    if (requestNumber === 1) {
      firstRequestStarted.resolve(undefined);
      await firstTranscriptReady.promise;
      return HttpResponse.json({ text: "First dictated segment" });
    }
    secondRequestStarted.resolve(undefined);
    await secondTranscriptReady.promise;
    return HttpResponse.json({ text: "Second dictated segment" });
  });
  installRunChat();

  await setupPage({ context, path: RUN_PATH });

  click(await readyVoiceInput());
  await activeVoiceStopButton();

  phase = "pause";
  await firstRequestStarted.promise;
  await secondSpeechCaptured.promise;

  expect(normalizedComposerText()).toBe("");
  await expect(findButton("Stop recording")).resolves.toBeEnabled();

  await activeVoiceStopButton();
  phase = "silence";

  firstTranscriptReady.resolve(undefined);

  await waitFor(() => {
    expect(normalizedComposerText()).toBe("First dictated segment");
  });
  await secondRequestStarted.promise;
  expect(normalizedComposerText()).toBe("First dictated segment");

  secondTranscriptReady.resolve(undefined);

  await waitFor(() => {
    expect(normalizedComposerText()).toBe(
      "First dictated segment Second dictated segment",
    );
  });
  await findEnabledButton("Voice input");
});

test.each(["button", "enter"])(
  "Wait for voice transcription before sending via %s",
  async (trigger) => {
    const microphoneReady = context.mocks.deferred<void>();
    const transcriptReady = context.mocks.deferred<void>();
    const transcriptionStarted = context.mocks.deferred<void>();
    const recorderStarted = context.mocks.deferred<void>();
    const sends: CapturedVoiceSend[] = [];
    context.mocks.browser.voiceInput({
      getUserMediaReady: microphoneReady.promise,
      onRecorderStart() {
        recorderStarted.resolve(undefined);
      },
    });
    installAvailableVoiceQuota();
    context.mocks.http.post("*/api/voice-io/stt", async () => {
      transcriptionStarted.resolve(undefined);
      await transcriptReady.promise;
      return HttpResponse.json({ text: "spoken conclusion" });
    });
    installRunChat({
      onSendRequest(body) {
        sends.push({ prompt: body.prompt });
      },
    });

    await setupPage({ context, path: RUN_PATH });

    await readyChat();
    await fill(currentComposer(), "Typed introduction");
    click(await findEnabledButton("Voice input"));
    await expect(findButton("Starting voice input")).resolves.toBeDisabled();

    if (trigger === "button") {
      click(await findEnabledButton("Send"));
    } else {
      await findEnabledButton("Send");
      fireEvent.keyDown(currentComposer(), { key: "Enter", code: "Enter" });
    }

    expect(sends).toHaveLength(0);
    microphoneReady.resolve(undefined);
    await recorderStarted.promise;
    await transcriptionStarted.promise;
    expect(sends).toHaveLength(0);
    await expect(findButton("Transcribing")).resolves.toBeDisabled();

    const send = await findButton("Send");
    expect(send).toBeDisabled();
    fireEvent.keyDown(currentComposer(), { key: "Enter", code: "Enter" });
    click(send);

    transcriptReady.resolve(undefined);

    await waitFor(() => {
      expect(sends).toHaveLength(1);
    });
    expect(sends[0]?.prompt.replace(/\s+/gu, " ").trim()).toBe(
      "Typed introduction spoken conclusion",
    );
  },
);
