import { act, waitFor } from "@testing-library/react";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { HttpResponse } from "msw";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
const context = testContext();
test("chat-capability-voice-draft-loading-001 the first real PCM buffer enables Stop and neither buffer is lost", async () => {
  const connected = context.mocks.deferred<(data: Float32Array) => void>();
  const uploaded = context.mocks.deferred<ArrayBuffer>();
  context.mocks.browser.voiceInput({
    rms: 0.25,
    onPcmCapture: (emit) => {
      return connected.resolve(emit);
    },
    finalPcmSamples: new Float32Array(0),
  });
  context.mocks.http.post(
    "*" + voiceIoTranscribeContract.segment.path,
    async ({ request }) => {
      const audio = (await request.formData()).get("file");
      if (!(audio instanceof File)) {
        throw new Error("Expected audio file");
      }
      uploaded.resolve(await audio.arrayBuffer());
      return HttpResponse.json({
        transcript: "Audio received",
        language: "en",
      });
    },
  );
  await setupPage({ context, path: "/" });
  const start = await findAction("button", "Voice input");
  await waitFor(() => {
    return expect(start).toBeEnabled();
  });
  click(start);
  await waitFor(() => {
    return expect(connected.settled()).toBeTruthy();
  });
  const emit = await connected.promise;
  await expect(
    findAction("button", "Starting voice input"),
  ).resolves.toBeDisabled();
  expect(queryAction("button", "Stop recording")).toBeNull();
  expect(document.querySelector("[data-voice-level-waveform]")).toBeNull();
  act(() => {
    return emit(new Float32Array(0));
  });
  await expect(
    findAction("button", "Starting voice input"),
  ).resolves.toBeDisabled();
  expect(queryAction("button", "Stop recording")).toBeNull();
  expect(document.querySelector("[data-voice-level-waveform]")).toBeNull();
  act(() => {
    return emit(new Float32Array(4096).fill(0.25));
  });
  const stop = await findAction("button", "Stop recording");
  await waitFor(() => {
    return expect(
      document.querySelector("[data-voice-level-waveform]"),
    ).toBeVisible();
  });
  act(() => {
    return emit(new Float32Array(4096).fill(-0.25));
  });
  click(stop);
  await waitFor(() => {
    return expect(uploaded.settled()).toBeTruthy();
  });
  const bytes = await uploaded.promise;
  const samples = new Int16Array(bytes, 44);
  expect(samples).toHaveLength(8192);
  expect(
    samples.slice(0, 4096).every((n) => {
      return Math.abs(n - 8192) <= 1;
    }),
  ).toBeTruthy();
  expect(
    samples.slice(4096).every((n) => {
      return Math.abs(n + 8192) <= 1;
    }),
  ).toBeTruthy();
});
