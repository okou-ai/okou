import { basename, join } from "path";
import { tmpdir } from "os";
import { Command } from "commander";
import { downloadTelegramFile } from "../../lib/api/domains/integrations-telegram";
import { withErrorHandler } from "../../lib/command/with-error-handler";

/**
 * Derive a local output path for a Telegram file id.
 * Uses the system temp directory.
 *
 * `basename` strips any path separators from `fileId` so a hostile id like
 * `../etc/passwd` cannot escape `tmpdir()`.
 */
function defaultOutPath(fileId: string): string {
  return join(tmpdir(), `telegram-${basename(fileId)}`);
}

export const downloadFileCommand = new Command()
  .name("download-file")
  .description("Download a file received by the official Okou Telegram bot")
  .argument("<file-id>", "Telegram file id from a [Telegram file] block")
  .option(
    "-o, --out <path>",
    "Output path for the downloaded file (default: /tmp/telegram-<file-id>)",
  )
  .addHelpText(
    "after",
    `
Examples:
  Download to default temp path: okou telegram download-file AgACAgUAAxkBAA
  Download to explicit path:     okou telegram download-file AgACAgUAAxkBAA -o /tmp/photo.jpg

Output:
  Prints a JSON object to stdout on success:
    {"path":"/tmp/telegram-AgACAgUAAxkBAA","mimetype":"image/jpeg","size":12345}

How to read the downloaded file:
  - Images (png/jpg/gif/webp/svg): open the file path with your image viewing tool
  - Videos (mp4/mov/webm): extract frames with
      ffmpeg -i <path> -vf "fps=1" -q:v 2 /tmp/<file-id>_frame_%03d.jpg
  - PDF/text/csv/json/markdown: read the file directly

Notes:
  - Uses the official Okou Telegram bot
  - Streams the file bytes directly to disk`,
  )
  .action(
    withErrorHandler(async (fileId: string, options: { out?: string }) => {
      const outPath = options.out ?? defaultOutPath(fileId);
      const result = await downloadTelegramFile(fileId, outPath);
      console.log(JSON.stringify(result));
    }),
  );
