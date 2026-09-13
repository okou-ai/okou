import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { openDB, type DBSchema } from "idb";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../../../signals/utils.ts";
import { decodeVoiceDraftPcmWav } from "../../../signals/voice-io/voice-draft-pcm.ts";
import {
  context,
  findEnabledButton,
  installRunChat,
  NEW_CHAT_PATH,
  queryButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const secondContext = testContext();
interface RecordingDatabase extends DBSchema {
  drafts: {
    key: string;
    value: { id: string; sampleCount: number; chunkCount: number };
  };
}

async function savedRecording() {
  const database = await openDB<RecordingDatabase>("okou-voice-drafts", 1);
  const recordings = await database.getAll("drafts");
  database.close();
  return recordings[0] ?? null;
}

function releasePageDom() {
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
}

function unload(page: AbortController) {
  const error = new Error("Page reloaded");
  error.name = "AbortError";
  page.abort(error);
  releasePageDom();
}

function installVoiceBoundaries() {
  installRunChat();
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: true, count: 0, limit: 60 });
  });
  const errorSpy = vi.spyOn(console, "error");
  const original = errorSpy.getMockImplementation();
  if (!original) {
    throw new Error("Expected console guard");
  }
  const errors: unknown[][] = [];
  errorSpy.mockImplementation((...args: unknown[]) => {
    if (
      (args[0] === "[E][Composer:VoiceDraft]" &&
        args[1] === "Voice recording could not be saved") ||
      (args[0] === "[E][VoiceIO:STT]" &&
        args[1] === "Voice recording failed to finish")
    ) {
      errors.push(args);
      return;
    }
    original(...args);
  });
  return errors;
}

async function uploadedAudio(request: Request): Promise<ArrayBuffer> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new Error("Expected recorded audio");
  }
  return await file.arrayBuffer();
}

const flags = { [FeatureSwitchKey.VoiceInputV2]: true } as const;

test.each([
  { path: RUN_PATH, reloadAt: "recording" },
  { path: NEW_CHAT_PATH, reloadAt: "recording" },
  { path: RUN_PATH, reloadAt: "failed retries" },
  { path: NEW_CHAT_PATH, reloadAt: "failed retries" },
])(
  "Recover committed PCM across a reload ($reloadAt) at $path",
  async ({ path, reloadAt }) => {
    // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
    const firstPage = createChildAbortController(context.signal);
    const capture = context.mocks.deferred<(samples: Float32Array) => void>();
    context.mocks.browser.voiceInput({
      rms: 0.12,
      onPcmCapture: capture.resolve,
      finalPcmSamples: new Float32Array(0),
    });
    installVoiceBoundaries();
    const uploads: ArrayBuffer[] = [];
    const retries = Array.from(
      { length: reloadAt === "failed retries" ? 2 : 0 },
      () => {
        return {
          requested: context.mocks.deferred<void>(),
          response: context.mocks.deferred<void>(),
        };
      },
    );
    context.mocks.http.post(
      "*/api/voice-io/transcribe/segment",
      async ({ request }) => {
        uploads.push(await uploadedAudio(request));
        const retry = retries[uploads.length - 1];
        if (retry) {
          retry.requested.resolve();
          await retry.response.promise;
          return HttpResponse.json(
            { error: "Temporary outage" },
            { status: 503 },
          );
        }
        return HttpResponse.json({
          transcript: "recovered",
          polishedText: "Recovered audio.",
          language: "en-US",
        });
      },
    );
    await setupPage({
      locale: "en-US",
      context: { ...context, signal: firstPage.signal },
      path,
      featureSwitches: flags,
    });
    click(await findEnabledButton("Voice input"));
    const emit = await capture.promise;
    emit(new Float32Array(4096).fill(0.25));
    await waitFor(async () => {
      await expect(savedRecording()).resolves.toMatchObject({
        sampleCount: 4096,
        chunkCount: 1,
      });
    });
    await findEnabledButton("Stop recording");
    // Keep interrupted capture and repeated transcription failures independent:
    // each case needs only one reload before its successful recovery.
    if (reloadAt === "recording") {
      unload(firstPage);
      await setupPage({
        locale: "en-US",
        context: secondContext,
        path,
        featureSwitches: flags,
      });
    }
    for (const retry of retries) {
      const action = retry === retries[0] ? "Stop recording" : "Retry";
      click(await findEnabledButton(action));
      await retry.requested.promise;
      await screen.findByText("Transcribing");
      retry.response.resolve();
      await findEnabledButton("Retry");
    }
    if (reloadAt === "failed retries") {
      unload(firstPage);
      await setupPage({
        locale: "en-US",
        context: secondContext,
        path,
        featureSwitches: flags,
      });
    }
    const retryButton = await findEnabledButton("Retry");
    expect(queryButton("Stop recording")).toBeNull();
    click(retryButton);
    await findEnabledButton("Voice input");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Recovered audio.",
    );
    expect(uploads).toHaveLength(retries.length + 1);
    for (const upload of uploads.slice(1)) {
      expect(upload).toStrictEqual(uploads[0]);
    }
    const samples = decodeVoiceDraftPcmWav(uploads[0]!);
    expect(samples).toHaveLength(4096);
    expect(samples?.at(-1)).toBeCloseTo(0.25, 4);
    await waitFor(async () => {
      return await expect(savedRecording()).resolves.toBeNull();
    });
  },
);

