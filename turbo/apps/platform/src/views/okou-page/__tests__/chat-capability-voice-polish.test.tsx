import { voiceIoPolishSegmentsContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";

const context = testContext();

const SAMPLE_RATE = 16_000;
const EARLIER_SECONDS = 15;

async function findControl(name: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const control = queryAllByRoleFast("button").find((button) => {
      return button.getAttribute("aria-label") === name;
    });
    if (!control) {
      throw new Error(`Expected control ${name}`);
    }
    return control;
  });
}

test("Apply VAD to the new audio of a one-second tail: silent", async () => {
  context.mocks.browser.voiceInput({
    rms: 0.1,
    vadProbability: 0.9,
    onPcmCapture(emit) {
      for (let second = 0; second < EARLIER_SECONDS; second += 1) {
        emit(new Float32Array(SAMPLE_RATE).fill(0.1));
      }
    },
    finalPcmSamples: new Float32Array(SAMPLE_RATE),
  });
  const transcriptions: number[] = [];
  context.mocks.http.post(
    `*${voiceIoTranscribeContract.segment.path}`,
    async ({ request }) => {
      const file = (await request.formData()).get("file");
      transcriptions.push(file instanceof File ? file.size : 0);
      return HttpResponse.json({
        transcript: "Earlier speech.",
        language: "en",
      });
    },
  );
  const polished: unknown[] = [];
  context.mocks.api(voiceIoPolishSegmentsContract.post, ({ body, respond }) => {
    polished.push(body);
    return respond(200, { text: "Earlier speech." });
  });
  await setupPage({ context, path: "/" });
  const voiceInput = await findControl("Voice input");
  await waitFor(() => {
    expect(voiceInput).toBeEnabled();
  });
  click(voiceInput);
  const stop = await findControl("Stop recording");
  await waitFor(() => {
    expect(transcriptions).toHaveLength(1);
  });
  await waitFor(() => {
    expect(stop).toBeEnabled();
  });

  click(stop);

  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(editor).toHaveTextContent(/^Earlier speech\.$/u);
  });
  expect(transcriptions).toHaveLength(1);
  expect(polished).toStrictEqual([{ segments: ["Earlier speech."] }]);
});
