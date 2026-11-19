import { voiceIoPolishSegmentsContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import { findButton, queryButton } from "./chat-run-test-fixtures.ts";

const context = testContext();
function getButton(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryButton(name, container);
  if (!button) {
    throw new Error(`Button ${name} is not available`);
  }
  return button;
}

const { installCapabilityChat } = createChatCapabilityHelpers(context);

function placeCaret(composer: HTMLElement, offset: number): void {
  const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      break;
    }
    remaining -= length;
    node = walker.nextNode();
  }
  const selection = window.getSelection();
  if (!node || !selection) {
    throw new Error("Composer text is unavailable for the caret");
  }
  selection.collapse(node, remaining);
  fireEvent(document, new Event("selectionchange"));
}

async function recordAndStop(): Promise<void> {
  const voiceInput = await findButton("Voice input");
  await waitFor(() => {
    expect(voiceInput).toBeEnabled();
  });
  click(voiceInput);
  const stop = await findButton("Stop recording");
  await waitFor(() => {
    expect(stop).toBeEnabled();
  });
  click(stop);
}

async function waitForVoiceInputAvailable(): Promise<void> {
  await waitFor(() => {
    expect(getButton("Voice input")).toBeEnabled();
  });
}

function messageComposer(): HTMLElement {
  return screen.getByRole("textbox", { name: "Message" });
}

test("Transcribe a voice draft with its editor context", async () => {
  installCapabilityChat({
    events: completedConversation(
      "The Atlas project launch update is due tomorrow.",
    ),
  });
  context.mocks.browser.voiceInput({ rms: 0.1 });
  const transcriptions: FormData[] = [];
  const transcriptionReleased = context.mocks.deferred<void>();
  context.mocks.http.post(
    `*${voiceIoTranscribeContract.segment.path}`,
    async ({ request }) => {
      transcriptions.push(await request.formData());
      await transcriptionReleased.promise;
      return HttpResponse.json({
        transcript: "send the launch update tomorrow",
        language: "en",
      });
    },
  );
  const polishes: unknown[] = [];
  context.mocks.api(voiceIoPolishSegmentsContract.post, ({ body, respond }) => {
    polishes.push(body);
    return respond(200, { text: "Send the launch update tomorrow." });
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await fill(messageComposer(), "Opening closing");
  placeCaret(messageComposer(), "Opening ".length);

  await recordAndStop();
  await waitFor(() => {
    expect(transcriptions).toHaveLength(1);
  });
  placeCaret(messageComposer(), "Opening ".length);
  transcriptionReleased.resolve();

  await waitFor(() => {
    expect(messageComposer()).toHaveTextContent(
      "Opening Send the launch update tomorrow.closing",
    );
  });
  expect(
    JSON.parse(String(transcriptions[0]?.get("editorContext"))),
  ).toStrictEqual({ before: "Opening ", selected: "", after: "closing" });
  expect(polishes).toStrictEqual([
    { segments: ["send the launch update tomorrow"] },
  ]);
  const composer = messageComposer();
  expect(composer.contains(document.activeElement)).toBeTruthy();
  expect(window.getSelection()?.isCollapsed).toBeTruthy();
  const user = userEvent.setup({ delay: null });
  await user.keyboard(" Additional note.");
  expect(messageComposer()).toHaveTextContent(
    "Opening Send the launch update tomorrow. Additional note.closing",
  );
});

test("Keep a silent voice draft recording until the user stops it", async () => {
  installCapabilityChat({ events: completedConversation("Ready to help.") });
  context.mocks.browser.voiceInput({ rms: 0, vadProbability: 0 });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();

  await recordAndStop();

  await expect(
    screen.findByText("No speech detected. Please record again."),
  ).resolves.toBeInTheDocument();
  await waitForVoiceInputAvailable();
  expect(messageComposer().textContent?.trim()).toBe("");
});

test("Finish a provider no-speech response and preserve the input", async () => {
  installCapabilityChat({ events: completedConversation("Ready to help.") });
  context.mocks.browser.voiceInput({ rms: 0.1 });
  let transcriptions = 0;
  context.mocks.http.post(`*${voiceIoTranscribeContract.segment.path}`, () => {
    transcriptions += 1;
    return new HttpResponse(null, { status: 204 });
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await fill(messageComposer(), "Keep the existing draft");
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Control>}a{/Control}");

  await recordAndStop();

  await waitFor(() => {
    expect(transcriptions).toBe(1);
  });
  await waitForVoiceInputAvailable();
  expect(messageComposer()).toHaveTextContent("Keep the existing draft");
  expect(window.getSelection()?.toString()).toBe("Keep the existing draft");
  expect(getButton("Add")).toBeVisible();
  expect(getButton("Send")).toBeEnabled();
  await user.keyboard("New words.");
  expect(messageComposer()).toHaveTextContent("New words.");
  expect(messageComposer()).not.toHaveTextContent("Keep the existing draft");
});