test.each([RUN_PATH, NEW_CHAT_PATH])(
  "Include the final worklet chunk before transcribing at %s",
  async (path) => {
    const capture = context.mocks.deferred<(samples: Float32Array) => void>();
    const upload = context.mocks.deferred<ArrayBuffer>();
    context.mocks.browser.voiceInput({
      rms: 0.12,
      onPcmCapture: capture.resolve,
      finalPcmSamples: new Float32Array(1024).fill(-0.75),
    });
    const consoleErrors = installVoiceBoundaries();
    context.mocks.http.post(
      "*/api/voice-io/transcribe/segment",
      async ({ request }) => {
        upload.resolve(await uploadedAudio(request));
        return HttpResponse.json({
          transcript: "complete",
          polishedText: "Complete recording.",
          language: "en-US",
        });
      },
    );
    await setupPage({ context, path, featureSwitches: flags });
    click(await findEnabledButton("Voice input"));
    const emit = await capture.promise;
    emit(new Float32Array(4096).fill(0.25));
    // Stop immediately: it must drain both queued writes and the final chunk.
    click(await findEnabledButton("Stop recording"));
    const samples = decodeVoiceDraftPcmWav(await upload.promise);
    expect(samples).toHaveLength(5120);
    expect(samples?.[4095]).toBeCloseTo(0.25, 4);
    expect(samples?.[4096]).toBeCloseTo(-0.75, 4);
    expect(samples?.at(-1)).toBeCloseTo(-0.75, 4);
    await findEnabledButton("Voice input");
    await waitFor(async () => {
      return await expect(savedRecording()).resolves.toBeNull();
    });
    expect(consoleErrors).toStrictEqual([]);
  },
);

