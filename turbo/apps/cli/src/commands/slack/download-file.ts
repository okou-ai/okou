import { basename, join } from "path";
import { tmpdir } from "os";
import { Command } from "commander";
import { downloadSlackFile } from "../../lib/api/domains/integrations-slack";
import { withErrorHandler } from "../../lib/command/with-error-handler";

/**
 * Derive a local output path for a Slack file id.
 * Uses the system temp directory; extension is appended later once the
 * mimetype is known.
 *
 * `basename` strips any path separators from `fileId` so a hostile id like
 * `../etc/passwd` cannot escape `tmpdir()`.
 */
function defaultOutPath(fileId: string): string {
  return join(tmpdir(), `slack-${basename(fileId)}`);
}

export const downloadFileCommand = new Command()
  .name("download-file")
  .description("Download a Slack file by id using the bot token")
  .argument("<file-id>", "Slack file id (e.g. F01234ABCD)")
  .option(
    "-o, --out <path>",
    "Output path for the downloaded file (default: /tmp/slack-<file-id>)",
  )
  .addHelpText(
    "after",
    `
Examples:
  Download to default temp path: okou slack download-file F01234ABCD
  Download to explicit path:     okou slack download-file F01234ABCD -o /tmp/image.png

Output:
  Prints a JSON object to stdout on success:
    {"path":"/tmp/slack-F01234ABCD","mimetype":"image/png","size":12345}

How to read the downloaded file:
  - Images (png/jpg/gif/webp/svg): open the file path with your image viewing tool
  - Videos (mp4/mov/webm): extract frames with
      ffmpeg -i <path> -vf "fps=1" -q:v 2 /tmp/<file-id>_frame_%03d.jpg
  - PDF/text/csv/json/markdown: read the file directly

Notes:
  - Uses the bot token on the server side; no user Slack token is needed
  - Streams the file bytes directly to disk`,
  )
  .action(
    withErrorHandler(async (fileId: string, options: { out?: string }) => {
      const outPath = options.out ?? defaultOutPath(fileId);
      const result = await downloadSlackFile(fileId, outPath);
      console.log(JSON.stringify(result));
    }),
  );
