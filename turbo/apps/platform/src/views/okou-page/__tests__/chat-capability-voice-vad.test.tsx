import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { decodeVoiceDraftPcmWav } from "../../../signals/voice-io/voice-draft-pcm.ts";
import {
  assistantEvent,
  context,
  findEnabledButton,
  installRunChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const endpoint = "*/api/voice-io/transcribe/segment";

function composer(): HTMLElement {
  return screen.getByRole("textbox", { name: "Message" });
}

async function stopRecording(): Promise<void> {
  click(await findEnabledButton("Stop recording"));
}

for (const durationSeconds of [0.1, 0.5, 2, 5, 65]) {
  test(`Reject ${durationSeconds}s of digital silence without replacing typed context`, async () => {
    context.mocks.browser.voiceInput({
      rms: 0,
      onPcmCapture: (emit) => {
        return emit(new Float32Array(16_000 * durationSeconds));
      },
      finalPcmSamples: new Float32Array(0),
    });
    installRunChat({
      chatEvents: [
        assistantEvent({
          id: "vad-context",
          runId: "run-vad-context",
          seqId: 1,
          text: "Use LaunchPad for this release.",
        }),
      ],
    });
    // If the gate is bypassed, a context-derived response must not land in input.
    context.mocks.http.post(endpoint, () => {
      return HttpResponse.json({
        transcript: "Use LaunchPad for this release.",
        polishedText: "Use LaunchPad for this release.",
        language: "en",
      });
    });
    await setupPage({ context, path: RUN_PATH });
    await fill(composer(), "Keep typed notes");
    click(await findEnabledButton("Voice input"));
    await stopRecording();
    await expect(
      screen.findByText("No speech detected. Please record again."),
    ).resolves.toBeInTheDocument();
    await findEnabledButton("Voice input");
    expect(composer()).toHaveTextContent("Keep typed notes");
  });
}

test("Reject consistently low speech probabilities, not just all-zero PCM", async () => {
  context.mocks.browser.voiceInput({
    rms: 0.001,
    onPcmCapture: (emit) => {
      return emit(new Float32Array(16_000).fill(0.001));
    },
    finalPcmSamples: new Float32Array(0),
    vadProbability: 0.02,
  });
  installRunChat();
  context.mocks.http.post(endpoint, () => {
    return HttpResponse.json({
      transcript: "Invented context",
      polishedText: "Invented context",
      language: "en",
    });
  });
  await setupPage({ context, path: RUN_PATH });
  click(await findEnabledButton("Voice input"));
  await stopRecording();
  await expect(
    screen.findByText("No speech detected. Please record again."),
  ).resolves.toBeInTheDocument();
  await findEnabledButton("Voice input");
  expect(composer()).toHaveTextContent("");
});

for (const { label, samples, probability } of [
  { label: "a short word", samples: 1536, probability: 0.9 },
  { label: "uncertain weak speech", samples: 16000, probability: 0.2 },
  { label: "a sub-frame onset", samples: 160, probability: 0.02 },
]) {
  test(`Preserve ${label} and upload the original audio`, async () => {
    context.mocks.browser.voiceInput({
      rms: 0.01,
      onPcmCapture: (emit) => {
        return emit(new Float32Array(samples).fill(0.01));
      },
      finalPcmSamples: new Float32Array(0),
      vadProbability: probability,
    });
    installRunChat();
    context.mocks.http.post(endpoint, async ({ request }) => {
      const form = await request.formData();
      const file = form.get("file");
      expect(file).toBeInstanceOf(File);
      if (!(file instanceof File)) throw new Error("Expected unchanged audio");
      const pcm = decodeVoiceDraftPcmWav(await file.arrayBuffer());
      expect(pcm).toHaveLength(samples);
      expect(pcm?.[0]).toBeCloseTo(0.01, 3);
      return HttpResponse.json({
        transcript: "OK",
        polishedText: "OK",
        language: "en",
      });
    });
    await setupPage({ context, path: RUN_PATH });
    click(await findEnabledButton("Voice input"));
    await stopRecording();
    await waitFor(() => {
      return expect(composer()).toHaveTextContent("OK");
    });
    await findEnabledButton("Voice input");
  });
}

test("Detect speech after leading silence without trimming the recording", async () => {
  const samples = new Float32Array(16_000 * 2).fill(0.001);
  samples.fill(0.1, 16_000);
  context.mocks.browser.voiceInput({
    rms: 0.1,
    onPcmCapture: (emit) => {
      return emit(samples);
    },
    finalPcmSamples: new Float32Array(0),
    vadProbability: (frame) => {
      return frame.some((sample) => {
        return sample > 0.05;
      })
        ? 0.9
        : 0.02;
    },
  });
  installRunChat();
  context.mocks.http.post(endpoint, async ({ request }) => {
    const file = (await request.formData()).get("file");
    if (!(file instanceof File)) throw new Error("Expected complete audio");
    const pcm = decodeVoiceDraftPcmWav(await file.arrayBuffer());
    expect(pcm).toHaveLength(samples.length);
    expect(pcm?.[0]).toBeCloseTo(0.001, 3);
    expect(pcm?.[16_000]).toBeCloseTo(0.1, 3);
    return HttpResponse.json({
      transcript: "Late speech",
      polishedText: "Late speech",
      language: "en",
    });
  });
  await setupPage({ context, path: RUN_PATH });
  click(await findEnabledButton("Voice input"));
  await stopRecording();
  await waitFor(() => {
    return expect(composer()).toHaveTextContent("Late speech");
  });
});

for (const failure of ["initialization", "invalid probability"]) {
  test(`Keep audio after VAD ${failure} failure and allow explicit retry`, async () => {
    let available = false;
    context.mocks.browser.voiceInput({
      rms: 0.1,
      vadProbability: () => {
        return failure === "invalid probability" && !available ? NaN : 0.9;
      },
      vadModelReady: () => {
        return available || failure !== "initialization"
          ? Promise.resolve()
          : Promise.reject(new Error("Model unavailable"));
      },
    });
    installRunChat();
    context.mocks.http.post(endpoint, () => {
      return HttpResponse.json({
        transcript: "Retained speech",
        polishedText: "Retained speech",
        language: "en",
      });
    });
    await setupPage({ context, path: RUN_PATH });
    await fill(composer(), "Typed notes");
    click(await findEnabledButton("Voice input"));
    await stopRecording();
    await findEnabledButton("Retry");
    await expect(
      screen.findByText(
        "Speech detection is unavailable. Your recording is kept. Please retry.",
        { exact: false },
      ),
    ).resolves.toBeInTheDocument();
    expect(composer()).toHaveTextContent("Typed notes");
    available = true;
    click(await findEnabledButton("Retry"));
    await waitFor(() => {
      return expect(composer()).toHaveTextContent("Typed notesRetained speech");
    });
    await findEnabledButton("Voice input");
  });
}

test("Checkpoint a silent first segment and retain speech recorded afterwards", async () => {
  const samples = new Float32Array(65 * 16_000);
  samples.fill(0.1, 60 * 16_000);
  context.mocks.browser.voiceInput({
    rms: 0.1,
    onPcmCapture: (emit) => {
      emit(samples);
    },
    finalPcmSamples: new Float32Array(0),
  });
  installRunChat();
  context.mocks.http.post(endpoint, async ({ request }) => {
    const form = await request.formData();
    const options = JSON.parse(String(form.get("options")));
    expect(options.final).toBe(true);
    expect(options.previousTranscript).toBe("");
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Expected later speech");
    const pcm = decodeVoiceDraftPcmWav(await file.arrayBuffer());
    expect(pcm).toHaveLength(7 * 16_000);
    expect(pcm?.[0]).toBe(0);
    expect(pcm?.[2 * 16_000]).toBeCloseTo(0.1, 3);
    return HttpResponse.json({
      transcript: "After silence",
      polishedText: "After silence",
      language: "en",
    });
  });
  await setupPage({ context, path: RUN_PATH });
  click(await findEnabledButton("Voice input"));
  await stopRecording();
  await waitFor(() => {
    expect(composer()).toHaveTextContent("After silence");
  });
  await findEnabledButton("Voice input");
});

test("Finalize earlier speech without uploading a silent tail or its overlap", async () => {
  const captured = context.mocks.deferred<(samples: Float32Array) => void>();
  const prefixRequested = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({
    rms: 0.1,
    onPcmCapture: captured.resolve,
    finalPcmSamples: new Float32Array(0),
    vadProbability: (frame) => {
      return frame.some((sample) => {
        return sample > 0.05;
      })
        ? 0.9
        : 0.02;
    },
  });
  installRunChat();
  context.mocks.http.post(endpoint, async ({ request }) => {
    const form = await request.formData();
    const options = JSON.parse(String(form.get("options")));
    if (!options.final) {
      prefixRequested.resolve();
      return HttpResponse.json({
        transcript: "Earlier speech.",
        language: "en",
      });
    }
    expect(form.get("file")).toBeNull();
    expect(options.previousTranscript).toBe("Earlier speech.");
    expect(options.overlapDurationSeconds).toBe(0);
    return HttpResponse.json({
      transcript: "",
      polishedText: "Earlier speech.",
      language: "en",
    });
  });
  await setupPage({ context, path: RUN_PATH });
  click(await findEnabledButton("Voice input"));
  const emit = await captured.promise;
  emit(new Float32Array(60 * 16_000).fill(0.1));
  await prefixRequested.promise;
  emit(new Float32Array(5 * 16_000).fill(0.001));
  await stopRecording();
  await waitFor(() => {
    return expect(composer()).toHaveTextContent("Earlier speech.");
  });
  await findEnabledButton("Voice input");
});
