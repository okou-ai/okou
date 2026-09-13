import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../../../signals/utils.ts";
import { initSentry } from "../../../lib/sentry.ts";
import {
  context,
  findEnabledButton,
  installRunChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const refreshedContext = testContext();
const flags = { [FeatureSwitchKey.VoiceInputV2]: true } as const;
const endpoint = "*/api/voice-io/transcribe/segment";

test("Keep transcription pending until server recovery succeeds without reporting an error", async () => {
  const sentry = context.mocks.sentry();
  initSentry();
  const started = context.mocks.deferred<void>();
  const recovered = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({ rms: 0.1 });
  installRunChat();
  // The contract mock only parses JSON; voice segments use multipart bodies.
  context.mocks.http.post(endpoint, async () => {
    started.resolve();
    await recovered.promise;
    return HttpResponse.json({
      transcript: "Recovered speech.",
      polishedText: "Recovered speech.",
      language: "en",
    });
  });
  await setupPage({ context, path: RUN_PATH, featureSwitches: flags });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await started.promise;
  await expect(screen.findByText("Transcribing")).resolves.toBeVisible();
  recovered.resolve();
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Recovered speech.",
    );
  });
  expect(sentry.reports).toStrictEqual([]);
});

test("Keep recording after an incremental segment fails and finish in order", async () => {
  const capture = context.mocks.deferred<(samples: Float32Array) => void>();
  const unavailable = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({
    rms: 0.1,
    onPcmCapture: capture.resolve,
    finalPcmSamples: new Float32Array(0),
  });
  installRunChat();
  let requestAttempts = 0;
  context.mocks.http.post(endpoint, () => {
    requestAttempts += 1;
    if (requestAttempts === 1) {
      unavailable.resolve();
      return HttpResponse.json(
        {
          error: {
            code: "PROVIDER_UNAVAILABLE",
            message: "Segment temporarily unavailable",
          },
        },
        { status: 503 },
      );
    }
    if (requestAttempts === 2) {
      return HttpResponse.json({ transcript: "First part.", language: "en" });
    }
    return HttpResponse.json({
      transcript: "Last part.",
      polishedText: "First part. Last part.",
      language: "en",
    });
  });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: flags,
  });
  click(await findEnabledButton("Voice input"));
  const emit = await capture.promise;
  emit(new Float32Array(60 * 16_000).fill(0.1));
  await unavailable.promise;
  await expect(findEnabledButton("Stop recording")).resolves.toBeVisible();
  emit(new Float32Array(5 * 16_000).fill(0.2));
  click(await findEnabledButton("Stop recording"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "First part. Last part.",
    );
  });
});

test("Resume a completed segment after reload without retranscribing its audio", async () => {
  // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
  const page = createChildAbortController(context.signal);
  const capture = context.mocks.deferred<(samples: Float32Array) => void>();
  const started = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({
    rms: 0.1,
    onPcmCapture: capture.resolve,
    finalPcmSamples: new Float32Array(0),
  });
  installRunChat();
  const inputs: { prefix: string; duration: number }[] = [];
  let finalAttempts = 0;
  context.mocks.http.post(endpoint, async ({ request }) => {
    const form = await request.formData();
    const options = JSON.parse(String(form.get("options"))) as {
      previousTranscript: string;
      final: boolean;
    };
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new Error("Expected remaining audio");
    }
    inputs.push({
      prefix: options.previousTranscript,
      duration: (file.size - 44) / 32_000,
    });
    if (!options.final) {
      started.resolve();
      return HttpResponse.json({ transcript: "Saved part.", language: "en" });
    }
    finalAttempts += 1;
    if (finalAttempts === 1) {
      return HttpResponse.json(
        {
          error: {
            code: "PROVIDER_UNAVAILABLE",
            message: "Final processing unavailable",
          },
        },
        { status: 503 },
      );
    }
    return HttpResponse.json({
      transcript: "Last part.",
      polishedText: "Saved part. Last part.",
      language: "en",
    });
  });
  await setupPage({
    locale: "en-US",
    context: { ...context, signal: page.signal },
    path: RUN_PATH,
    featureSwitches: flags,
  });
  click(await findEnabledButton("Voice input"));
  const emit = await capture.promise;
  emit(new Float32Array(60 * 16_000).fill(0.1));
  await started.promise;
  emit(new Float32Array(5 * 16_000).fill(0.2));
  click(await findEnabledButton("Stop recording"));
  await findEnabledButton("Retry");
  page.abort(new DOMException("Page reloaded", "AbortError"));
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
  await setupPage({
    locale: "en-US",
    context: refreshedContext,
    path: RUN_PATH,
    featureSwitches: flags,
  });
  click(await findEnabledButton("Retry"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Saved part. Last part.",
    );
  });
  expect(inputs).toStrictEqual([
    { prefix: "", duration: 60 },
    { prefix: "Saved part.", duration: 7 },
    { prefix: "Saved part.", duration: 7 },
  ]);
});

