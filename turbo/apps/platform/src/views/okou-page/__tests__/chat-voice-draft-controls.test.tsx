import {
  act,
  waitFor,
  screen,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { HttpResponse } from "msw";
import { test, expect, vi } from "vitest";
import {
  click,
  setupPage,
  queryAllByRoleFast,
  fill,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  createTestRuntime,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import { setupSentryLogger } from "../../../lib/sentry.ts";
import { findEnabledButton } from "./chat-run-test-fixtures.ts";
import { voiceIoPolishSegmentsContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import {
  createChatCapabilityHelpers,
  RUN_PATH,
  completedConversation,
} from "./chat-capability-test-helpers.ts";
import userEvent from "@testing-library/user-event";
import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import {
  ATTACHMENT_THREAD_ID,
  findNamedButton,
  mockAttachmentChat,
  mockPrivateUrlSequence,
  userMessage,
} from "./chat-attachment-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  billingUsagePackManagementContract,
  billingUsagePackCatalogContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import {
  billingPlanCapabilities,
  defaultBillingStatus,
} from "../../../mocks/handlers/api-billing.ts";

const context = testContext();

test("chat-capability-voice-draft-loading-001 the first real PCM buffer enables Stop and neither buffer is lost", async () => {
  const connected = context.mocks.deferred<(data: Float32Array) => void>();
  const uploaded = context.mocks.deferred<ArrayBuffer>();
  context.mocks.browser.voiceInput({
    rms: 0.25,
    onPcmCapture: (emit) => {
      return connected.resolve(emit);
    },
    finalPcmSamples: new Float32Array(0),
  });
  context.mocks.http.post(
    "*" + voiceIoTranscribeContract.segment.path,
    async ({ request }) => {
      const audio = (await request.formData()).get("file");
      if (!(audio instanceof File)) {
        throw new Error("Expected audio file");
      }
      uploaded.resolve(await audio.arrayBuffer());
      return HttpResponse.json({
        transcript: "Audio received",
        language: "en",
      });
    },
  );
  await setupPage({ context, path: "/" });
  const start = await findAction("button", "Voice input");
  await waitFor(() => {
    return expect(start).toBeEnabled();
  });
  click(start);
  await waitFor(() => {
    return expect(connected.settled()).toBeTruthy();
  });
  const emit = await connected.promise;
  await expect(
    findAction("button", "Starting voice input"),
  ).resolves.toBeDisabled();
  expect(queryAction("button", "Stop recording")).toBeNull();
  expect(document.querySelector("[data-voice-level-waveform]")).toBeNull();
  act(() => {
    return emit(new Float32Array(0));
  });
  await expect(
    findAction("button", "Starting voice input"),
  ).resolves.toBeDisabled();
  expect(queryAction("button", "Stop recording")).toBeNull();
  expect(document.querySelector("[data-voice-level-waveform]")).toBeNull();
  act(() => {
    return emit(new Float32Array(4096).fill(0.25));
  });
  const stop = await findAction("button", "Stop recording");
  await waitFor(() => {
    return expect(
      document.querySelector("[data-voice-level-waveform]"),
    ).toBeVisible();
  });
  act(() => {
    return emit(new Float32Array(4096).fill(-0.25));
  });
  click(stop);
  await waitFor(() => {
    return expect(uploaded.settled()).toBeTruthy();
  });
  const bytes = await uploaded.promise;
  const samples = new Int16Array(bytes, 44);
  expect(samples).toHaveLength(8192);
  expect(
    samples.slice(0, 4096).every((n) => {
      return Math.abs(n - 8192) <= 1;
    }),
  ).toBeTruthy();
  expect(
    samples.slice(4096).every((n) => {
      return Math.abs(n + 8192) <= 1;
    }),
  ).toBeTruthy();
});

// One incremental segment is fifteen seconds of 16 kHz audio.
const SEGMENT_SAMPLES = 15 * 16_000;

function queryControl(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((button) => {
    return button.getAttribute("aria-label") === name;
  });
}

async function findEnabledControl(name: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const control = queryControl(name);
    expect(control).toBeEnabled();
    return control as HTMLElement;
  });
}

/** Starts recording and returns the microphone's PCM feed. */
async function startRecording(): Promise<(samples: Float32Array) => void> {
  const microphone: { emit?: (samples: Float32Array) => void } = {};
  context.mocks.browser.voiceInput({
    rms: 0.2,
    onPcmCapture(emit) {
      microphone.emit = emit;
    },
  });
  await setupPage({ context, path: "/" });
  click(await findEnabledControl("Voice input"));
  const emit = await waitFor(() => {
    if (!microphone.emit) {
      throw new Error("Expected the microphone to capture audio");
    }
    return microphone.emit;
  });
  act(() => {
    emit(new Float32Array(4096).fill(0.25));
  });
  await findEnabledControl("Stop recording");
  return emit;
}

test("Keep recording data after an incremental segment fails", async () => {
  const unavailable =
    "Speech recognition is temporarily unavailable. Your recording is kept.";
  // The latest segment failure the transcription service returned.
  const segment: { failure?: string } = {};
  context.mocks.http.post(`*${voiceIoTranscribeContract.segment.path}`, () => {
    segment.failure = unavailable;
    return HttpResponse.json(
      { error: { code: "PROVIDER_UNAVAILABLE", message: unavailable } },
      { status: 503 },
    );
  });
  const emit = await startRecording();

  // Fifteen seconds of speech close the first incremental segment.
  act(() => {
    emit(new Float32Array(SEGMENT_SAMPLES).fill(0.25));
  });
  await waitFor(() => {
    expect(segment.failure).toBe(unavailable);
  });
  // The failed segment arrived before Stop and does not end the recording.
  expect(queryControl("Stop recording")).toBeEnabled();
  act(() => {
    emit(new Float32Array(4096).fill(0.25));
  });

  click(await findEnabledControl("Stop recording"));

  await expect(screen.findByText(unavailable)).resolves.toBeInTheDocument();
  await expect(
    findEnabledControl("Remove voice draft"),
  ).resolves.toBeInTheDocument();
  expect(queryControl("Stop recording")).toBeUndefined();
});

test("Keep genuine transcription failures actionable", async () => {
  const sentry = context.mocks.sentry();
  setupSentryLogger();
  context.mocks.http.post(`*${voiceIoTranscribeContract.segment.path}`, () => {
    return HttpResponse.json(
      {
        error: {
          code: "VOICE_IO_NOT_CONFIGURED",
          message: "Speech recognition is not configured.",
        },
      },
      { status: 502 },
    );
  });
  await startRecording();

  click(await findEnabledControl("Stop recording"));

  await expect(
    screen.findByText("Speech recognition is not configured."),
  ).resolves.toBeInTheDocument();
  await expect(
    findEnabledControl("Remove voice draft"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(sentry.reports).toContainEqual(
      expect.objectContaining({
        type: "exception",
        error: expect.objectContaining({
          code: "VOICE_IO_NOT_CONFIGURED",
          status: 502,
        }),
      }),
    );
  });
});

test("chat-capability-voice-polish-001 polishes the earlier speech without the recording's silent final second", async () => {
  const sampleRate = 16_000;
  context.mocks.browser.voiceInput({
    rms: 0.18,
    onPcmCapture(emit) {
      emit(new Float32Array(15 * sampleRate).fill(0.18));
    },
    finalPcmSamples: new Float32Array(sampleRate),
    vadProbability: 0.9,
  });
  context.mocks.http.post(
    "*" + voiceIoTranscribeContract.segment.path,
    async ({ request }) => {
      const audio = (await request.formData()).get("file") as File;
      const pcm = new Int16Array(await audio.arrayBuffer(), 44);
      const transcript =
        pcm.at(-1) === 0 ? "Spurious tail." : "Earlier speech.";
      return HttpResponse.json({ transcript, language: "en" });
    },
  );
  context.mocks.api(voiceIoPolishSegmentsContract.post, ({ body, respond }) => {
    return respond(200, { text: body.segments.join(" ") });
  });
  createChatCapabilityHelpers(context).installCapabilityChat({ events: [] });
  await setupPage({ context, path: RUN_PATH });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await waitFor(() => {
    expect(editor.textContent).toBe("Earlier speech.");
  });
});

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

test("voice-draft-audio-015 sends the recorded worklet samples as a playable voice-only message", async () => {
  const fileId = "b0000000-0000-4000-a000-000000000611";
  const uploadUrl = "https://storage.example.test/private-voice";
  mockPrivateUrlSequence(context, {
    [fileId]: ["https://private-files.example/recording.wav"],
  });
  const filename = "Voice recording.wav";
  const url = new URL(artifactReferencePath(fileId, filename), location.origin)
    .href;
  const submitted: unknown[] = [];
  createChatCapabilityHelpers(context).installCapabilityChat({
    events: completedConversation("Ready for the recording."),
    onSend: (body) => {
      submitted.push(body.userMessage);
    },
  });
  const levels = [-1, -0.25, 0, 0.25, 1];
  context.mocks.browser.voiceInput({
    rms: 0.2,
    onPcmCapture(emit) {
      emit(Float32Array.from(levels));
    },
    finalPcmSamples: new Float32Array(0),
  });
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
  const stored = context.mocks.deferred<Blob>();
  context.mocks.http.put(uploadUrl, async ({ request }) => {
    stored.resolve(await request.blob());
    return new HttpResponse(null, { status: 200 });
  });
  context.mocks.api(uploadsContract.complete, ({ body, respond }) => {
    return respond(200, {
      id: body.id,
      filename,
      url,
      contentType: "audio/wav",
      size: 54,
    });
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText("Ready for the recording.");
  await screen.findByRole("textbox", { name: "Message" });
  click(await findEnabledButton("Voice input"));
  const voiceButton = await findEnabledButton("Voice");
  const textButton = await findEnabledButton("Text");
  expect(voiceButton).not.toHaveAttribute("aria-keyshortcuts");
  expect(textButton).toHaveAttribute(
    "aria-keyshortcuts",
    "Meta+Shift+E Control+Shift+E",
  );
  click(voiceButton);
  const composer = await screen.findByRole("textbox", { name: "Message" });
  const play = await findNamedButton("Play voice message", composer);
  const wav = await stored.promise;
  expect(wav.type).toBe("audio/wav");
  const bytes = await wav.arrayBuffer();
  const header = new TextDecoder().decode(bytes.slice(0, 12));
  expect(header.slice(0, 4)).toBe("RIFF");
  expect(header.slice(8)).toBe("WAVE");
  const pcm = new DataView(bytes);
  expect(pcm.getUint16(20, true)).toBe(1);
  expect(pcm.getUint16(34, true)).toBe(16);
  expect(pcm.getUint32(40, true)).toBe(levels.length * 2);
  expect(bytes.byteLength).toBe(44 + levels.length * 2);
  for (const [index, expected] of levels.entries()) {
    expect(pcm.getInt16(44 + 2 * index, true) / 32_768).toBeCloseTo(
      expected,
      4,
    );
  }
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

test("voice-draft-audio-016 Text button and shortcut transcribe to text while Voice uploads without a secondary label", async () => {
  const uploadReady = context.mocks.deferred<void>();
  const uploadRequests: string[] = [];
  createChatCapabilityHelpers(context).installCapabilityChat({
    events: completedConversation("Ready for dual voice actions."),
  });
  context.mocks.browser.voiceInput({ rms: 0.2 });
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, {
      switches: {},
      effectiveSwitches: { composerVoiceMessages: true },
    });
  });
  context.mocks.http.post("*" + voiceIoTranscribeContract.segment.path, () => {
    return HttpResponse.json({
      transcript: "transcribe via shortcut",
      language: "en",
    });
  });
  context.mocks.api(voiceIoPolishSegmentsContract.post, ({ respond }) => {
    return respond(200, { text: "Transcribe via shortcut." });
  });
  context.mocks.api(uploadsContract.preparePrivate, ({ body, respond }) => {
    uploadRequests.push(body.contentType);
    return respond(200, {
      id: "b0000000-0000-4000-a000-000000000619",
      filename: "Voice recording.wav",
      url: new URL(
        artifactReferencePath(
          "b0000000-0000-4000-a000-000000000619",
          "Voice recording.wav",
        ),
        location.origin,
      ).href,
      contentType: body.contentType,
      size: body.size,
      uploadUrl: "https://storage.example.test/private-voice-016",
      uploadHeaders: {},
    });
  });
  context.mocks.http.put(
    "https://storage.example.test/private-voice-016",
    async () => {
      await uploadReady.promise;
      return new HttpResponse(null, { status: 200 });
    },
  );
  context.mocks.api(uploadsContract.complete, ({ body, respond }) => {
    return respond(200, {
      id: body.id,
      filename: "Voice recording.wav",
      url: new URL(
        artifactReferencePath(body.id, "Voice recording.wav"),
        location.origin,
      ).href,
      contentType: "audio/wav",
      size: 54,
    });
  });
  mockPrivateUrlSequence(context, {
    "b0000000-0000-4000-a000-000000000619": [
      "https://private-files.example/recording-016.wav",
    ],
  });

  await setupPage({ context, path: RUN_PATH });
  await screen.findByText("Ready for dual voice actions.");
  const editor = await screen.findByRole("textbox", { name: "Message" });

  // Default shortcut finishes recording as Text, not Voice.
  click(await findEnabledButton("Voice input"));
  await findEnabledButton("Text");
  fireEvent.keyDown(document, {
    key: "E",
    code: "KeyE",
    ctrlKey: true,
    shiftKey: true,
  });
  await waitFor(() => {
    expect(editor.textContent).toBe("Transcribe via shortcut.");
  });
  expect(uploadRequests).toHaveLength(0);

  // Voice button uploads and inserts into composer with only the uploading status text.
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Voice"));
  const uploadingLabel = await screen.findByText("Uploading recording…");
  expect(
    uploadingLabel.closest("[data-composer-voice-tray]"),
  ).toHaveTextContent(/^Uploading recording…$/u);
  uploadReady.resolve();
  await findNamedButton("Play voice message", editor);
  expect(uploadRequests).toHaveLength(1);
});

test("voice-draft-audio-017 keeps Text enabled on the recovery tray after a Voice upload failure", async () => {
  createChatCapabilityHelpers(context).installCapabilityChat({
    events: completedConversation("Ready for upload recovery."),
  });
  context.mocks.browser.voiceInput({ rms: 0.2 });
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, {
      switches: {},
      effectiveSwitches: { composerVoiceMessages: true },
    });
  });
  context.mocks.api(uploadsContract.preparePrivate, ({ body, respond }) => {
    return respond(200, {
      id: "b0000000-0000-4000-a000-000000000620",
      filename: "Voice recording.wav",
      url: new URL(
        artifactReferencePath(
          "b0000000-0000-4000-a000-000000000620",
          "Voice recording.wav",
        ),
        location.origin,
      ).href,
      contentType: body.contentType,
      size: body.size,
      uploadUrl: "https://storage.example.test/private-voice-017",
      uploadHeaders: {},
    });
  });
  context.mocks.http.put(
    "https://storage.example.test/private-voice-017",
    () => {
      return new HttpResponse(null, { status: 500 });
    },
  );
  context.mocks.http.post("*" + voiceIoTranscribeContract.segment.path, () => {
    return HttpResponse.json({
      transcript: "recovered as text",
      language: "en",
    });
  });
  context.mocks.api(voiceIoPolishSegmentsContract.post, ({ respond }) => {
    return respond(200, { text: "Recovered as text." });
  });

  await setupPage({ context, path: RUN_PATH });
  await screen.findByText("Ready for upload recovery.");
  const editor = await screen.findByRole("textbox", { name: "Message" });

  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Voice"));

  await expect(
    screen.findByText("Your recording is saved."),
  ).resolves.toBeInTheDocument();
  const textButton = await findEnabledButton("Text");
  click(textButton);

  await waitFor(() => {
    expect(editor.textContent).toBe("Recovered as text.");
  });
});

