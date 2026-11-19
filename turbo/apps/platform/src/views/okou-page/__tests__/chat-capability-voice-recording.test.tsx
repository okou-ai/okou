import { voiceIoPolishSegmentsContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import { findButton, queryButton } from "./chat-run-test-fixtures.ts";

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
