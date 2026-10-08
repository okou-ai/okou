import { execFileSync } from "child_process";
import { mkdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Command } from "commander";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { downloadWebFile } from "../../lib/api/domains/web";

interface ExtractedFrame {
  readonly at: string;
  readonly path: string;
}

export const framesCommand = new Command()
  .name("frames")
  .description("Extract still frames from a video at the given timestamps")
  .option("--url <presigned-url>", "Pre-signed or public URL of the video file")
  .option("--file-id <id>", "Web file ID (alternative to --url)")
  .requiredOption(
    "--at <timestamps>",
    "Comma-separated timestamps to capture (e.g. 00:21,01:40 or 12,95.5)",
  )
  .addHelpText(
    "after",
    `
Examples:
  Frames at two moments:  okou video frames --url "https://..." --at 00:21,01:40
  From a web file:        okou video frames --file-id abc-123 --at 12,95.5

Output:
  Prints a JSON object to stdout, one entry per timestamp:
    {"frames":[{"at":"00:21","path":"/tmp/video-frames-.../frame-001.jpg"}]}

Tip:
  Extract frames at the moments that matter for a closer look.

Notes:
  - Requires ffmpeg on PATH for frame extraction
  - Timestamps accept SS, MM:SS, or HH:MM:SS (fractions allowed, e.g. 95.5)
  - Extracted frames are kept on disk; only the downloaded video is cleaned up`,
  )
  .action(
    withErrorHandler(
      async (options: { url?: string; fileId?: string; at: string }) => {
        if (!options.url && !options.fileId) {
          process.stderr.write(
            "Error: provide --url <presigned-url> or --file-id <id>\n",
          );
          process.exit(1);
        }

        const timestamps = options.at
          .split(",")
          .map((s) => {
            return s.trim();
          })
          .filter((s) => {
            return s.length > 0;
          });
        if (timestamps.length === 0) {
          process.stderr.write("Error: --at requires at least one timestamp\n");
          process.exit(1);
        }

        const outDir = join(tmpdir(), `video-frames-${Date.now()}`);
        mkdirSync(outDir, { recursive: true });

        const tmpVideo = join(tmpdir(), `video-input-${Date.now()}.mp4`);

        try {
          if (options.url) {
            execFileSync("curl", ["-sS", "-L", "-o", tmpVideo, options.url], {
              stdio: ["ignore", "ignore", "pipe"],
            });
          } else {
            await downloadWebFile(options.fileId as string, tmpVideo);
          }

          const frames: ExtractedFrame[] = timestamps.map((at, index) => {
            const outPath = join(
              outDir,
              `frame-${String(index + 1).padStart(3, "0")}.jpg`,
            );
            execFileSync(
              "ffmpeg",
              [
                "-ss",
                at,
                "-i",
                tmpVideo,
                "-frames:v",
                "1",
                "-q:v",
                "2",
                outPath,
                "-y",
                "-loglevel",
                "error",
              ],
              { stdio: ["ignore", "ignore", "pipe"] },
            );
            return { at, path: outPath };
          });

          process.stdout.write(JSON.stringify({ frames }) + "\n");
        } finally {
          try {
            unlinkSync(tmpVideo);
          } catch {
            // best-effort cleanup
          }
        }
      },
    ),
  );
