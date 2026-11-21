import { findEnabledButton } from "./chat-run-test-fixtures.ts";
import { voiceIoPolishSegmentsContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { HttpResponse } from "msw";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatCapabilityHelpers,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
test("chat-capability-voice-polish-001 polishes the earlier speech without the recording's silent final second", async () => {
  const sampleRate = 16_000;
  context.mocks.browser.voiceInput({
    rms: 0.18,
    onPcmCapture(emit) {
      emit(new Float32Array(15 * sampleRate).fill(0.18));
    },
    finalPcmSamples: new Float32Array(sampleRate),
    vadProbability: 0.9,
  });
  context.mocks.http.post(
    "*" + voiceIoTranscribeContract.segment.path,
    async ({ request }) => {
      const audio = (await request.formData()).get("file") as File;
      const pcm = new Int16Array(await audio.arrayBuffer(), 44);
      const transcript =
        pcm.at(-1) === 0 ? "Spurious tail." : "Earlier speech.";
      return HttpResponse.json({ transcript, language: "en" });
    },
  );
  context.mocks.api(voiceIoPolishSegmentsContract.post, ({ body, respond }) => {
    return respond(200, { text: body.segments.join(" ") });
  });
  createChatCapabilityHelpers(context).installCapabilityChat({ events: [] });
  await setupPage({ context, path: RUN_PATH });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await waitFor(() => {
    expect(editor.textContent).toBe("Earlier speech.");
  });
});
