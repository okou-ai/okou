import { voiceIoPolishSegmentsContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { act, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const QUEUED_SAMPLES = 4096;
const FINAL_SAMPLES = 1024;
const QUEUED_LEVEL = 0.25;
const FINAL_LEVEL = 0.5;

function queryControl(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((button) => {
    return button.getAttribute("aria-label") === name;
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
