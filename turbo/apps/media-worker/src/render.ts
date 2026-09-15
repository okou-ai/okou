import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PosterError } from "./poster-error";

const POSTER_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const FORMATS = "mov,matroska,webm,avi,ogg,mpegts,mp3,wav,flac,aac";
// FFmpeg reads the source over HTTP range requests, so it transfers only the
// header and the leading frames instead of the whole video.
const PROTOCOLS = "http,https,tls,tcp";
const mediaSchema = z.object({
  streams: z.array(
    z.object({
      codec_name: z.string(),
      width: z.number().int(),
      height: z.number().int(),
    }),
  ),
});

async function mediaProcess(
  binary: "ffmpeg" | "ffprobe",
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const child = spawn(binary, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    // The decoder never inherits the API secret.
    env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
  });
  const output: Buffer[] = [];
  let outputBytes = 0;
  let errorBytes = 0;
  const abort = () => {
    child.kill("SIGKILL");
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (data: Buffer) => {
        outputBytes += data.length;
        if (outputBytes > 1024 * 1024) {
          child.kill("SIGKILL");
        } else {
          output.push(data);
        }
      });
      // Drain but never retain decoder diagnostics containing untrusted metadata.
      child.stderr.on("data", (data: Buffer) => {
        errorBytes += data.length;
      });
      child.once("error", () => {
        reject(new PosterError("render_failed"));
      });
      child.once("close", (code) => {
        if (code !== 0 || outputBytes > 1024 * 1024 || errorBytes > 0) {
          reject(new PosterError("decode_failed"));
        } else {
          resolve();
        }
      });
    });
    signal.throwIfAborted();
    return Buffer.concat(output).toString("utf8");
  } catch (error) {
    if (
      signal.aborted &&
      signal.reason instanceof Error &&
      signal.reason.name === "TimeoutError"
    ) {
      throw new PosterError("timeout");
    }
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function verifyMediaTools(signal: AbortSignal): Promise<void> {
  const decoders = await mediaProcess(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-decoders"],
    signal,
  );
  const encoders = await mediaProcess(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-encoders"],
    signal,
  );
  const protocols = await mediaProcess(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-protocols"],
    signal,
  );
  await mediaProcess("ffprobe", ["-v", "error", "-version"], signal);
  if (
    !/\blibvpx\s/u.test(decoders) ||
    !/\blibvpx-vp9\s/u.test(decoders) ||
    !/\bpng\s/u.test(encoders) ||
    !/^\s*https\s*$/mu.test(protocols)
  ) {
    throw new PosterError("render_failed");
  }
}

async function frameBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

/** Sample the frame displayed at video-relative t=1s; normal short EOF uses the last frame. */
export async function renderPoster(
  sourceUrl: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "poster-"));
  const output = join(directory, "poster.png");
  try {
    return await decodePoster(sourceUrl, output, signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function decodePoster(
  sourceUrl: string,
  output: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const probe = await mediaProcess(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      PROTOCOLS,
      "-format_whitelist",
      FORMATS,
      "-select_streams",
      "V:0",
      "-show_entries",
      "stream=codec_name,width,height",
      "-of",
      "json",
      sourceUrl,
    ],
    probeSignal,
  );
  const media = mediaSchema.safeParse(JSON.parse(probe));
  if (!media.success) {
    throw new PosterError("invalid_media");
  }
  const stream = media.data.streams[0];
  if (!stream) {
    throw new PosterError("unsupported_media");
  }
  if (
    stream.width < 1 ||
    stream.height < 1 ||
    stream.width > 8192 ||
    stream.height > 8192 ||
    stream.width * stream.height > 16_777_216
  ) {
    throw new PosterError("unsupported_media");
  }
  const decoder =
    stream.codec_name === "vp8"
      ? ["-c:v", "libvpx"]
      : stream.codec_name === "vp9"
        ? ["-c:v", "libvpx-vp9"]
        : [];
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-xerror",
    "-err_detect",
    "explode",
    "-protocol_whitelist",
    PROTOCOLS,
    "-format_whitelist",
    FORMATS,
    "-threads",
    "1",
    ...decoder,
    "-i",
    sourceUrl,
    "-map",
    "0:V:0",
    "-an",
    "-sn",
    "-dn",
    "-threads",
    "1",
    "-pix_fmt",
    "rgba",
  ];
  const factor = "min(1,min(640/(iw*sar),640/ih))";
  const scale = `scale=w='max(1,trunc(iw*sar*${factor}))':h='max(1,trunc(ih*${factor}))',setsar=1`;
  const renderSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  // Rounding up retains the frame covering 1s for VFR media; -ss 1 picks the
  // next frame instead. Normalization also handles a non-zero stream start PTS.
  await mediaProcess(
    "ffmpeg",
    [
      ...args,
      "-vf",
      `setpts=PTS-STARTPTS,fps=fps=1:start_time=1:round=up,${scale}`,
      "-frames:v",
      "1",
      "-update",
      "1",
      output,
    ],
    renderSignal,
  );
  if ((await frameBytes(output)) === 0) {
    // Exit success with no sampled frame is normal short EOF. Decode failures
    // above never enter this fallback; both passes share the rendering deadline.
    await mediaProcess(
      "ffmpeg",
      [
        ...args,
        "-vf",
        `setpts=PTS-STARTPTS,${scale}`,
        "-fps_mode",
        "passthrough",
        "-update",
        "1",
        output,
      ],
      renderSignal,
    );
  }
  const size = await frameBytes(output);
  if (size === 0) {
    throw new PosterError("unsupported_media");
  }
  if (size > POSTER_MAX_OUTPUT_BYTES) {
    throw new PosterError("render_failed");
  }
  return await readFile(output);
}
