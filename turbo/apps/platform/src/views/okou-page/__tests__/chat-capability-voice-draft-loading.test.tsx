import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { act } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { decodeVoiceDraftPcmWav } from "../../../signals/voice-io/voice-draft-pcm.ts";
import {
  context,
  findEnabledButton,
  installRunChat,
  queryButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

function installVoiceInput(): void {
  installRunChat();
  context.mocks.browser.voiceInput({ rms: 0.12 });
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: true, count: 0, limit: 60 });
  });
  context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
    return HttpResponse.json({
      transcript: "voice note",
      polishedText: "Voice note.",
      language: "en-US",
    });
  });
}

test("Wait for nonempty PCM before showing the waveform and preserve the opening audio", async () => {
  installVoiceInput();
  const connected = context.mocks.deferred<(samples: Float32Array) => void>();
  const uploaded = context.mocks.deferred<ArrayBuffer>();
  context.mocks.browser.voiceInput({
    rms: 0,
    onPcmCapture: connected.resolve,
    finalPcmSamples: new Float32Array(0),
  });
  context.mocks.http.post(
    "*/api/voice-io/transcribe/segment",
    async ({ request }) => {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new Error("Expected recorded audio");
      }
      uploaded.resolve(await file.arrayBuffer());
      return HttpResponse.json({
        transcript: "opening words",
        polishedText: "Opening words.",
        language: "en-US",
      });
    },
  );
  await setupPage({ context, path: RUN_PATH });
  click(await findEnabledButton("Voice input"));
  const emit = await connected.promise;
  // Flush startup work while the connected worklet supplies no real samples.
  await act(() => {
    emit(new Float32Array(0));
  });
  expect(queryButton("Starting voice input")).toBeDisabled();
  expect(queryButton("Stop recording")).toBeNull();
  expect(document.querySelector("[data-voice-level-waveform]")).toBeNull();

  const firstBatch = new Float32Array(4096);
  emit(firstBatch);
  const stop = await findEnabledButton("Stop recording");
  expect(document.querySelector("[data-voice-level-waveform]")).toBeVisible();
  const openingAudio = new Float32Array(4096).fill(-0.5);
  emit(openingAudio);
  click(stop);
  const samples = decodeVoiceDraftPcmWav(await uploaded.promise);
  expect(samples).toHaveLength(8192);
  expect(samples?.slice(0, 4096)).toStrictEqual(firstBatch);
  expect(samples?.slice(4096)).toStrictEqual(openingAudio);
  await findEnabledButton("Voice input");
});
