import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { openDB, type DBSchema } from "idb";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../../../signals/utils.ts";
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
const flags = { [FeatureSwitchKey.VoiceInputV2]: true } as const;
const targets = [
  { target: "agent", name: "Okou", path: NEW_CHAT_PATH },
  { target: "thread", name: "Capability conversation", path: RUN_PATH },
] as const;

interface RecordingDatabase extends DBSchema {
  drafts: {
    key: string;
    value: { id: string; sampleCount: number; chunkCount: number };
  };
}

async function recordings() {
  const db = await openDB<RecordingDatabase>("okou-voice-drafts", 1);
  const saved = await db.getAll("drafts");
  db.close();
  return saved;
}

function unload(page: AbortController) {
  const aborted = new Error("Page reloaded");
  aborted.name = "AbortError";
  page.abort(aborted);
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

test.each(targets)(
  "Release a forwarded $target microphone and audio context when its dialog closes during startup",
  async ({ name }) => {
    installVoiceBoundaries();
    const moduleRequested = context.mocks.deferred<void>();
    const moduleReady = context.mocks.deferred<void>();
    const contextClosed = context.mocks.deferred<void>();
    const trackStopped = context.mocks.deferred<void>();
    context.mocks.browser.voiceInput({
      rms: 0.12,
      pcmWorkletReady: () => {
        moduleRequested.resolve();
        return moduleReady.promise;
      },
      onAudioContextClose: contextClosed.resolve,
      onTrackStop: trackStopped.resolve,
    });
    await setupPage({ context, path: RUN_PATH, featureSwitches: flags });
    await findEnabledButton("Voice input");
    const dialog = await openForwardComposer(name);
    click(await findEnabledButton("Voice input", dialog));
    await moduleRequested.promise;
    expect(queryButton("Starting voice input", dialog)).toBeDisabled();
    click(await findEnabledButton("Close", dialog));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    moduleReady.resolve();
    await Promise.all([contextClosed.promise, trackStopped.promise]);
    await findEnabledButton("Voice input");
    expect(
      screen.queryByText("Voice transcription failed. Try again."),
    ).not.toBeInTheDocument();
  },
);

test.each(targets)(
  "Reuse an unfinished $target recording in the forward dialog without replacing it",
  async ({ name, path }) => {
    // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
    const initialPage = createChildAbortController(context.signal);
    installVoiceBoundaries();
    context.mocks.browser.voiceInput({ rms: 0.12 });
    const uploads: ArrayBuffer[] = [];
    let successful = false;
    context.mocks.http.post(
      "*/api/voice-io/transcribe/segment",
      async ({ request }) => {
        uploads.push(await uploadedAudio(request));
        return successful
          ? HttpResponse.json({
              transcript: "original",
              polishedText: "Original recording.",
              language: "en-US",
            })
          : HttpResponse.json({ error: "Temporary outage" }, { status: 503 });
      },
    );
    await setupPage({
      locale: "en-US",
      context: { ...context, signal: initialPage.signal },
      path,
      featureSwitches: flags,
    });
    click(await findEnabledButton("Voice input"));
    click(await findEnabledButton("Stop recording"));
    await findEnabledButton("Retry");
    const saved = await recordings();
    unload(initialPage);
    await setupPage({
      locale: "en-US",
      context: refreshedContext,
      path: RUN_PATH,
      featureSwitches: flags,
    });
    const originalComposer = await screen.findByRole("textbox", {
      name: "Message",
    });
    const dialog = await openForwardComposer(name);
    await findEnabledButton("Retry", dialog);
    expect(queryButton("Voice input", dialog)).toBeNull();
    await expect(recordings()).resolves.toStrictEqual(saved);
    successful = true;
    click(await findEnabledButton("Retry", dialog));
    await findEnabledButton("Voice input", dialog);
    expect(
      within(dialog).getByRole("textbox", { name: "Message" }),
    ).toHaveTextContent("Original recording.");
    expect(originalComposer).toHaveTextContent("Keep the existing notes.");
    expect(uploads).toHaveLength(2);
    expect(uploads[1]).toStrictEqual(uploads[0]);
    await expect(recordings()).resolves.toStrictEqual([]);
  },
);
