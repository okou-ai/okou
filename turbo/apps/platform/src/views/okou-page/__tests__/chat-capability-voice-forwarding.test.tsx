import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cleanup, screen, within } from "@testing-library/react";
import { openDB, type DBSchema } from "idb";
import { HttpResponse } from "msw";
import { expect, vi, describe, beforeEach, it, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { resetSignal } from "../../../signals/utils.ts";
import {
  completedConversation,
  context,
  installCapabilityChat,
  RUN_PATH,
  selectPassage,
} from "./chat-capability-test-helpers.ts";
import { textContinuityDraft } from "./chat-continuity-test-helpers.ts";
import {
  findEnabledButton,
  NEW_CHAT_PATH,
  queryButton,
} from "./chat-run-test-fixtures.ts";

const refreshedContext = testContext();
const FORWARD_TARGET_NAME = "Okou";

interface RecordingDatabase extends DBSchema {
  drafts: {
    key: string;
    value: { id: string; sampleCount: number; chunkCount: number };
  };
}

async function recordings() {
  const db = await openDB<RecordingDatabase>("okou-voice-drafts");
  const saved = await db.getAll("drafts");
  db.close();
  return saved;
}

function releasePageDom() {
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
}

function installVoiceBoundaries() {
  installCapabilityChat({
    events: completedConversation("The launch plan has three careful stages."),
  });
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

test("keeps forward suggestions caret-anchored when composer-anchored suggestions are enabled", async () => {
  installVoiceBoundaries();
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ComposerAnchoredSuggestions]: true,
    },
  });
  const dialog = await openForwardComposer(FORWARD_TARGET_NAME);
  const editor = within(dialog).getByRole("textbox", { name: "Add a message" });
  await fill(editor, "/");
  const menu = await screen.findByTestId("slash-workflow-menu");
  const [first] = queryAllByRoleFast("button", menu);
  expect(first).toHaveTextContent("Presentation");
  expect(first).toHaveAttribute("data-active", "true");
  expect(
    document.querySelector('[data-slot="slash-template-flyout"]'),
  ).toBeInTheDocument();
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
    const saved = await recordings();
    return {
      resetInitialPage$,
      saved,
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
    const originalComposer = await screen.findByRole("textbox", {
      name: "Message",
    });
    const dialog = await openForwardComposer(FORWARD_TARGET_NAME);
    await findEnabledButton("Retry", dialog);
    return { dialog, originalComposer };
  }
  it("recovers the restored audio into the forward dialog without changing the original composer", async () => {
    const { saved, uploads } = preparedRecording;
    const { dialog, originalComposer } = await openRestoredRecording();
    expect(queryButton("Voice input", dialog)).toBeNull();
    await expect(recordings()).resolves.toStrictEqual(saved);
    preparedRecording.successful = true;
    click(await findEnabledButton("Retry", dialog));
    await findEnabledButton("Voice input", dialog);
    expect(
      within(dialog).getByRole("textbox", { name: "Message" }),
    ).toHaveTextContent("Original recording.");
    expect(originalComposer).toHaveTextContent("Keep the existing notes.");
    expect(uploads).toHaveLength(2);
    expect(uploads[1]).toStrictEqual(uploads[0]);
    await expect(recordings()).resolves.toStrictEqual([]);
  });
});
