import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { decodeVoiceDraftPcmWav } from "../../../signals/voice-io/voice-draft-pcm.ts";
import {
  context,
  findEnabledButton,
  installRunChat,
  queryButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

async function prepareIdleComposer() {
  const capture = context.mocks.deferred<(samples: Float32Array) => void>();
  const requested = context.mocks.deferred<void>();
  const responseReady = context.mocks.deferred<void>();
  const drained = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({
    rms: 0.1,
    onPcmCapture: capture.resolve,
    onPcmPortClose: drained.resolve,
    finalPcmSamples: new Float32Array(16_000).fill(0.3),
  });
  installRunChat();
  const uploads: ArrayBuffer[] = [];
  const prefixes: string[] = [];
  context.mocks.http.post(
    "*/api/voice-io/transcribe/segment",
    async ({ request }) => {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new Error("Expected a recorded audio segment");
      }
      uploads.push(await file.arrayBuffer());
      const options = JSON.parse(String(form.get("options"))) as {
        final: boolean;
        previousTranscript: string;
      };
      prefixes.push(options.previousTranscript);
      if (!options.final) {
        requested.resolve();
        await responseReady.promise;
        return HttpResponse.json({
          transcript: "First part.",
          language: "en",
        });
      }
      return HttpResponse.json({
        transcript: "Last part.",
        polishedText: "First part. Last part.",
        language: "en",
      });
    },
  );
  await setupPage({ context, path: RUN_PATH });
  const voiceInput = await findEnabledButton("Voice input");
  return {
    capture,
    requested,
    responseReady,
    drained,
    uploads,
    prefixes,
    voiceInput,
  };
}

test("Sharing remounts an idle composer without acquiring or uploading audio", async () => {
  const { capture, uploads } = await prepareIdleComposer();
  // Sharing replaces the composer subtree without ending the thread's page.
  click(await findEnabledButton("Share messages"));
  const cancelShare = await findEnabledButton("Cancel");
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  click(cancelShare);
  await findEnabledButton("Voice input");
  expect(capture.settled()).toBeFalsy();
  expect(uploads).toStrictEqual([]);
});

describe.each(["recording", "transcribing"])(
  "preserve the voice session when sharing remounts the composer during %s",
  (phase) => {
    let prepared: Awaited<ReturnType<typeof prepareIdleComposer>>;
    beforeEach(async () => {
      prepared = await prepareIdleComposer();
    });

    it("preserves recorded audio through the active composer remount", async () => {
      const {
        capture,
        requested,
        responseReady,
        drained,
        uploads,
        prefixes,
        voiceInput,
      } = prepared;
      click(voiceInput);
      const emit = await capture.promise;
      emit(new Float32Array(60 * 16_000).fill(0.1));
      await requested.promise;
      const stop = await findEnabledButton("Stop recording");
      if (phase === "transcribing") {
        emit(new Float32Array(5 * 16_000).fill(0.2));
        click(stop);
        // PCM must drain before the pending HTTP response is released.
        await drained.promise;
        await screen.findByText("Transcribing");
      }

      click(await findEnabledButton("Share messages"));
      const cancelShare = await findEnabledButton("Cancel");
      expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
      if (phase === "recording") {
        emit(new Float32Array(5 * 16_000).fill(0.2));
      }
      click(cancelShare);
      if (phase === "recording") {
        click(await findEnabledButton("Stop recording"));
        await drained.promise;
      }
      await screen.findByText("Transcribing");
      expect(queryButton("Retry")).toBeNull();

      responseReady.resolve();
      await findEnabledButton("Voice input");
      await waitFor(() => {
        expect(
          screen.getByRole("textbox", { name: "Message" }).textContent,
        ).toBe("First part. Last part.");
      });
      expect(prefixes).toStrictEqual(["", "First part."]);
      const first = decodeVoiceDraftPcmWav(uploads[0]!);
      const tail = decodeVoiceDraftPcmWav(uploads[1]!);
      expect(first).toHaveLength(60 * 16_000);
      // The tail contains two seconds of overlap, five queued seconds, and the
      // final worklet second, including samples captured while the UI was absent.
      expect(tail).toHaveLength(8 * 16_000);
      expect(tail?.[2 * 16_000]).toBeCloseTo(0.2, 4);
      expect(tail?.at(-1)).toBeCloseTo(0.3, 4);
    });
  },
);
