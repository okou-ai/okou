import { findEnabledButton } from "./chat-run-test-fixtures.ts";
import { voiceIoPolishSegmentsContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { HttpResponse } from "msw";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
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
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
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
  await record();
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
