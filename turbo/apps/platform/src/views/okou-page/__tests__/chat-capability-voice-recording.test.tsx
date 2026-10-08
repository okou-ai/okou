import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { openDB, type DBSchema } from "idb";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { resetSignal } from "../../../signals/utils.ts";
import { decodeVoiceDraftPcmWav } from "../../../signals/voice-io/voice-draft-pcm.ts";
import {
  context,
  findEnabledButton,
  installRunChat,
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

test("Recover committed PCM after a reload during recording", async () => {
  const resetFirstPage$ = resetSignal();
  const firstPageSignal = context.store.set(resetFirstPage$, context.signal);
  const capture = context.mocks.deferred<(samples: Float32Array) => void>();
  context.mocks.browser.voiceInput({
    rms: 0.12,
    onPcmCapture: capture.resolve,
    finalPcmSamples: new Float32Array(0),
  });
  installVoiceBoundaries();
  const uploads: ArrayBuffer[] = [];
  context.mocks.http.post(
    "*/api/voice-io/transcribe/segment",
    async ({ request }) => {
      uploads.push(await uploadedAudio(request));
      return HttpResponse.json({
        transcript: "recovered",
        polishedText: "Recovered audio.",
        language: "en-US",
      });
    },
  );
  await setupPage({
    locale: "en-US",
    context: { ...context, signal: firstPageSignal },
    path: RUN_PATH,
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

  context.store.set(resetFirstPage$);
  releasePageDom();
  await setupPage({
    locale: "en-US",
    context: secondContext,
    path: RUN_PATH,
  });

  const retryButton = await findEnabledButton("Retry");
  expect(queryButton("Stop recording")).toBeNull();
  click(retryButton);
  await findEnabledButton("Voice input");
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    "Recovered audio.",
  );
  expect(uploads).toHaveLength(1);
  const samples = decodeVoiceDraftPcmWav(uploads[0]!);
  expect(samples).toHaveLength(4096);
  expect(samples?.at(-1)).toBeCloseTo(0.25, 4);
  await waitFor(async () => {
    return await expect(savedRecording()).resolves.toBeNull();
  });
});

test("Include the final worklet chunk before transcribing", async () => {
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
  await setupPage({ context, path: RUN_PATH });
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
});
