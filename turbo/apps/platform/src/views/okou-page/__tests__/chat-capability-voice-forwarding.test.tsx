import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, vi, describe, beforeEach, it, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { resetSignal } from "../../../signals/utils.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  RUN_PATH,
  selectPassage,
} from "./chat-capability-test-helpers.ts";
import { textContinuityDraft } from "./chat-continuity-test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import {
  findEnabledButton,
  NEW_CHAT_PATH,
  queryButton,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);
// A replacement app has fresh app/worker stores under the same document owner.
const refreshedContext = createTestRuntime(context);
const FORWARD_TARGET_NAME = "Okou";

function releasePageDom() {
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
}

function installVoiceBoundaries() {
  installCapabilityChat({
    events: completedConversation("The launch plan has three careful stages."),
    selectedModel: null,
  });
  context.mocks.data.availableRunModels([]);
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: true, count: 0, limit: 60 });
  });
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, textContinuityDraft("Keep the existing notes."));
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, textContinuityDraft("Keep the existing notes."));
  });
}

async function openForwardComposer(name: string) {
  await selectPassage("launch plan has three careful stages");
  click(await findEnabledButton("Forward"));
  const dialog = await screen.findByRole("dialog");
  click(await within(dialog).findByRole("option", { name }));
  await expect(
    within(dialog).findByRole("textbox", { name: "Add a message" }),
  ).resolves.toBeInTheDocument();
  return dialog;
}

async function uploadedAudio(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new Error("Expected recorded audio");
  }
  return await file.arrayBuffer();
}

async function prepareForwardSuggestions() {
  installVoiceBoundaries();
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  await setupPage({
    context,
    path: RUN_PATH,
  });
  const originalComposer = await screen.findByRole("textbox", {
    name: "Message",
  });
  const dialog = await openForwardComposer(FORWARD_TARGET_NAME);
  const editor = within(dialog).getByRole("textbox", {
    name: "Message",
  });
  await fill(editor, "Forward draft /");
  const menu = await screen.findByTestId("slash-workflow-menu");
  const [first] = queryAllByRoleFast("button", menu);
  expect(first).toHaveTextContent("Website");
  expect(menu).toHaveAttribute("data-side", "top");
  const presentation = queryButton("Presentation", menu);
  const user = userEvent.setup({ delay: null });
  expect(presentation).not.toHaveAttribute("data-active");
  expect(
    within(menu).queryAllByRole("region", { name: "Presentation" }),
  ).toHaveLength(0);
  return { originalComposer, dialog, editor, menu, presentation, user };
}

test("Keep forwarding suggestions isolated during preview navigation", async () => {
  const { originalComposer, dialog, editor, menu, presentation, user } =
    await prepareForwardSuggestions();
  await user.keyboard("{ArrowUp}");
  expect(presentation).toHaveAttribute("data-active", "true");
  expect(
    within(menu).queryAllByRole("region", { name: "Presentation" }),
  ).toHaveLength(1);
  expect(editor).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  expect(queryButton("Document", menu)).toHaveAttribute("data-active", "true");
  expect(dialog).toBeInTheDocument();
  expect(editor).toHaveTextContent("Forward draft /");
  expect(editor).toHaveFocus();
  expect(originalComposer).toHaveTextContent("Keep the existing notes.");
});

test("Keep forwarding suggestions isolated during IME composition", async () => {
  const { originalComposer, dialog, editor, menu } =
    await prepareForwardSuggestions();
  fireEvent.compositionStart(editor, { data: "中文" });
  fireEvent.keyDown(editor, {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  expect(menu).toBeInTheDocument();
  expect(editor).toHaveTextContent("Forward draft /");
  fireEvent.compositionEnd(editor, { data: "中文" });
  expect(dialog).toBeInTheDocument();
  expect(editor).toHaveTextContent("Forward draft /");
  expect(editor).toHaveFocus();
  expect(originalComposer).toHaveTextContent("Keep the existing notes.");
});

test("Keep forwarding suggestions isolated during dismissal", async () => {
  const { originalComposer, dialog, editor, user } =
    await prepareForwardSuggestions();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  });
  expect(dialog).toBeInTheDocument();
  expect(editor).toHaveTextContent("Forward draft /");
  expect(editor).toHaveFocus();
  expect(originalComposer).toHaveTextContent("Keep the existing notes.");
});

describe("reuse an unfinished agent recording in the forward dialog without replacing it", () => {
  async function prepareRecording() {
    const resetInitialPage$ = resetSignal();
    const initialPageSignal = context.store.set(
      resetInitialPage$,
      context.signal,
    );
    installVoiceBoundaries();
    context.mocks.browser.voiceInput({ rms: 0.12 });
    const uploads: ArrayBuffer[] = [];
    let successful = false;
    context.mocks.http.post("*/api/voice-io/polish/segments", () => {
      return HttpResponse.json({ text: "Original recording." });
    });
    context.mocks.http.post(
      "*/api/voice-io/transcribe/segment",
      async ({ request }) => {
        uploads.push(await uploadedAudio(request));
        return successful
          ? HttpResponse.json({
              transcript: "original",

              language: "en-US",
            })
          : HttpResponse.json({ error: "Temporary outage" }, { status: 503 });
      },
    );
    await setupPage({
      locale: "en-US",
      context: { ...context, signal: initialPageSignal },
      path: NEW_CHAT_PATH,
    });
    click(await findEnabledButton("Voice input"));
    click(await findEnabledButton("Stop recording"));
    await findEnabledButton("Retry");
    return {
      resetInitialPage$,
      get successful() {
        return successful;
      },
      set successful(next: typeof successful) {
        successful = next;
      },
      uploads,
    };
  }
  let preparedRecording: Awaited<ReturnType<typeof prepareRecording>>;
  beforeEach(async () => {
    preparedRecording = await prepareRecording();
  });

  async function openRestoredRecording() {
    const { resetInitialPage$ } = preparedRecording;
    context.store.set(resetInitialPage$);
    releasePageDom();
    await setupPage({
      locale: "en-US",
      context: refreshedContext,
      path: RUN_PATH,
    });
    const originalComposer = await waitFor(() => {
      const composer = document.querySelector<HTMLElement>(
        '[role="textbox"][aria-label="Message"]',
      );
      expect(composer).toBeInTheDocument();
      if (!composer) {
        throw new Error("Expected the restored message composer");
      }
      return composer;
    });
    expect(originalComposer).toHaveAccessibleName("Message");
    const dialog = await openForwardComposer(FORWARD_TARGET_NAME);
    await findEnabledButton("Retry", dialog);
    return { dialog, originalComposer };
  }
  it("recovers the restored audio into the forward dialog without changing the original composer", async () => {
    const { uploads } = preparedRecording;
    const { dialog, originalComposer } = await openRestoredRecording();
    expect(queryButton("Voice input", dialog)).toBeNull();
    preparedRecording.successful = true;
    click(await findEnabledButton("Retry", dialog));
    await findEnabledButton("Voice input", dialog);
    expect(
      within(dialog).getByRole("textbox", { name: "Message" }),
    ).toHaveTextContent("Original recording.");
    expect(originalComposer).toHaveTextContent("Keep the existing notes.");
    expect(uploads).toHaveLength(2);
    expect(uploads[1]).toStrictEqual(uploads[0]);
  });
});
