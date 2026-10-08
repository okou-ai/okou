import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  findEnabledButton,
  installRunChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const transcribeEndpoint = "*/api/voice-io/transcribe/segment";
const polishEndpoint = "*/api/voice-io/polish/segments";

test("Use an older API without re-uploading audio when its polish route is absent", async () => {
  context.mocks.browser.voiceInput({ rms: 0.1 });
  installRunChat();
  let transcribed = false;
  let available = false;
  context.mocks.http.post(polishEndpoint, () => {
    return new HttpResponse("Old API has no additive route", { status: 404 });
  });
  context.mocks.http.post(transcribeEndpoint, async ({ request }) => {
    const form = await request.formData();
    const options: unknown = JSON.parse(String(form.get("options")));
    const hasAudio = form.has("file");
    expect(options).toMatchObject({
      final: !hasAudio,
      previousTranscript: hasAudio ? "" : "Saved speech.",
      ...(hasAudio ? {} : { overlapDurationSeconds: 0 }),
    });
    if (hasAudio) {
      if (transcribed) {
        return HttpResponse.json(
          {
            error: {
              code: "REUPLOAD",
              message: "Audio was already transcribed",
            },
          },
          { status: 502 },
        );
      }
      transcribed = true;
      return HttpResponse.json({ transcript: "Saved speech.", language: "en" });
    }
    return available
      ? HttpResponse.json({
          transcript: "",
          polishedText: "Saved speech.",
          language: "en",
        })
      : HttpResponse.json(
          {
            error: {
              code: "PROVIDER_UNAVAILABLE",
              message: "Old API editing is busy",
            },
          },
          { status: 503 },
        );
  });
  await setupPage({ context, path: RUN_PATH });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await expect(
    screen.findByText("Old API editing is busy", { exact: false }),
  ).resolves.toBeInTheDocument();
  await findEnabledButton("Retry");
  available = true;
  click(await findEnabledButton("Retry"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Saved speech.",
    );
  });
});

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
    emit(new Float32Array(60 * 16_000).fill(0.1));
    emit(new Float32Array(16_000).fill(tail));
    click(await findEnabledButton("Stop recording"));
    await waitFor(() => {
      expect(
        screen.getByRole("textbox", { name: "Message" }),
      ).toHaveTextContent(expected.join(" "));
    });
  },
);

test("Retry polish without uploading already transcribed audio", async () => {
  context.mocks.browser.voiceInput({ rms: 0.1 });
  installRunChat();
  let transcribed = false;
  context.mocks.http.post(transcribeEndpoint, () => {
    if (transcribed) {
      return HttpResponse.json(
        {
          error: {
            code: "UNEXPECTED_RETRANSCRIPTION",
            message: "Completed audio should not be uploaded again",
          },
        },
        { status: 502 },
      );
    }
    transcribed = true;
    return HttpResponse.json({
      transcript: "Keep every spoken fact.",
      language: "en",
    });
  });
  let available = false;
  context.mocks.http.post(polishEndpoint, async ({ request }) => {
    await expect(request.json()).resolves.toMatchObject({
      segments: ["Keep every spoken fact."],
    });
    return available
      ? HttpResponse.json({ text: "Keep every spoken fact." })
      : HttpResponse.json(
          {
            error: {
              code: "PROVIDER_UNAVAILABLE",
              message: "Editing is temporarily busy",
            },
          },
          { status: 503 },
        );
  });
  await setupPage({ context, path: RUN_PATH });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await expect(
    screen.findByText("Editing is temporarily busy", { exact: false }),
  ).resolves.toBeInTheDocument();
  await findEnabledButton("Retry");
  available = true;
  click(await findEnabledButton("Retry"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Keep every spoken fact.",
    );
  });
});
