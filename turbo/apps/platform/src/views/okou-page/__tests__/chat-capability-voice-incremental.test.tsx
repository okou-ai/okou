import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { initSentry } from "../../../lib/sentry.ts";
import {
  findEnabledButton,
  RUN_PATH,
  createChatRunFixtures,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const endpoint = "*/api/voice-io/transcribe/segment";

test("Keep recording data after an incremental segment fails", async () => {
  const capture = context.mocks.deferred<(samples: Float32Array) => void>();
  const unavailable = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({
    rms: 0.1,
    onPcmCapture: capture.resolve,
    finalPcmSamples: new Float32Array(0),
  });
  installRunChat();
  context.mocks.http.post(endpoint, () => {
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
  });
  await setupPage({
    context,
    path: RUN_PATH,
  });
  click(await findEnabledButton("Voice input"));
  const emit = await capture.promise;
  emit(new Float32Array(15 * 16_000).fill(0.1));
  await unavailable.promise;
  await expect(findEnabledButton("Stop recording")).resolves.toBeVisible();
  emit(new Float32Array(5 * 16_000).fill(0.2));
  click(await findEnabledButton("Stop recording"));
  await expect(
    screen.findByText("Segment temporarily unavailable", { exact: false }),
  ).resolves.toBeVisible();
  await expect(findEnabledButton("Remove voice draft")).resolves.toBeVisible();
});

test("Preserve audio and retain its draft when transcription is busy", async () => {
  const message =
    "Speech recognition is temporarily busy. Please retry in a moment.";
  context.mocks.browser.voiceInput({ rms: 0.1 });
  installRunChat();
  const audio: ArrayBuffer[] = [];
  context.mocks.http.post("*/api/voice-io/polish/segments", () => {
    return HttpResponse.json({ text: "Retained speech." });
  });
  context.mocks.http.post(endpoint, async ({ request }) => {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new Error("Expected retained audio");
    }
    audio.push(await file.arrayBuffer());
    return HttpResponse.json(
      { error: { code: "PROVIDER_UNAVAILABLE", message } },
      { status: 503 },
    );
  });
  await setupPage({ context, path: RUN_PATH });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await findEnabledButton("Remove voice draft");
  await expect(
    screen.findByText(message, { exact: false }),
  ).resolves.toBeVisible();
  await expect(findEnabledButton("Remove voice draft")).resolves.toBeVisible();
  expect(audio).toHaveLength(1);
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