test.each([
  { path: RUN_PATH, empty: true },
  { path: NEW_CHAT_PATH, empty: true },
  { path: RUN_PATH, empty: false },
  { path: NEW_CHAT_PATH, empty: false },
])(
  "Do not restore a completed silent recording at $path (empty: $empty)",
  async ({ path, empty }) => {
    // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
    const firstPage = createChildAbortController(context.signal);
    context.mocks.browser.voiceInput({
      rms: 0,
      onPcmCapture: (emit) => {
        emit(new Float32Array(4096));
      },
      finalPcmSamples: new Float32Array(empty ? 0 : 4096),
    });
    const consoleErrors = installVoiceBoundaries();
    const uploads: ArrayBuffer[] = [];
    context.mocks.http.post(
      "*/api/voice-io/transcribe/segment",
      async ({ request }) => {
        uploads.push(await uploadedAudio(request));
        return new HttpResponse(null, { status: 204 });
      },
    );
    await setupPage({
      context: { ...context, signal: firstPage.signal },
      path,
      featureSwitches: flags,
    });
    click(await findEnabledButton("Voice input"));
    click(await findEnabledButton("Stop recording"));
    await findEnabledButton("Voice input");
    expect(queryButton("Retry")).toBeNull();
    expect(uploads).toHaveLength(1);
    unload(firstPage);
    await setupPage({ context: secondContext, path, featureSwitches: flags });
    await findEnabledButton("Voice input");
    expect(queryButton("Retry")).toBeNull();
    expect(queryButton("Stop recording")).toBeNull();
    expect(consoleErrors).toStrictEqual([]);
  },
);

test("Stop capture and expose a failed chunk write without discarding the saved prefix", async () => {
  const capture = context.mocks.deferred<(samples: Float32Array) => void>();
  context.mocks.browser.voiceInput({
    rms: 0.12,
    onPcmCapture: capture.resolve,
  });
  const consoleErrors = installVoiceBoundaries();
  await setupPage({ context, path: RUN_PATH, featureSwitches: flags });
  click(await findEnabledButton("Voice input"));
  const emit = await capture.promise;
  emit(new Float32Array(4096).fill(0.25));
  await findEnabledButton("Stop recording");
  await waitFor(async () => {
    return await expect(savedRecording()).resolves.toMatchObject({
      sampleCount: 4096,
    });
  });
  const add = IDBObjectStore.prototype.add;
  const storageError = new DOMException(
    "Storage is full",
    "QuotaExceededError",
  );
  vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === "chunks") {
      throw storageError;
    }
    return add.apply(this, args);
  });
  emit(new Float32Array(4096).fill(0.5));
  await findEnabledButton("Retry");
  expect(screen.getByRole("status")).toHaveTextContent(
    "Audio could not be saved. Retry can recover only audio already saved on this device.",
  );
  expect(queryButton("Stop recording")).toBeNull();
  await expect(savedRecording()).resolves.toMatchObject({
    sampleCount: 4096,
    chunkCount: 1,
  });
  expect(consoleErrors).toStrictEqual([
    [
      "[E][Composer:VoiceDraft]",
      "Voice recording could not be saved",
      storageError,
    ],
  ]);
});

test("Restore audio when voice input v2 enables after the composer mounts", async () => {
  // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
  const firstPage = createChildAbortController(context.signal);
  context.mocks.browser.voiceInput({ rms: 0.12 });
  installVoiceBoundaries();
  context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
    return HttpResponse.json({ error: "Temporary outage" }, { status: 503 });
  });
  await setupPage({
    context: { ...context, signal: firstPage.signal },
    path: RUN_PATH,
    featureSwitches: flags,
  });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await findEnabledButton("Retry");
  unload(firstPage);
  const enableVoice = context.mocks.deferred<void>();
  context.mocks.api(featureSwitchesContract.get, async ({ respond }) => {
    await enableVoice.promise;
    return respond(200, { switches: flags, effectiveSwitches: flags });
  });
  await setupPage({
    context: secondContext,
    path: RUN_PATH,
  });
  await expect(findEnabledButton("Voice input")).resolves.not.toHaveAttribute(
    "aria-keyshortcuts",
  );
  expect(queryButton("Retry")).toBeNull();
  enableVoice.resolve();
  await findEnabledButton("Retry");
  expect(queryButton("Stop recording")).toBeNull();
  click(await findEnabledButton("Remove voice draft"));
  await expect(findEnabledButton("Voice input")).resolves.toHaveAttribute(
    "aria-keyshortcuts",
  );
  await expect(savedRecording()).resolves.toBeNull();
});
