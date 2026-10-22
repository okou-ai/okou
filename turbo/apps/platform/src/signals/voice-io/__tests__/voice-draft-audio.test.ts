import { nextVoiceDraftSegment } from "../voice-draft-audio";
import {
  decodeVoiceDraftPcmWav,
  encodeVoiceDraftPcmWav,
} from "../voice-draft-pcm";

describe("voice draft segment boundaries", () => {
  it.each([
    { samples: 239_999, previous: 0, finished: false, expected: null },
    {
      samples: 240_000,
      previous: 0,
      finished: false,
      expected: { startSample: 0, endSample: 240_000, final: false },
    },
    { samples: 447_999, previous: 240_000, finished: false, expected: null },
    {
      samples: 448_000,
      previous: 240_000,
      finished: false,
      expected: { startSample: 208_000, endSample: 448_000, final: false },
    },
    {
      samples: 16_000,
      previous: 0,
      finished: true,
      expected: { startSample: 0, endSample: 16_000, final: true },
    },
    {
      samples: 240_000,
      previous: 0,
      finished: true,
      expected: { startSample: 0, endSample: 240_000, final: true },
    },
    {
      samples: 448_000,
      previous: 240_000,
      finished: true,
      expected: { startSample: 208_000, endSample: 448_000, final: true },
    },
    {
      samples: 256_000,
      previous: 240_000,
      finished: true,
      expected: { startSample: 208_000, endSample: 256_000, final: true },
    },
    {
      samples: 240_001,
      previous: 240_000,
      finished: true,
      expected: { startSample: 208_000, endSample: 240_001, final: true },
    },
    { samples: 0, previous: 0, finished: true, expected: null },
    { samples: 240_000, previous: 240_000, finished: true, expected: null },
    { samples: 448_000, previous: 448_000, finished: true, expected: null },
    {
      // Retained 60-second checkpoints are not resliced on recovery.
      samples: 73 * 16_000,
      previous: 60 * 16_000,
      finished: false,
      expected: {
        startSample: 58 * 16_000,
        endSample: 73 * 16_000,
        final: false,
      },
    },
  ])(
    "slice $samples samples after $previous (finished: $finished)",
    ({ samples, previous, finished, expected }) => {
      expect(nextVoiceDraftSegment(samples, previous, finished)).toStrictEqual(
        expected,
      );
    },
  );

  it("drains full windows and a stopped tail with two-second overlap", () => {
    const sampleCount = 42 * 16_000;
    let previousEnd = 0;
    const segments = [];
    for (;;) {
      const segment = nextVoiceDraftSegment(sampleCount, previousEnd, true);
      if (!segment) {
        break;
      }
      expect(segment.endSample - segment.startSample).toBeLessThanOrEqual(
        15 * 16_000,
      );
      expect(segment.endSample).toBeGreaterThan(previousEnd);
      if (previousEnd > 0) {
        expect(previousEnd - segment.startSample).toBe(2 * 16_000);
      }
      segments.push(segment);
      previousEnd = segment.endSample;
    }
    expect(segments).toStrictEqual([
      { startSample: 0, endSample: 15 * 16_000, final: false },
      { startSample: 13 * 16_000, endSample: 28 * 16_000, final: false },
      { startSample: 26 * 16_000, endSample: 41 * 16_000, final: false },
      { startSample: 39 * 16_000, endSample: sampleCount, final: true },
    ]);
    expect(previousEnd).toBe(sampleCount);
  });
});

describe("voice draft PCM WAV", () => {
  it("round-trips the AudioWorklet sample format", async () => {
    const source = new Float32Array([-1, -0.25, 0, 0.25, 1]);
    const encoded = encodeVoiceDraftPcmWav(source);
    const decoded = decodeVoiceDraftPcmWav(await encoded.arrayBuffer());

    expect(encoded.type).toBe("audio/wav");
    expect(Array.from(decoded ?? [])).toStrictEqual([
      expect.closeTo(-1, 4),
      expect.closeTo(-0.25, 4),
      expect.closeTo(0, 4),
      expect.closeTo(0.25, 4),
      expect.closeTo(1, 4),
    ]);
  });
});
