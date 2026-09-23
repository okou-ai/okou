import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { initSentry } from "../../../lib/sentry.ts";
import {
  context,
  findEnabledButton,
  installRunChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const endpoint = "*/api/voice-io/transcribe/segment";

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

test("Preserve audio without an application error when transcription is busy", async () => {
  const message =
    "Speech recognition is temporarily busy. Please retry in a moment.";
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
  await setupPage({ context, path: RUN_PATH });
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
