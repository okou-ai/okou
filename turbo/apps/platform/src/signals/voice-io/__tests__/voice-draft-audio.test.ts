import {
  decodeVoiceDraftPcmWav,
  encodeVoiceDraftPcmWav,
} from "../voice-draft-pcm";

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
