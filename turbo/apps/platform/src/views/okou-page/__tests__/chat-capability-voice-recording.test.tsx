import { openDB } from "idb";
import { VOICE_IO_POLISH_MAX_SEGMENTS } from "@okouai/api-contracts/validators/voice-io-polish";
import { chatListAuth } from "./chat-list-test-helpers.ts";
import {
  voiceIoPolishSegmentsRequestSchema,
  voiceIoPolishSegmentsContract,
} from "@okouai/api-contracts/contracts/voice-io-polish";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const QUEUED_SAMPLES = 4096;
const FINAL_SAMPLES = 1024;
const QUEUED_LEVEL = 0.25;
const FINAL_LEVEL = 0.5;

function queryControl(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((button) => {
    return (
      (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name
    );
  });
}

async function findEnabledControl(name: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const control = queryControl(name);
    expect(control).toBeEnabled();
    return control as HTMLElement;
  });
}

/** The 16-bit PCM samples of an uploaded WAV file, as unit-range values. */
async function wavSamples(file: File): Promise<number[]> {
  const view = new DataView(await file.arrayBuffer());
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunk = String.fromCharCode(
      ...[0, 1, 2, 3].map((index) => {
        return view.getUint8(offset + index);
      }),
    );
    const size = view.getUint32(offset + 4, true);
    if (chunk === "data") {
      return Array.from({ length: size / 2 }, (_, index) => {
        return view.getInt16(offset + 8 + index * 2, true) / 32_768;
      });
    }
    offset += 8 + size;
  }
  throw new Error("The uploaded audio has no data chunk");
}

test("Include the final worklet chunk before transcribing", async () => {
  const microphone: { emit?: (samples: Float32Array) => void } = {};
  context.mocks.browser.voiceInput({
    rms: 0.2,
    onPcmCapture(emit) {
      microphone.emit = emit;
    },
    finalPcmSamples: new Float32Array(FINAL_SAMPLES).fill(FINAL_LEVEL),
  });
  // The latest audio the transcription service received.
  const transcription: { upload?: File } = {};
  context.mocks.http.post(
    `*${voiceIoTranscribeContract.segment.path}`,
    async ({ request }) => {
      const file = (await request.formData()).get("file");
      if (file instanceof File) {
        transcription.upload = file;
      }
      return HttpResponse.json({
        transcript: "Ship the build",
        language: "en",
      });
    },
  );
  context.mocks.api(voiceIoPolishSegmentsContract.post, ({ respond }) => {
    return respond(200, { text: "Ship the build." });
  });
  await setupPage({ context, path: "/" });
  click(await findEnabledControl("Voice input"));
  const emit = await waitFor(() => {
    if (!microphone.emit) {
      throw new Error("Expected the microphone to capture audio");
    }
    return microphone.emit;
  });

  act(() => {
    emit(new Float32Array(QUEUED_SAMPLES).fill(QUEUED_LEVEL));
  });
  click(await findEnabledControl("Stop recording"));

  await expect(
    screen.findByText("Ship the build."),
  ).resolves.toBeInTheDocument();
  await findEnabledControl("Voice input");
  const upload = transcription.upload;
  if (!upload) {
    throw new Error("Expected the recording to be transcribed");
  }
  const samples = await wavSamples(upload);
  expect(samples).toHaveLength(QUEUED_SAMPLES + FINAL_SAMPLES);
  expect(new Set(samples.slice(0, QUEUED_SAMPLES))).toStrictEqual(
    new Set([QUEUED_LEVEL]),
  );
  expect(new Set(samples.slice(QUEUED_SAMPLES))).toStrictEqual(
    new Set([FINAL_LEVEL]),
  );
});

