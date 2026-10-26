import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  findEnabledButton,
  RUN_PATH,
  createChatRunFixtures,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const transcribeEndpoint = "*/api/voice-io/transcribe/segment";
const polishEndpoint = "*/api/voice-io/polish/segments";

test.each([
  { label: "silent", tail: 0, probability: 0.9, expected: ["Earlier speech."] },
  {
    label: "a short uncertain word",
    tail: 0.1,
    probability: 0.2,
    expected: ["Earlier speech.", "Tomorrow."],
  },
])(
  "Apply VAD to the new audio of a one-second tail: $label",
  async ({ tail, probability, expected }) => {
    const capture = context.mocks.deferred<(samples: Float32Array) => void>();
    context.mocks.browser.voiceInput({
      rms: 0.1,
      vadProbability: probability,
      onPcmCapture: capture.resolve,
      finalPcmSamples: new Float32Array(0),
    });
    installRunChat();
    let uploaded = 0;
    context.mocks.http.post(transcribeEndpoint, () => {
      return HttpResponse.json({
        transcript: uploaded++ === 0 ? "Earlier speech." : "Tomorrow.",
        language: "en",
      });
    });
    context.mocks.http.post(polishEndpoint, async ({ request }) => {
      await expect(request.json()).resolves.toMatchObject({
        segments: expected,
      });
      return HttpResponse.json({ text: expected.join(" ") });
    });
    await setupPage({ context, path: RUN_PATH });
    click(await findEnabledButton("Voice input"));
    const emit = await capture.promise;
    emit(new Float32Array(15 * 16_000).fill(0.1));
    emit(new Float32Array(16_000).fill(tail));
    click(await findEnabledButton("Stop recording"));
    await waitFor(() => {
      expect(
        screen.getByRole("textbox", { name: "Message" }),
      ).toHaveTextContent(expected.join(" "));
    });
  },
);
