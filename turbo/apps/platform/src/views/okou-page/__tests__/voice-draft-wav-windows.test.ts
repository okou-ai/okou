import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { voiceIoPolishSegmentsContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatCapabilityHelpers,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import { findEnabledButton } from "./chat-run-test-fixtures.ts";
const context = testContext();
const rate = 16_000;
function speech(count: number) {
  return Float32Array.from({ length: count }, (_, i) => {
    return [1, -1, 0.25, -0.25, 0][i % 5]!;
  });
}
async function record(live: number, tail: number) {
  const files: {
    start: number;
    length: number;
    type: string;
    pcm: Int16Array;
    overlap: number;
  }[] = [];
  context.mocks.browser.voiceInput({
    rms: 0.3,
    vadProbability: 0.95,
    onPcmCapture(emit) {
      emit(speech(live));
    },
    finalPcmSamples: speech(tail),
  });
  context.mocks.http.post(
    "*" + voiceIoTranscribeContract.segment.path,
    async ({ request }) => {
      const fields = await request.formData();
      const file = fields.get("file");
      if (!(file instanceof File)) {
        throw new Error("Expected microphone audio");
      }
      const pcm = new Int16Array(await file.arrayBuffer(), 44);
      const metadata = JSON.parse(String(fields.get("options"))) as {
        overlapDurationSeconds: number;
      };
      files.push({
        start: Number(file.name.match(/(\d+)\.wav$/)?.[1]),
        length: pcm.length,
        type: file.type,
        pcm,
        overlap: metadata.overlapDurationSeconds,
      });
      return HttpResponse.json({
        transcript: "Window " + String(files.length),
        language: "en",
      });
    },
  );
  context.mocks.api(voiceIoPolishSegmentsContract.post, ({ body, respond }) => {
    return respond(200, { text: body.segments.join(" ") });
  });
  createChatCapabilityHelpers(context).installCapabilityChat({ events: [] });
  await setupPage({ context, path: RUN_PATH });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  click(await findEnabledButton("Voice input"));
  const stop = await findEnabledButton("Stop recording");
  return { editor, files, stop };
}
test("voice-draft-audio-014 A stopped 42-second recording transcribes four overlapping windows", async () => {
  const { files, editor, stop } = await record(rate, 41 * rate);
  click(stop);
  await waitFor(() => {
    return expect(editor).toHaveTextContent(
      "Window 1 Window 2 Window 3 Window 4",
    );
  });
  expect(
    files.map((file) => {
      return [
        file.start / rate,
        (file.start + file.length) / rate,
        file.overlap,
      ];
    }),
  ).toStrictEqual([
    [0, 15, 0],
    [13, 28, 2],
    [26, 41, 2],
    [39, 42, 2],
  ]);
});
test("voice-draft-audio-002 The first full window is delivered while the microphone is still recording", async () => {
  const { files, stop, editor } = await record(240_000, 0);
  await waitFor(() => {
    return expect(files[0]?.length).toBe(240_000);
  });
  expect(files[0]?.start).toBe(0);
  expect(stop).toBeEnabled();
  click(stop);
  await waitFor(() => {
    return expect(editor).toHaveTextContent("Window 1");
  });
});
test("voice-draft-audio-007 Stopping at 448000 samples retains the previous window's last two seconds", async () => {
  const { files, stop, editor } = await record(240_000, 208_000);
  await waitFor(() => {
    return expect(files[0]?.length).toBe(240_000);
  });
  click(stop);
  await waitFor(() => {
    return expect(editor).toHaveTextContent("Window 1 Window 2");
  });
  expect(
    files.map((f) => {
      return [f.start, f.start + f.length, f.overlap];
    }),
  ).toStrictEqual([
    [0, 240_000, 0],
    [208_000, 448_000, 2],
  ]);
});
