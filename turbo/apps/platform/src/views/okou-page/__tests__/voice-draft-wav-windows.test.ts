import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { voiceIoPolishSegmentsContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatCapabilityHelpers,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import { findEnabledButton, queryButton } from "./chat-run-test-fixtures.ts";
const context = testContext();
const rate = 16_000;
function speech(count: number) {
  return Float32Array.from({ length: count }, (_, i) => {
    return [1, -1, 0.25, -0.25, 0][i % 5]!;
  });
}
async function record(
  live: number,
  tail: number,
  {
    vadProbability = 0.95,
    onWindowReceived,
  }: {
    vadProbability?: number | ((frame: Float32Array) => number);
    onWindowReceived?: (count: number) => void;
  } = {},
) {
  const microphone = context.mocks.deferred<(samples: Float32Array) => void>();
  const files: {
    start: number;
    length: number;
    type: string;
    overlap: number;
  }[] = [];
  context.mocks.browser.voiceInput({
    rms: 0.3,
    vadProbability,
    onPcmCapture(emit) {
      microphone.resolve(emit);
      if (live > 0) {
        emit(speech(live));
      }
    },
    finalPcmSamples: speech(tail),
  });
  context.mocks.api(voiceIoTranscribeContract.segment, ({ body, respond }) => {
    const file = body.get("file");
    if (!(file instanceof File)) {
      throw new Error("Expected microphone audio");
    }
    const pcmBytes = file.size - 44;
    expect(pcmBytes).toBeGreaterThanOrEqual(0);
    expect(pcmBytes % Int16Array.BYTES_PER_ELEMENT).toBe(0);
    const metadata = JSON.parse(String(body.get("options"))) as {
      overlapDurationSeconds: number;
    };
    const count = files.push({
      start: Number(file.name.match(/(\d+)\.wav$/)?.[1]),
      length: pcmBytes / Int16Array.BYTES_PER_ELEMENT,
      type: file.type,
      overlap: metadata.overlapDurationSeconds,
    });
    onWindowReceived?.(count);
    return respond(200, {
      transcript: "Window " + String(count),
      language: "en",
    });
  });
  context.mocks.api(voiceIoPolishSegmentsContract.post, ({ body, respond }) => {
    return respond(200, { text: body.segments.join(" ") });
  });
  createChatCapabilityHelpers(context).installCapabilityChat({ events: [] });
  await setupPage({ context, path: RUN_PATH });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  click(await findEnabledButton("Voice input"));
  const stop = await findEnabledButton("Stop recording");
  return { editor, files, stop, microphone: await microphone.promise };
}
test("voice-draft-audio-014 A stopped 42-second recording transcribes four overlapping windows", async () => {
  const { files, editor, stop } = await record(rate, 41 * rate);
  click(stop);
  await waitFor(() => {
    return expect(editor).toHaveTextContent(
      "Window 1 Window 2 Window 3 Window 4",
    );
  });
  expect(
    files.map((file) => {
      return [
        file.start / rate,
        (file.start + file.length) / rate,
        file.overlap,
      ];
    }),
  ).toStrictEqual([
    [0, 15, 0],
    [13, 28, 2],
    [26, 41, 2],
    [39, 42, 2],
  ]);
});
test("voice-draft-audio-002 The first full window is delivered while the microphone is still recording", async () => {
  const { files, stop, editor } = await record(240_000, 0);
  await waitFor(() => {
    return expect(files[0]?.length).toBe(240_000);
  });
  expect(files[0]?.start).toBe(0);
  expect(stop).toBeEnabled();
  click(stop);
  await waitFor(() => {
    return expect(editor).toHaveTextContent("Window 1");
  });
});
test("voice-draft-audio-007 Stopping at 448000 samples retains the previous window's last two seconds", async () => {
  const { files, stop, editor } = await record(240_000, 208_000);
  await waitFor(() => {
    return expect(files[0]?.length).toBe(240_000);
  });
  click(stop);
  await waitFor(() => {
    return expect(editor).toHaveTextContent("Window 1 Window 2");
  });
  expect(
    files.map((f) => {
      return [f.start, f.start + f.length, f.overlap];
    }),
  ).toStrictEqual([
    [0, 240_000, 0],
    [208_000, 448_000, 2],
  ]);
});

test.each([
  ["voice-draft-audio-001", 0, 239_999],
  ["voice-draft-audio-003", 240_000, 447_999],
] as const)(
  "%s A live window one sample short stays pending until the final sample arrives",
  async (_id, previous, total) => {
    const { files, stop, editor } = await record(total, 1);
    await waitFor(() => {
      return expect(files[0]?.length ?? 0).toBe(previous);
    });
    click(stop);
    await waitFor(() => {
      return expect(editor).toHaveTextContent(
        previous ? "Window 1 Window 2" : "Window 1",
      );
    });
    expect(
      files.map((f) => {
        return [f.start, f.length];
      }),
    ).toStrictEqual(
      previous
        ? [
            [0, 240_000],
            [208_000, 240_000],
          ]
        : [[0, 240_000]],
    );
  },
);

test("Continuing a live one-minute recording sends the next full WAV before Use recording", async () => {
  const firstMinute = context.mocks.deferred<void>();
  const nextWindow = context.mocks.deferred<void>();
  const capture = await record(60 * rate, 0, {
    onWindowReceived(count) {
      if (count === 4) {
        firstMinute.resolve();
      } else if (count === 5) {
        nextWindow.resolve();
      }
    },
  });
  await firstMinute.promise;
  expect(
    capture.files.map((file) => {
      return file.start / rate;
    }),
  ).toStrictEqual([0, 13, 26, 39]);
  capture.microphone(speech(13 * rate));
  await nextWindow.promise;
  const window = capture.files.at(-1);
  expect([window?.start, window?.length]).toStrictEqual([52 * rate, 15 * rate]);
  expect(capture.stop).toBeEnabled();
  click(capture.stop);
  await waitFor(() => {
    expect(capture.editor).toHaveTextContent("Window 6");
  });
  expect(capture.files.at(-1)?.start).toBe(65 * rate);
});

test("The speech detector receives full-scale microphone samples before the transcript is requested as WAV", async () => {
  const observed = context.mocks.deferred<number[]>();
  const { stop, files, editor } = await record(512, 0, {
    vadProbability(frame) {
      observed.resolve(Array.from(frame.subarray(0, 5)));
      return 0.95;
    },
  });
  click(stop);
  await waitFor(() => {
    expect(editor).toHaveTextContent("Window 1");
  });
  const decoded = await observed.promise;
  expect(decoded).toStrictEqual([
    expect.closeTo(1, 4),
    expect.closeTo(-1, 4),
    expect.closeTo(0.25, 4),
    expect.closeTo(-0.25, 4),
    expect.closeTo(0, 4),
  ]);
  expect(files[0]?.type).toBe("audio/wav");
});

test("An empty microphone frame leaves recording in startup until the first sample arrives", async () => {
  const microphone = context.mocks.deferred<(samples: Float32Array) => void>();
  context.mocks.browser.voiceInput({
    rms: 0.25,
    vadProbability: 0.99,
    onPcmCapture: (emit) => {
      return microphone.resolve(emit);
    },
    finalPcmSamples: new Float32Array(0),
  });
  await setupPage({ context, path: "/" });
  click(await findEnabledButton("Voice input"));
  const emit = await microphone.promise;
  act(() => {
    return emit(new Float32Array(0));
  });
  expect(queryButton("Stop recording")).toBeNull();
  act(() => {
    return emit(Float32Array.of(0.25));
  });
  await expect(findEnabledButton("Stop recording")).resolves.toBeEnabled();
});
