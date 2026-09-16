import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { openDB, type DBSchema } from "idb";
import { HttpResponse } from "msw";
import { expect, test, vi, describe, beforeEach, it } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { resetSignal } from "../../../signals/utils.ts";
import { decodeVoiceDraftPcmWav } from "../../../signals/voice-io/voice-draft-pcm.ts";
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

describe.each(targets)(
  "release a forwarded $target microphone and audio context when its dialog closes during startup",
  ({ name }) => {
    async function prepareScenario() {
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
      await setupPage({ context, path: RUN_PATH });
      await findEnabledButton("Voice input");
      const dialog = await openForwardComposer(name);
      return {
        dialog,
        moduleRequested,
        moduleReady,
        contextClosed,
        trackStopped,
      };
    }
    let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
    beforeEach(async () => {
      preparedScenario = await prepareScenario();
    });
    it("preserves the complete scenario", async () => {
      const {
        dialog,
        moduleRequested,
        moduleReady,
        contextClosed,
        trackStopped,
      } = preparedScenario;
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
    });
  },
);

test("Keep the replacement forward capture when an old startup completes late", async () => {
  installVoiceBoundaries();
  const moduleRequested = context.mocks.deferred<void>();
  const moduleReady = context.mocks.deferred<void>();
  const oldContextClosed = context.mocks.deferred<void>();
  const pcmWorkletReady = vi
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined)
    .mockImplementationOnce(() => {
      moduleRequested.resolve();
      return moduleReady.promise;
    });
  context.mocks.browser.voiceInput({
    rms: 0.12,
    pcmWorkletReady,
    onAudioContextClose: () => {
      if (!oldContextClosed.settled()) {
        oldContextClosed.resolve();
      }
    },
  });
  context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
    return HttpResponse.json({
      transcript: "replacement recording",
      polishedText: "Replacement recording.",
      language: "en-US",
    });
  });
  await setupPage({ context, path: RUN_PATH });
  await findEnabledButton("Voice input");
  const dialog = await openForwardComposer("Okou");
  click(await findEnabledButton("Voice input", dialog));
  await moduleRequested.promise;
  click(await findEnabledButton("Back", dialog));
  click(
    await within(dialog).findByRole("option", {
      name: "Capability conversation",
    }),
  );
  click(await findEnabledButton("Voice input", dialog));
  await findEnabledButton("Stop recording", dialog);

  moduleReady.resolve();
  await oldContextClosed.promise;
  click(await findEnabledButton("Stop recording", dialog));
  await findEnabledButton("Voice input", dialog);
  expect(
    within(dialog).getByRole("textbox", { name: "Message" }),
  ).toHaveTextContent("Replacement recording.");
  expect(
    screen.queryByText("Voice transcription failed. Try again."),
  ).not.toBeInTheDocument();
});

test("Keep the main recording alive when a simultaneous forward transcription is cancelled", async () => {
  installVoiceBoundaries();
  const mainCapture = context.mocks.deferred<(samples: Float32Array) => void>();
  let connected = false;
  context.mocks.browser.voiceInput({
    rms: 0.12,
    finalPcmSamples: new Float32Array(0),
    onPcmCapture: (emit) => {
      if (!connected) {
        connected = true;
        mainCapture.resolve(emit);
      }
      emit(new Float32Array(4096).fill(0.25));
    },
  });
  const requested = context.mocks.deferred<void>();
  const cancelled = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  const responseReturned = context.mocks.deferred<void>();
  const mainUpload = context.mocks.deferred<ArrayBuffer>();
  let forwardRequested = false;
  context.mocks.http.post(
    "*/api/voice-io/transcribe/segment",
    async ({ request }) => {
      if (!forwardRequested) {
        forwardRequested = true;
        request.signal.addEventListener(
          "abort",
          () => {
            cancelled.resolve();
          },
          { once: true },
        );
        requested.resolve();
        await response.promise;
        responseReturned.resolve();
        return HttpResponse.json({
          transcript: "discarded forward text",
          polishedText: "Discarded forward text.",
          language: "en-US",
        });
      }
      mainUpload.resolve(await uploadedAudio(request));
      return HttpResponse.json({
        transcript: "main recording",
        polishedText: "Main recording.",
        language: "en-US",
      });
    },
  );
  await setupPage({ context, path: RUN_PATH });
  const mainEditor = await screen.findByRole("textbox", { name: "Message" });
  click(await findEnabledButton("Voice input"));
  const emit = await mainCapture.promise;
  await findEnabledButton("Stop recording");

  const dialog = await openForwardComposer("Okou");
  click(await findEnabledButton("Voice input", dialog));
  click(await findEnabledButton("Stop recording", dialog));
  await requested.promise;
  expect(within(dialog).getByRole("status")).toHaveTextContent("Transcribing");
  click(await findEnabledButton("Close", dialog));
  await cancelled.promise;
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });

  // The other owner's reset must leave this capture accepting new PCM.
  emit(new Float32Array(4096).fill(-0.5));
  response.resolve();
  await responseReturned.promise;
  click(await findEnabledButton("Stop recording"));
  const samples = decodeVoiceDraftPcmWav(await mainUpload.promise);
  expect(samples).toHaveLength(8192);
  expect(samples?.slice(4096)).toStrictEqual(new Float32Array(4096).fill(-0.5));
  await findEnabledButton("Voice input");
  expect(mainEditor).toHaveTextContent("Main recording.");
  expect(mainEditor).not.toHaveTextContent("Discarded forward text.");
});

describe.each(targets)(
  "reuse an unfinished $target recording in the forward dialog without replacing it",
  ({ name, path }) => {
    async function prepareScenario() {
      const resetInitialPage$ = resetSignal();
      const initialPageSignal = context.store.set(
        resetInitialPage$,
        context.signal,
      );
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
        context: { ...context, signal: initialPageSignal },
        path,
      });
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
    let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
    beforeEach(async () => {
      preparedScenario = await prepareScenario();
    });
    it("preserves the complete scenario", async () => {
      const { resetInitialPage$, uploads } = preparedScenario;
      click(await findEnabledButton("Voice input"));
      click(await findEnabledButton("Stop recording"));
      await findEnabledButton("Retry");
      const saved = await recordings();
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
      const dialog = await openForwardComposer(name);
      await findEnabledButton("Retry", dialog);
      expect(queryButton("Voice input", dialog)).toBeNull();
      await expect(recordings()).resolves.toStrictEqual(saved);
      preparedScenario.successful = true;
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
  },
);
