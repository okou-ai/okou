import { act, waitFor, screen } from "@testing-library/react";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { HttpResponse } from "msw";
import { test, expect } from "vitest";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import { setupSentryLogger } from "../../../lib/sentry-config.ts";
import { findEnabledButton } from "./chat-run-test-fixtures.ts";
import { voiceIoPolishSegmentsContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import {
  createChatCapabilityHelpers,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

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
