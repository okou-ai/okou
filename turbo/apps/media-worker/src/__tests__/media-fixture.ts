import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";

export const exec = promisify(execFile);
const signal = () => {
  return AbortSignal.timeout(10_000);
};

export async function fixture(
  frames: number,
  transparent = false,
  codec = "libvpx",
) {
  const directory = await mkdtemp(join(tmpdir(), "poster-test-"));
  const pixels = Buffer.alloc(32 * 32 * 4 * frames);
  for (let frame = 0; frame < frames; frame++) {
    const color =
      frame >= 30 ? 2 : frame >= Math.min(15, Math.floor(frames / 2)) ? 1 : 0;
    for (let pixel = 0; pixel < 32 * 32; pixel++) {
      const offset = (frame * 32 * 32 + pixel) * 4;
      pixels[offset + color] = 255;
      pixels[offset + 3] = transparent && pixel % 32 < 16 ? 0 : 255;
    }
  }
  const input = join(directory, "frames.rgba");
  await writeFile(input, pixels);
  const name = transparent ? "video.webm" : "video.mp4";
  await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "rawvideo",
      "-pixel_format",
      "rgba",
      "-video_size",
      "32x32",
      "-framerate",
      "30",
      "-i",
      input,
      ...(transparent
        ? ["-c:v", codec, "-auto-alt-ref", "0", "-pix_fmt", "yuva420p"]
        : ["-c:v", "libx264", "-pix_fmt", "yuv420p"]),
      "-threads",
      "1",
      join(directory, name),
    ],
    { signal: signal() },
  );
  return { directory, name, video: join(directory, name) };
}

/** Serve a fixture directory over HTTP with the range support FFmpeg relies on. */
export async function serve(directory: string): Promise<{
  readonly url: (name: string) => string;
  readonly bytesServed: () => number;
  readonly close: () => Promise<void>;
}> {
  let bytesServed = 0;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const name = (request.url ?? "/").slice(1);
      const path = join(directory, name);
      const size = await stat(path).then(
        (entry) => {
          return entry.size;
        },
        () => {
          return null;
        },
      );
      if (name.includes("/") || size === null) {
        response.writeHead(404).end();
        return;
      }
      const range = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.range ?? "");
      const start = range?.[1] ? Number(range[1]) : 0;
      const end = range?.[2] ? Number(range[2]) : size - 1;
      response.writeHead(range ? 206 : 200, {
        "accept-ranges": "bytes",
        "content-type": "video/mp4",
        "content-length": end - start + 1,
        ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = createReadStream(path, { start, end });
      stream.on("data", (chunk) => {
        bytesServed += chunk.length;
      });
      stream.pipe(response);
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: (name: string) => {
      return `http://127.0.0.1:${port}/${name}`;
    },
    bytesServed: () => {
      return bytesServed;
    },
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

export async function pixelData(png: Buffer): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "poster-pixels-"));
  const path = join(directory, "poster.png");
  await writeFile(path, png);
  const { stdout } = await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-threads",
      "1",
      "pipe:1",
    ],
    { encoding: "buffer", signal: signal() },
  );
  return stdout;
}
