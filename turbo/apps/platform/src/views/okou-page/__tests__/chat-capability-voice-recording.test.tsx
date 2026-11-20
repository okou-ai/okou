import {
  voiceIoPolishSegmentsContract,
  voiceIoPolishSegmentsRequestSchema,
} from "@okouai/api-contracts/contracts/voice-io-polish";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { cleanup, screen, waitFor } from "@testing-library/react";
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
import {
  completedConversation,
  createChatCapabilityHelpers,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import {
  createChatRunFixtures,
  findButton,
  findEnabledButton,
  queryButton,
} from "./chat-run-test-fixtures.ts";

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
const { installRunChat } = createChatRunFixtures(context);
// Preserve independent replacement app/worker graphs without reinstalling HTML.
const secondContext = createTestRuntime(context);
interface RecordingDatabase extends DBSchema {
  drafts: {
    key: string;
    value: VoiceDraftRecordingRecord;
  };
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

async function wavSamples(file: FormDataEntryValue | null): Promise<number[]> {
  if (!(file instanceof Blob)) {
    throw new Error("Transcription request has no audio file");
  }
  const view = new DataView(await file.arrayBuffer());
  const samples: number[] = [];
  for (let offset = 44; offset < view.byteLength; offset += 2) {
    samples.push(view.getInt16(offset, true));
  }
  return samples;
}

test("Include the final worklet chunk before transcribing", async () => {
  installCapabilityChat({ events: completedConversation("Ready to help.") });
  context.mocks.browser.voiceInput({
    rms: 0.1,
    onPcmCapture(emit) {
      emit(new Float32Array(4096).fill(0.25));
    },
    finalPcmSamples: new Float32Array(1024).fill(0.5),
  });
  const audio: FormDataEntryValue[] = [];
  context.mocks.http.post(
    `*${voiceIoTranscribeContract.segment.path}`,
    async ({ request }) => {
      const body = await request.formData();
      const file = body.get("file");
      if (file) {
        audio.push(file);
      }
      return HttpResponse.json({ transcript: "final chunk", language: "en" });
    },
  );
  context.mocks.api(voiceIoPolishSegmentsContract.post, ({ respond }) => {
    return respond(200, { text: "Final chunk." });
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
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

  await waitFor(() => {
    expect(audio).toHaveLength(1);
  });
  await waitFor(() => {
    expect(getButton("Voice input")).toBeEnabled();
  });
  const samples = await wavSamples(audio[0] ?? null);
  expect(samples).toHaveLength(5120);
  expect(
    samples.slice(0, 4096).every((sample) => {
      return sample === 8192;
    }),
  ).toBeTruthy();
  expect(
    samples.slice(4096).every((sample) => {
      return sample === 16_384;
    }),
  ).toBeTruthy();
});

test.each([
  [128, 1],
  [129, 2],
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
    await findEnabledButton("Remove voice draft");
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
    available = true;
    await setupPage({ context: secondContext, path: RUN_PATH });
    click(await findEnabledButton("Use recording"));
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
    expect(bodies).toStrictEqual([{ segments: expectedSegments }]);
    expect(uploads).toBe(1);
  },
);
