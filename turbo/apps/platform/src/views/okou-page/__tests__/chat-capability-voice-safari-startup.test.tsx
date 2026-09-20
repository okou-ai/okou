import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { act } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { decodeVoiceDraftPcmWav } from "../../../signals/voice-io/voice-draft-pcm.ts";
import { AGENT_ID } from "./chat-lifecycle-test-helpers.ts";
import {
  context,
  findEnabledButton,
  findLink,
  installRunChat,
  NEW_CHAT_PATH,
  queryButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function installVoiceInput(userAgent: string) {
  installRunChat();
  context.mocks.browser.userAgent(userAgent);
  const connected = context.mocks.deferred<(samples: Float32Array) => void>();
  context.mocks.browser.voiceInput({
    rms: 0.12,
    onPcmCapture: connected.resolve,
    finalPcmSamples: new Float32Array(0),
  });
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: true, count: 0, limit: 60 });
  });
  context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
    return HttpResponse.json({
      transcript: "opening words",
      polishedText: "Opening words.",
      language: "en-US",
    });
  });
  return connected;
}

test.each([
  { browser: "macOS Safari", userAgent: SAFARI_MAC },
  { browser: "iOS Safari", userAgent: SAFARI_IOS },
])(
  "Start on the first nonempty PCM batch in $browser and preserve startup audio",
  async ({ userAgent }) => {
    const connected = installVoiceInput(userAgent);
    const uploaded = context.mocks.deferred<ArrayBuffer>();
    context.mocks.http.post(
      "*/api/voice-io/transcribe/segment",
      async ({ request }) => {
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) {
          throw new Error("Expected recorded audio");
        }
        uploaded.resolve(await file.arrayBuffer());
        return HttpResponse.json({
          transcript: "opening words",
          polishedText: "Opening words.",
          language: "en-US",
        });
      },
    );
    await setupPage({ context, path: RUN_PATH });
    click(await findEnabledButton("Voice input"));
    const emit = await connected.promise;
    await act(() => {
      emit(new Float32Array(0));
    });
    expect(queryButton("Starting voice input")).toBeDisabled();

    emit(new Float32Array(4096));
    const stop = await findEnabledButton("Stop recording");

    const openingAudio = new Float32Array(4096);
    openingAudio[4095] = -0.5;
    emit(openingAudio);
    const continuedAudio = new Float32Array(4096).fill(0.25);
    emit(continuedAudio);
    click(stop);
    const samples = decodeVoiceDraftPcmWav(await uploaded.promise);
    expect(samples).toHaveLength(12_288);
    expect(samples?.slice(0, 4096)).toStrictEqual(new Float32Array(4096));
    expect(samples?.slice(4096, 8192)).toStrictEqual(openingAudio);
    expect(samples?.slice(8192)).toStrictEqual(continuedAudio);
    await findEnabledButton("Voice input");
  },
);

test("Release Safari capture when switching agents before the first PCM batch", async () => {
  const connected = installVoiceInput(SAFARI_MAC);
  const otherAgentId = "c0000000-0000-4000-a000-000000000802";
  context.mocks.data.agents([
    { agentId: AGENT_ID, displayName: "Run Agent" },
    { agentId: otherAgentId, displayName: "Other Agent" },
  ]);
  context.mocks.data.userPreferences({
    pinnedAgentIds: [AGENT_ID, otherAgentId],
  });
  const trackStopped = context.mocks.deferred<void>();
  const disconnected = context.mocks.deferred<void>();
  const portClosed = context.mocks.deferred<void>();
  const contextClosed = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({
    rms: 0.12,
    onPcmCapture: connected.resolve,
    onTrackStop: trackStopped.resolve,
    onPcmDisconnect: disconnected.resolve,
    onPcmPortClose: portClosed.resolve,
    onAudioContextClose: contextClosed.resolve,
  });
  await setupPage({ context, path: NEW_CHAT_PATH });
  click(await findEnabledButton("Voice input"));
  const emit = await connected.promise;
  await act(() => {
    emit(new Float32Array(0));
  });
  expect(queryButton("Starting voice input")).toBeDisabled();
  click(await findLink("Other Agent"));
  await Promise.all([
    trackStopped.promise,
    disconnected.promise,
    portClosed.promise,
    contextClosed.promise,
  ]);
  await findEnabledButton("Voice input");
  await act(() => {
    emit(new Float32Array(4096).fill(0.25));
  });
  expect(queryButton("Stop recording")).toBeNull();
  expect(queryButton("Voice input")).toBeEnabled();
});