test.each(["Backspace", "Delete"] as const)(
  "%s removes only the adjacent draft recording",
  async (key) => {
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
        draftUserMessage: { version: 1, parts: [clip, text, clip, reference] },
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
      expect(
        queryAllByRoleFast("button", editor).filter((button) => {
          return button.getAttribute("aria-label") === "Play voice message";
        }),
      ).toHaveLength(2);
    });
    expect(
      queryAllByRoleFast("button", editor).filter((button) => {
        return button.getAttribute("aria-label") === "Remove voice draft";
      }),
    ).toHaveLength(0);
    editor.focus();
    const draftText = Array.from(editor.querySelector("p")!.childNodes).find(
      (node) => {
        return (
          node.nodeType === Node.TEXT_NODE && node.textContent === text.text
        );
      },
    );
    if (!draftText) {
      throw new Error("Missing text between the two recordings");
    }
    window
      .getSelection()!
      .collapse(draftText, key === "Backspace" ? 0 : text.text.length);
    document.dispatchEvent(new Event("selectionchange"));
    fireEvent.keyDown(editor, {
      key,
      code: key,
      keyCode: key === "Backspace" ? 8 : 46,
    });
    await waitFor(() => {
      expect(
        queryAllByRoleFast("button", editor).filter((button) => {
          return button.getAttribute("aria-label") === "Play voice message";
        }),
      ).toHaveLength(1);
    });
    expect(editor).toHaveTextContent("Please summarize");
    expect(editor).toHaveTextContent("Project notes");
    click(await findEnabledButton("Send"));
    await waitFor(() => {
      expect(submitted).toStrictEqual([
        userMessage(
          key === "Backspace"
            ? [text, clip, reference]
            : [clip, text, reference],
        ),
      ]);
    });
  },
);

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

