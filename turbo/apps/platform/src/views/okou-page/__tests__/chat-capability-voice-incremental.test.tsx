import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { screen, waitFor } from "@testing-library/react";
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
import {
  createChatRunFixtures,
  findButton,
  findEnabledButton,
} from "./chat-run-test-fixtures.ts";
import { initSentry } from "../../../lib/sentry.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);
const { installRunChat } = createChatRunFixtures(context);

const endpoint = "*/api/voice-io/transcribe/segment";

async function beginRecording(): Promise<HTMLElement> {
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  const voice = await findButton("Voice input");
  await waitFor(() => {
    expect(voice).toBeEnabled();
  });
  click(voice);
  const stop = await findButton("Stop recording");
  await waitFor(() => {
    expect(stop).toBeEnabled();
  });
  return stop;
}

test("Continue recording after an incremental transcription outage", async () => {
  installCapabilityChat({ events: completedConversation("Ready to help.") });
  const capture = context.mocks.deferred<(samples: Float32Array) => void>();
  context.mocks.browser.voiceInput({
    rms: 0.1,
    onPcmCapture: (emit) => {
      emit(new Float32Array(4096).fill(0.25));
      capture.resolve(emit);
    },
  });
  const incrementalRequest = context.mocks.deferred<void>();
  const sendFailure = context.mocks.deferred<void>();
  context.mocks.http.post(
    `*${voiceIoTranscribeContract.segment.path}`,
    async ({ request }) => {
      const form = await request.formData();
      expect(form.get("file")).toBeInstanceOf(Blob);
      incrementalRequest.resolve();
      await sendFailure.promise;
      return HttpResponse.json(
        {
          error: {
            code: "PROVIDER_UNAVAILABLE",
            message: "Speech recognition is temporarily busy.",
          },
        },
        { status: 503 },
      );
    },
  );

  const stop = await beginRecording();
  const emit = await capture.promise;
  emit(new Float32Array(16_000 * 16).fill(0.25));
  await incrementalRequest.promise;
  sendFailure.resolve();
  expect(stop).toBeEnabled();
  emit(new Float32Array(4096).fill(0.25));
  click(stop);

  await expect(findButton("Remove voice draft")).resolves.toBeEnabled();
  await expect(
    screen.findByText("Speech recognition is temporarily busy."),
  ).resolves.toBeInTheDocument();
});

test("Keep genuine transcription failures actionable", async () => {
  const status = 502;
  const code = "VOICE_TRANSCRIPTION_FAILED";
  const sentry = context.mocks.sentry();
  initSentry();
  context.mocks.browser.voiceInput({ rms: 0.1 });
  installRunChat();
  context.mocks.http.post(endpoint, () => {
    return HttpResponse.json(
      { error: { code, message: "Transcription configuration failed" } },
      { status },
    );
  });
  await setupPage({ context, path: RUN_PATH });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await findEnabledButton("Remove voice draft");
  await expect(
    screen.findByText("Transcription configuration failed"),
  ).resolves.toBeVisible();
  expect(sentry.reports).toContainEqual(
    expect.objectContaining({
      type: "exception",
      error: expect.objectContaining({ code, status }),
    }),
  );
});