test("A restored two-part recording uses both saved transcripts while the transcriber has different text", async () => {
  const total = 2;
  const labels = Array.from({ length: total }, (_, index) => {
    return "word" + String(index + 1);
  });

  let accepting = false;
  const firstPolish = context.mocks.deferred<void>();
  const rate = 16_000;
  const windowStep = 13 * rate;
  const microphone = new Float32Array((total - 1) * windowStep + 3 * rate);
  for (let index = 0; index < microphone.length; index++) {
    microphone[index] = index % 2 ? 0.4 : -0.4;
  }
  context.mocks.browser.voiceInput({
    rms: 0.3,
    vadProbability: 0.95,
    finalPcmSamples: microphone,
  });
  context.mocks.http.post(
    "*" + voiceIoTranscribeContract.segment.path,
    async ({ request }) => {
      const file = (await request.formData()).get("file");
      if (!(file instanceof File)) {
        throw new Error("Missing audio segment");
      }
      const start = Number(/(\d+)\.wav$/.exec(file.name)?.[1]);
      return HttpResponse.json({
        transcript: accepting ? "retranscribed" : labels[start / windowStep],
        language: "en",
      });
    },
  );
  context.mocks.api(voiceIoPolishSegmentsContract.post, ({ body, respond }) => {
    if (!accepting) {
      firstPolish.resolve();
      return respond(503, {
        error: {
          code: "PROVIDER_UNAVAILABLE",
          message: "Polishing is offline",
        },
      });
    }
    return respond(200, { text: body.segments.join(" | ") });
  });
  const original = createTestRuntime(context);
  await setupPage({ context: original, path: "/" });
  click(await findEnabledControl("Voice input"));
  click(await findEnabledControl("Stop recording"));
  await firstPolish.promise;
  await waitFor(() => {
    expect(queryControl("Use recording")).toBeDefined();
  });
  cleanup();
  original.dispose();
  accepting = true;
  await setupPage({ context, path: "/" });
  click(await findEnabledControl("Use recording"));
  const result = labels.join(" | ");
  await expect(screen.findByText(result)).resolves.toBeInTheDocument();
});

test("A reopened recording that lacks a completed transcript uses the recovered transcriber", async () => {
  context.mocks.browser.voiceInput({
    rms: 0.45,
    vadProbability: 0.99,
    finalPcmSamples: new Float32Array(4096).fill(0.4),
  });
  let restored = false;
  context.mocks.http.post("*" + voiceIoTranscribeContract.segment.path, () => {
    return restored
      ? HttpResponse.json({
          transcript: "Recovered from audio",
          language: "en",
        })
      : HttpResponse.json(
          {
            error: {
              code: "PROVIDER_UNAVAILABLE",
              message: "Transcription unavailable",
            },
          },
          { status: 503 },
        );
  });
  context.mocks.api(voiceIoPolishSegmentsContract.post, ({ body, respond }) => {
    return respond(200, { text: body.segments.join(" ") });
  });
  const first = createTestRuntime(context);
  await setupPage({ context: first, path: "/" });
  click(await findEnabledControl("Voice input"));
  click(await findEnabledControl("Stop recording"));
  await waitFor(() => {
    expect(queryControl("Use recording")).toBeDefined();
  });
  cleanup();
  first.dispose();
  restored = true;
  await setupPage({ context, path: "/" });
  click(await findEnabledControl("Use recording"));
  await expect(
    screen.findByText("Recovered from audio"),
  ).resolves.toBeInTheDocument();
});

test("A saved recording longer than one polish request restores the entire transcript to the message editor", async () => {
  context.mocks.browser.voiceInput({ rms: 0.2 });
  const words = Array.from({ length: VOICE_IO_POLISH_MAX_SEGMENTS }, (_, i) => {
    return "observation-" + String(i + 1);
  });
  words.push("end of the field notes");
  const database = await openDB("okou-voice-drafts", 2, {
    upgrade(db) {
      db.createObjectStore("drafts");
      db.createObjectStore("chunks");
    },
  });
  const key = JSON.stringify([
    "chat-list-user-917",
    "chat-list-org-917",
    "new-chat",
  ]);
  const id = crypto.randomUUID();
  const segments = words.map((transcript, index) => {
    return {
      startSample: index * 32,
      endSample: (index + 1) * 32,
      final: index + 1 === words.length,
      transcript,
    };
  });
  try {
    const samples = new Float32Array(words.length * 32);
    const tx = database.transaction(["drafts", "chunks"], "readwrite");
    await tx.objectStore("chunks").put(samples.buffer, [key, id, 0]);
    await tx.objectStore("drafts").put(
      {
        id,
        sampleCount: samples.length,
        chunkCount: 1,
        progress: { revision: 1, context: {}, segments },
      },
      key,
    );
    await tx.done;
  } finally {
    database.close();
  }
  const polish = context.mocks.deferred<void>();
  context.mocks.api(voiceIoPolishSegmentsContract.post, ({ body, respond }) => {
    const { segments } = voiceIoPolishSegmentsRequestSchema.parse(body);
    polish.resolve();
    return respond(200, { text: segments.join(" ") });
  });
  await setupPage({ context, auth: chatListAuth(917), path: "/" });
  click(await findEnabledControl("Use recording"));
  await polish.promise;
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe(
      words.join(" "),
    );
  });
});
