import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { act, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { setupSentryLogger } from "../../../lib/sentry-config.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
// One incremental segment is fifteen seconds of 16 kHz audio.
const SEGMENT_SAMPLES = 15 * 16_000;

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

/** Starts recording and returns the microphone's PCM feed. */
async function startRecording(): Promise<(samples: Float32Array) => void> {
  const microphone: { emit?: (samples: Float32Array) => void } = {};
  context.mocks.browser.voiceInput({
    rms: 0.2,
    onPcmCapture(emit) {
      microphone.emit = emit;
    },
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
    emit(new Float32Array(4096).fill(0.25));
  });
  await findEnabledControl("Stop recording");
  return emit;
}

test("Keep recording data after an incremental segment fails", async () => {
  const unavailable =
    "Speech recognition is temporarily unavailable. Your recording is kept.";
  // The latest segment failure the transcription service returned.
  const segment: { failure?: string } = {};
  context.mocks.http.post(`*${voiceIoTranscribeContract.segment.path}`, () => {
    segment.failure = unavailable;
    return HttpResponse.json(
      { error: { code: "PROVIDER_UNAVAILABLE", message: unavailable } },
      { status: 503 },
    );
  });
  const emit = await startRecording();

  // Fifteen seconds of speech close the first incremental segment.
  act(() => {
    emit(new Float32Array(SEGMENT_SAMPLES).fill(0.25));
  });
  await waitFor(() => {
    expect(segment.failure).toBe(unavailable);
  });
  // The failed segment arrived before Stop and does not end the recording.
  expect(queryControl("Stop recording")).toBeEnabled();
  act(() => {
    emit(new Float32Array(4096).fill(0.25));
  });

  click(await findEnabledControl("Stop recording"));

  await expect(screen.findByText(unavailable)).resolves.toBeInTheDocument();
  await expect(
    findEnabledControl("Remove voice draft"),
  ).resolves.toBeInTheDocument();
  expect(queryControl("Stop recording")).toBeUndefined();
});

test("Keep genuine transcription failures actionable", async () => {
  const sentry = context.mocks.sentry();
  setupSentryLogger();
  context.mocks.http.post(`*${voiceIoTranscribeContract.segment.path}`, () => {
    return HttpResponse.json(
      {
        error: {
          code: "VOICE_IO_NOT_CONFIGURED",
          message: "Speech recognition is not configured.",
        },
      },
      { status: 502 },
    );
  });
  await startRecording();

  click(await findEnabledControl("Stop recording"));

  await expect(
    screen.findByText("Speech recognition is not configured."),
  ).resolves.toBeInTheDocument();
  await expect(
    findEnabledControl("Remove voice draft"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(sentry.reports).toContainEqual(
      expect.objectContaining({
        type: "exception",
        error: expect.objectContaining({
          code: "VOICE_IO_NOT_CONFIGURED",
          status: 502,
        }),
      }),
    );
  });
});