async function startMeteredVoiceInput(
  tier: "limited-free-1" | "pro",
  role: "admin" | "member",
  usage: { count: number },
) {
  context.mocks.browser.voiceInput({ rms: 0.12 });
  createChatCapabilityHelpers(context).installCapabilityChat({ events: [] });
  context.mocks.api(orgContract.get, ({ respond }) => {
    return respond(200, { id: "org_default", name: "Launch team", role });
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...defaultBillingStatus(),
      ...billingPlanCapabilities(tier),
      onboardingPaymentPending: false,
      hasSubscription: tier === "pro",
      subscriptionStatus: tier === "pro" ? "active" : null,
      tier,
    });
  });
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, {
      count: usage.count,
      limit: 10,
      allowed: usage.count < 10,
    });
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, {
      supportsFreeMembers: true,
      usagePacks: [
        {
          usagePackUsd: 20,
          priceUsd: 20,
          purchasedCredits: 2000,
          bonusCredits: 200,
          totalCredits: 2200,
        },
      ],
    });
  });
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "No managed plan" },
    });
  });
  await setupPage({ context, path: RUN_PATH });
  click(await findEnabledButton("Voice input"));
}

test("chat-capability-voice-quota-001 offers Pro and Team to the free workspace admin at the voice limit", async () => {
  await startMeteredVoiceInput("limited-free-1", "admin", { count: 10 });
  await screen.findByText(
    "Voice input limit reached. Upgrade to Pro or Team for higher limits.",
  );
  const chooser = await screen.findByRole("dialog", { name: "Choose a plan" });
  await expect(
    within(chooser).findByRole("article", { name: "Pro plan" }),
  ).resolves.toBeVisible();
  await expect(
    within(chooser).findByRole("article", { name: "Team plan" }),
  ).resolves.toBeVisible();
});

test("chat-capability-voice-quota-002 offers Team after the Pro admin's transcription reaches the limit", async () => {
  const usage = { count: 9 };
  context.mocks.http.post("*" + voiceIoTranscribeContract.segment.path, () => {
    usage.count = 10;
    return HttpResponse.json(
      {
        error: {
          code: "DAILY_RATE_LIMIT_EXCEEDED",
          message: "Voice limit reached",
        },
        quota: { count: 10, limit: 10 },
      },
      { status: 429 },
    );
  });
  await startMeteredVoiceInput("pro", "admin", usage);
  click(await findEnabledButton("Stop recording"));
  await screen.findByText(
    "Voice input limit reached. Upgrade to Team for higher limits.",
  );
  const chooser = await screen.findByRole("dialog", { name: "Choose a plan" });
  await expect(
    within(chooser).findByRole("article", { name: "Team plan" }),
  ).resolves.toBeVisible();
});

test("chat-capability-voice-quota-004 directs a free workspace member to an admin from the current chat", async () => {
  await startMeteredVoiceInput("limited-free-1", "member", { count: 10 });
  await screen.findByText(
    "Voice input limit reached. Ask a workspace admin to upgrade for higher limits.",
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
