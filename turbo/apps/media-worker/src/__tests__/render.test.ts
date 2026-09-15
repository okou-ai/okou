import { open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { renderPoster, verifyMediaTools } from "../render";

import { exec, fixture, pixelData, serve } from "./media-fixture";
const signal = () => {
  return AbortSignal.timeout(10_000);
};

async function hosted(frames: number, transparent = false, codec = "libvpx") {
  const media = await fixture(frames, transparent, codec);
  const host = await serve(media.directory);
  onTestFinished(async () => {
    await host.close();
    await rm(media.directory, { recursive: true, force: true });
  });
  return { ...media, host };
}

describe("video poster decoding", () => {
  it("verifies the decoder image capabilities before serving requests", async () => {
    await expect(verifyMediaTools(signal())).resolves.toBeUndefined();
  });

  it("uses the frame covering 1s in variable-frame-rate media", async () => {
    const media = await hosted(45);
    await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-i",
        media.video,
        "-vf",
        "select='eq(n,0)+eq(n,15)+eq(n,30)',setpts='if(eq(N,0),0,if(eq(N,1),0.8,1.5))/TB'",
        "-fps_mode",
        "vfr",
        "-enc_time_base",
        "1:1000",
        "-video_track_timescale",
        "1000",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        join(media.directory, "vfr.mp4"),
      ],
      { signal: signal() },
    );
    const image = await renderPoster(media.host.url("vfr.mp4"), signal());
    expect((await pixelData(image))[1]).toBeGreaterThan(240);
  });

  it("normalizes a non-zero video start timestamp", async () => {
    const media = await hosted(45);
    await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-itsoffset",
        "5",
        "-i",
        media.video,
        "-c",
        "copy",
        join(media.directory, "offset.mp4"),
      ],
      { signal: signal() },
    );
    const image = await renderPoster(media.host.url("offset.mp4"), signal());
    expect((await pixelData(image))[2]).toBeGreaterThan(240);
  });

  it("preserves display aspect ratio for non-square pixels", async () => {
    const media = await hosted(45);
    await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-i",
        media.video,
        "-vf",
        "setsar=2",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        join(media.directory, "wide.mp4"),
      ],
      { signal: signal() },
    );
    const image = await renderPoster(media.host.url("wide.mp4"), signal());
    expect(image.readUInt32BE(16)).toBe(64);
    expect(image.readUInt32BE(20)).toBe(32);
  });

  it("recognizes an audio file mislabeled as MP4 as unsupported", async () => {
    const media = await hosted(45);
    await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.5",
        "-f",
        "mp3",
        join(media.directory, "audio.mp4"),
      ],
      { signal: signal() },
    );
    await expect(
      renderPoster(media.host.url("audio.mp4"), signal()),
    ).rejects.toMatchObject({ code: "unsupported_media" });
  });

  it("waits for the active decoder to exit after cancellation", async () => {
    const media = await hosted(45);
    const owner = new AbortController();
    const rendering = renderPoster(media.host.url(media.name), owner.signal);
    owner.abort();
    await expect(rendering).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([15, 30, 45])(
    "samples relative 1s or normal short EOF for %i frames",
    async (frames) => {
      const media = await hosted(frames);
      const image = await renderPoster(media.host.url(media.name), signal());
      const pixels = await pixelData(image);
      const expectedChannel = frames <= 30 ? 1 : 2;
      expect(pixels[expectedChannel]).toBeGreaterThan(240);
      expect(pixels[0]).toBeLessThan(15);
      expect(pixels.length).toBe(32 * 32 * 4);
    },
  );

  it.each(["libvpx", "libvpx-vp9"])(
    "retains transparent WebM alpha with %s",
    async (codec) => {
      const media = await hosted(45, true, codec);
      const image = await renderPoster(media.host.url(media.name), signal());
      const pixels = await pixelData(image);
      expect(pixels[3]).toBe(0);
      expect(pixels[31 * 4 + 3]).toBe(255);
    },
  );

  it("reads a fraction of a 100 MiB video instead of downloading it", async () => {
    const media = await hosted(45);
    const bytes = 104_857_601;
    const original = await readFile(media.video);
    const file = await open(media.video, "r+");
    try {
      const box = Buffer.alloc(8);
      box.writeUInt32BE(bytes - original.length, 0);
      box.write("free", 4);
      await file.write(box, 0, box.length, original.length);
      await file.truncate(bytes);
    } finally {
      await file.close();
    }
    const image = await renderPoster(media.host.url(media.name), signal());
    expect((await pixelData(image))[2]).toBeGreaterThan(240);
    // The transformer this replaces rejects the same input for its size alone.
    expect(media.host.bytesServed()).toBeLessThan(bytes / 4);
  });

  it("rejects corrupt input instead of returning a short-video fallback", async () => {
    const media = await hosted(45);
    await writeFile(media.video, Buffer.from("not a media file"));
    await expect(
      renderPoster(media.host.url(media.name), signal()),
    ).rejects.toMatchObject({ code: "decode_failed" });
  });

  it("respects cancellation before spawning a decoder", async () => {
    const media = await hosted(45);
    const owner = new AbortController();
    owner.abort();
    await expect(
      renderPoster(media.host.url(media.name), owner.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
