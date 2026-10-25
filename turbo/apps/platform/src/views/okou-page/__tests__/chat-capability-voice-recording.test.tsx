import { voiceIoPolishSegmentsRequestSchema } from "@okouai/api-contracts/contracts/voice-io-polish";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { openDB, type DBSchema } from "idb";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import type { VoiceDraftRecordingRecord } from "../../../signals/external/voice-draft-store.ts";
import { resetSignal } from "../../../signals/utils.ts";
import { decodeVoiceDraftPcmWav } from "../../../signals/voice-io/voice-draft-pcm.ts";
import {
  createChatRunFixtures,
  findEnabledButton,
  queryButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
// Preserve independent replacement app/worker graphs without reinstalling HTML.
const secondContext = createTestRuntime(context);
interface RecordingDatabase extends DBSchema {
  drafts: {
    key: string;
    value: VoiceDraftRecordingRecord;
  };
}

async function savedRecording() {
  const database = await openDB<RecordingDatabase>("okou-voice-drafts");
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
  installRunChat({ selectedModel: null });
  context.mocks.data.availableRunModels([]);
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: true, count: 0, limit: 60 });
  });
}

async function uploadedAudio(request: Request): Promise<ArrayBuffer> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new Error("Expected recorded audio");
  }
  return await file.arrayBuffer();
}

function owningComposer(control: HTMLElement): HTMLElement {
  const composer = control.closest("[data-chat-composer]");
  if (!(composer instanceof HTMLElement)) {
    throw new Error("Expected a voice control inside the chat composer");
  }
  return composer;
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
  context.mocks.http.post("*/api/voice-io/polish/segments", () => {
    return HttpResponse.json({ text: "Recovered audio." });
  });
  context.mocks.http.post(
    "*/api/voice-io/transcribe/segment",
    async ({ request }) => {
      uploads.push(await uploadedAudio(request));
      return HttpResponse.json({
        transcript: "recovered",

        language: "en-US",
      });
    },
  );
  await setupPage({
    locale: "en-US",
    context: { ...context, signal: firstPageSignal },
    path: RUN_PATH,
  });
  const voiceInput = await findEnabledButton("Voice input");
  const firstComposer = owningComposer(voiceInput);
  click(voiceInput);
  const emit = await capture.promise;
  emit(new Float32Array(4096).fill(0.25));
  await waitFor(async () => {
    await expect(savedRecording()).resolves.toMatchObject({
      sampleCount: 4096,
      chunkCount: 1,
    });
  });
  await findEnabledButton("Stop recording", firstComposer);

  context.store.set(resetFirstPage$);
  releasePageDom();
  const openDatabase = globalThis.indexedDB.open.bind(globalThis.indexedDB);
  const failedRead = vi
    .spyOn(globalThis.indexedDB, "open")
    .mockImplementation((name, version) => {
      if (name === "okou-voice-drafts") {
        throw new DOMException(
          "Storage is temporarily unavailable",
          "UnknownError",
        );
      }
      return openDatabase(name, version);
    });
  await setupPage({
    locale: "en-US",
    context: secondContext,
    path: RUN_PATH,
  });

  const retryButton = await findEnabledButton("Retry");
  const restoredComposer = owningComposer(retryButton);
  expect(
    within(restoredComposer).getByText(
      "Audio could not be saved. Retry can recover only audio already saved on this device.",
    ),
  ).toBeInTheDocument();
  failedRead.mockRestore();
  expect(queryButton("Stop recording")).toBeNull();
  click(retryButton);
  await findEnabledButton("Voice input", restoredComposer);
  expect(
    within(restoredComposer).getByRole("textbox", { name: "Message" }),
  ).toHaveTextContent("Recovered audio.");
  expect(uploads).toHaveLength(1);
  const samples = decodeVoiceDraftPcmWav(uploads[0]!);
  expect(samples).toHaveLength(4096);
  expect(samples?.at(-1)).toBeCloseTo(0.25, 4);
});

