import { voiceIoPolishSegmentsContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { act, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const BATCH_SAMPLES = 4096;
const OPENING_LEVEL = 0.25;
const LATER_LEVEL = 0.5;

function queryControl(name: string): HTMLElement | null {
  return (
    queryAllByRoleFast("button").find((button) => {
      return button.getAttribute("aria-label") === name;
    }) ?? null
  );
}

async function findControl(name: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const control = queryControl(name);
    if (!control) {
      throw new Error(`Expected control ${name}`);
    }
    return control;
  });
}

function filled(length: number, value: number): number[] {
  return Array.from({ length }, () => {
    return value;
  });
}

function wavSamples(buffer: ArrayBuffer): number[] {
  const view = new DataView(buffer);
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const size = view.getUint32(offset + 4, true);
    if (id === "data") {
      const samples: number[] = [];
      for (let index = 0; index < size / 2; index += 1) {
        samples.push(view.getInt16(offset + 8 + index * 2, true) / 32_768);
      }
      return samples;
    }
    offset += 8 + size;
  }
  throw new Error("Uploaded audio has no data chunk");
}

test("Wait for nonempty PCM before showing the waveform and preserve the opening audio", async () => {
  let emitPcm: ((samples: Float32Array) => void) | undefined;
  context.mocks.browser.voiceInput({
    rms: 0.1,
    onPcmCapture(emit) {
      emitPcm = emit;
    },
    finalPcmSamples: new Float32Array(BATCH_SAMPLES).fill(LATER_LEVEL),
  });
  const uploads: File[] = [];
  context.mocks.http.post(
    `*${voiceIoTranscribeContract.segment.path}`,
    async ({ request }) => {
      const file = (await request.formData()).get("file");
      if (file instanceof File) {
        uploads.push(file);
      }
      return HttpResponse.json({ transcript: "Opening words", language: "en" });
    },
  );
  context.mocks.api(voiceIoPolishSegmentsContract.post, ({ respond }) => {
    return respond(200, { text: "Opening words" });
  });
  await setupPage({ context, path: "/" });
  const voiceInput = await findControl("Voice input");
  await waitFor(() => {
    expect(voiceInput).toBeEnabled();
  });

  click(voiceInput);
  const starting = await findControl("Starting voice input");
  await waitFor(() => {
    expect(emitPcm).toBeDefined();
  });
  act(() => {
    emitPcm?.(new Float32Array(0));
  });
  expect(starting).toBeDisabled();
  expect(queryControl("Stop recording")).not.toBeInTheDocument();
  expect(
    document.querySelector("[data-voice-level-waveform]"),
  ).not.toBeInTheDocument();

  act(() => {
    emitPcm?.(new Float32Array(BATCH_SAMPLES).fill(OPENING_LEVEL));
  });
  const stop = await findControl("Stop recording");
  expect(
    document.querySelector("[data-voice-level-waveform]"),
  ).toBeInTheDocument();
  await waitFor(() => {
    expect(stop).toBeEnabled();
  });
  click(stop);

  await waitFor(() => {
    expect(uploads).toHaveLength(1);
  });
  const samples = wavSamples(await uploads[0]!.arrayBuffer());
  expect(samples).toHaveLength(BATCH_SAMPLES * 2);
  expect(samples.slice(0, BATCH_SAMPLES)).toStrictEqual(
    filled(BATCH_SAMPLES, OPENING_LEVEL),
  );
  expect(samples.slice(BATCH_SAMPLES)).toStrictEqual(
    filled(BATCH_SAMPLES, LATER_LEVEL),
  );
});