test("Stop during transcription and finalize the saved prefix without retranscribing its audio", async () => {
  const capture = context.mocks.deferred<(samples: Float32Array) => void>();
  const started = context.mocks.deferred<void>();
  const ready = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({
    rms: 0.1,
    onPcmCapture: capture.resolve,
    finalPcmSamples: new Float32Array(0),
  });
  installRunChat();
  context.mocks.http.post(endpoint, async ({ request }) => {
    const form = await request.formData();
    const options = JSON.parse(String(form.get("options"))) as {
      previousTranscript: string;
      final: boolean;
    };
    if (!options.final) {
      started.resolve();
      await ready.promise;
      return HttpResponse.json({
        transcript: "Completed speech.",
        language: "en",
      });
    }
    expect(form.get("file")).toBeNull();
    expect(options.previousTranscript).toBe("Completed speech.");
    return HttpResponse.json({
      transcript: "",
      polishedText: "Completed speech.",
      language: "en",
    });
  });
  await setupPage({ context, path: RUN_PATH, featureSwitches: flags });
  click(await findEnabledButton("Voice input"));
  const emit = await capture.promise;
  emit(new Float32Array(60 * 16_000).fill(0.1));
  await started.promise;
  click(await findEnabledButton("Stop recording"));
  ready.resolve();
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Completed speech.",
    );
  });
});

test.each([
  "Speech recognition is temporarily busy. Please retry in a moment.",
  "Voice draft transcription is temporarily unavailable",
])("Preserve audio without an application error for %s", async (message) => {
  const sentry = context.mocks.sentry();
  initSentry();
  context.mocks.browser.voiceInput({ rms: 0.1 });
  installRunChat();
  let available = false;
  const audio: ArrayBuffer[] = [];
  context.mocks.http.post(endpoint, async ({ request }) => {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new Error("Expected retained audio");
    }
    audio.push(await file.arrayBuffer());
    if (!available) {
      return HttpResponse.json(
        {
          error: {
            code: "PROVIDER_UNAVAILABLE",
            message,
          },
        },
        { status: 503 },
      );
    }
    return HttpResponse.json({
      transcript: "Retained speech.",
      polishedText: "Retained speech.",
      language: "en",
    });
  });
  await setupPage({ context, path: RUN_PATH, featureSwitches: flags });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await findEnabledButton("Retry");
  await expect(
    screen.findByText(message, { exact: false }),
  ).resolves.toBeVisible();
  expect(
    screen.getByText("Your recording is kept. Retry transcription.", {
      exact: false,
    }),
  ).toBeVisible();
  expect(sentry.reports).toStrictEqual([]);
  available = true;
  click(await findEnabledButton("Retry"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Retained speech.",
    );
  });
  expect(audio[1]).toStrictEqual(audio[0]);
  expect(sentry.reports).toStrictEqual([]);
});

test.each([
  { status: 502, code: "VOICE_TRANSCRIPTION_FAILED" },
  { status: 503, code: "NOT_CONFIGURED" },
])("Keep genuine $code failures actionable", async ({ status, code }) => {
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
  await setupPage({ context, path: RUN_PATH, featureSwitches: flags });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await findEnabledButton("Retry");
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

test("Abort pending transcription when removing a recording after a storage failure, then record again", async () => {
  const capture = context.mocks.deferred<(samples: Float32Array) => void>();
  const started = context.mocks.deferred<void>();
  const aborted = context.mocks.deferred<void>();
  const errorSpy = vi.spyOn(console, "error");
  const original = errorSpy.getMockImplementation();
  if (!original) {
    throw new Error("Expected console guard");
  }
  const errors: unknown[][] = [];
  errorSpy.mockImplementation((...args: unknown[]) => {
    if (
      args[0] === "[E][Composer:VoiceDraft]" &&
      args[1] === "Voice recording could not be saved"
    ) {
      errors.push(args);
      return;
    }
    original(...args);
  });
  context.mocks.browser.voiceInput({
    rms: 0.1,
    onPcmCapture: capture.resolve,
    finalPcmSamples: new Float32Array(0),
  });
  installRunChat();
  let requests = 0;
  context.mocks.http.post(endpoint, async ({ request }) => {
    requests += 1;
    if (requests === 1) {
      request.signal.addEventListener(
        "abort",
        () => {
          aborted.resolve();
        },
        { once: true },
      );
      started.resolve();
      await aborted.promise;
      return HttpResponse.error();
    }
    const form = await request.formData();
    expect(JSON.parse(String(form.get("options")))).toMatchObject({
      previousTranscript: "",
      final: true,
    });
    return HttpResponse.json({
      transcript: "Next recording.",
      polishedText: "Next recording.",
      language: "en",
    });
  });
  await setupPage({ context, path: RUN_PATH, featureSwitches: flags });
  click(await findEnabledButton("Voice input"));
  const emit = await capture.promise;
  emit(new Float32Array(60 * 16_000).fill(0.1));
  await started.promise;
  const add = IDBObjectStore.prototype.add;
  const storageError = new DOMException(
    "Storage is full",
    "QuotaExceededError",
  );
  const failingWrite = vi
    .spyOn(IDBObjectStore.prototype, "add")
    .mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "chunks") {
        throw storageError;
      }
      return add.apply(this, args);
    });
  emit(new Float32Array(4096).fill(0.2));
  await findEnabledButton("Retry");
  click(await findEnabledButton("Remove voice draft"));
  await aborted.promise;
  await findEnabledButton("Voice input");
  failingWrite.mockRestore();
  context.mocks.browser.voiceInput({ rms: 0.1 });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Next recording.",
    );
  });
  expect(requests).toBe(2);
  expect(errors).toStrictEqual([
    [
      "[E][Composer:VoiceDraft]",
      "Voice recording could not be saved",
      storageError,
    ],
  ]);
});