test("Include the final worklet chunk before transcribing", async () => {
  const capture = context.mocks.deferred<(samples: Float32Array) => void>();
  const upload = context.mocks.deferred<ArrayBuffer>();
  context.mocks.browser.voiceInput({
    rms: 0.12,
    onPcmCapture: capture.resolve,
    finalPcmSamples: new Float32Array(1024).fill(-0.75),
  });
  installVoiceBoundaries();
  context.mocks.http.post("*/api/voice-io/polish/segments", () => {
    return HttpResponse.json({ text: "Complete recording." });
  });
  context.mocks.http.post(
    "*/api/voice-io/transcribe/segment",
    async ({ request }) => {
      upload.resolve(await uploadedAudio(request));
      return HttpResponse.json({
        transcript: "complete",

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
});

test("Restore completed transcripts after reload and retry only polish", async () => {
  const resetFirstPage$ = resetSignal();
  const firstPageSignal = context.store.set(resetFirstPage$, context.signal);
  context.mocks.browser.voiceInput({ rms: 0.12 });
  installVoiceBoundaries();
  let transcribed = false;
  let polishAvailable = false;
  context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
    if (transcribed) {
      return HttpResponse.json(
        {
          error: {
            code: "UNEXPECTED_RETRANSCRIPTION",
            message: "Completed audio must not be uploaded again",
          },
        },
        { status: 502 },
      );
    }
    transcribed = true;
    return HttpResponse.json({
      transcript: "Keep this saved speech.",
      language: "en",
    });
  });
  context.mocks.http.post(
    "*/api/voice-io/polish/segments",
    async ({ request }) => {
      await expect(request.json()).resolves.toMatchObject({
        segments: ["Keep this saved speech."],
      });
      return polishAvailable
        ? HttpResponse.json({ text: "Keep this saved speech." })
        : HttpResponse.json(
            {
              error: {
                code: "PROVIDER_UNAVAILABLE",
                message: "Editing is busy",
              },
            },
            { status: 503 },
          );
    },
  );
  await setupPage({
    context: { ...context, signal: firstPageSignal },
    path: RUN_PATH,
  });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await findEnabledButton("Retry");
  await expect(
    screen.findByText("Editing is busy", { exact: false }),
  ).resolves.toBeInTheDocument();
  context.store.set(resetFirstPage$);
  releasePageDom();
  polishAvailable = true;
  await setupPage({ context: secondContext, path: RUN_PATH });
  click(await findEnabledButton("Retry"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Keep this saved speech.",
    );
  });
});

test.each([
  [128, 1],
  [129, 2],
  [277, 3],
])(
  "Restore %i completed segments with %i transcripts per polish item",
  async (segmentCount, groupSize) => {
    const resetFirstPage$ = resetSignal();
    const firstPageSignal = context.store.set(resetFirstPage$, context.signal);
    context.mocks.browser.voiceInput({ rms: 0.12 });
    installVoiceBoundaries();
    let uploads = 0;
    context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
      uploads += 1;
      return HttpResponse.json({ transcript: "Saved speech.", language: "en" });
    });
    const transcripts = Array.from({ length: segmentCount }, (_, index) => {
      return `Part ${index + 1}: keep every  word.`;
    });
    const fullText = transcripts.join(" ");
    let restored = false;
    let available = false;
    const requests: unknown[] = [];
    context.mocks.http.post(
      "*/api/voice-io/polish/segments",
      async ({ request }) => {
        if (restored) {
          requests.push(await request.json());
        }
        return available
          ? HttpResponse.json({ text: fullText })
          : HttpResponse.json(
              {
                error: {
                  code: "PROVIDER_UNAVAILABLE",
                  message: "Editing is busy",
                },
              },
              { status: 503 },
            );
      },
    );
    await setupPage({
      context: { ...context, signal: firstPageSignal },
      path: RUN_PATH,
    });
    click(await findEnabledButton("Voice input"));
    click(await findEnabledButton("Stop recording"));
    await findEnabledButton("Retry");
    context.store.set(resetFirstPage$);
    releasePageDom();

    // Restore long-recording metadata without allocating an hour of PCM.
    const database = await openDB<RecordingDatabase>("okou-voice-drafts");
    const key = (await database.getAllKeys("drafts"))[0];
    if (!key) {
      throw new Error("Expected a saved recording key");
    }
    const recording = await database.get("drafts", key);
    if (!recording?.progress) {
      throw new Error("Expected completed transcription progress");
    }
    const sampleCount = Math.min(3600, 15 + (segmentCount - 1) * 13) * 16_000;
    const segments = transcripts.map((transcript, index) => {
      return {
        startSample: index * 13 * 16_000,
        endSample: Math.min(sampleCount, (15 + index * 13) * 16_000),
        final: index === segmentCount - 1,
        transcript,
      };
    });
    await database.put(
      "drafts",
      {
        ...recording,
        sampleCount,
        progress: { ...recording.progress, segments },
      },
      key,
    );
    database.close();
    restored = true;
    await setupPage({ context: secondContext, path: RUN_PATH });
    click(await findEnabledButton("Retry"));
    await expect(
      screen.findByText("Editing is busy", { exact: false }),
    ).resolves.toBeInTheDocument();
    await findEnabledButton("Retry");
    expect((await savedRecording())?.progress?.segments).toStrictEqual(
      segments,
    );
    available = true;
    click(await findEnabledButton("Retry"));
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe(
        fullText,
      );
    });
    const bodies = requests.map((body) => {
      return voiceIoPolishSegmentsRequestSchema.parse(body);
    });
    const expectedSegments = Array.from(
      { length: Math.ceil(segmentCount / groupSize) },
      (_, index) => {
        return transcripts
          .slice(index * groupSize, (index + 1) * groupSize)
          .join(" ");
      },
    );
    expect(requests).toStrictEqual(bodies);
    expect(bodies).toStrictEqual([
      { segments: expectedSegments },
      { segments: expectedSegments },
    ]);
    expect(uploads).toBe(1);
  },
);
