import { basename, join } from "path";
import { tmpdir } from "os";
import { Command } from "commander";
import { downloadWebFile } from "../../lib/api/domains/web";
import { withErrorHandler } from "../../lib/command/with-error-handler";

/**
 * Derive a local output path for a web-uploaded file id.
 * Uses the system temp directory.
 *
 * `basename` strips any path separators from `fileId` so a hostile id like
 * `../etc/passwd` cannot escape `tmpdir()`.
 */
function defaultOutPath(fileId: string): string {
  return join(tmpdir(), `web-${basename(fileId)}`);
}

export const downloadFileCommand = new Command()
  .name("download-file")
  .description("Download a file by id or /artifacts/<hash> reference")
  .argument("<file-id>", "File UUID or /artifacts/<hash> reference")
  .option(
    "-o, --out <path>",
    "Output path for the downloaded file (default: /tmp/web-<file-id>)",
  )
  .addHelpText(
    "after",
    `
Examples:
  Download to default temp path: okou web download-file abc-123-def
  Download to explicit path:     okou web download-file abc-123-def -o /tmp/report.pdf

Output:
  Prints a JSON object to stdout on success:
    {"path":"/tmp/web-abc-123-def","mimetype":"application/pdf","size":12345}

How to read the downloaded file:
  - Images (png/jpg/gif/webp/svg): open the file path with your image viewing tool
  - Videos (mp4/mov/webm): transcribe audio first with
      okou video transcribe --url <download-url>
    or extract frames with
      ffmpeg -i <path> -vf "fps=1" -q:v 2 /tmp/<file-id>_frame_%03d.jpg
  - PDF/text/csv/json/markdown: read the file directly

Notes:
  - Use this command for the ID in a [Web file] block or a private /artifacts/<hash> reference
  - The output path is local to this runtime; users cannot open it directly
  - Authenticates via OKOU_TOKEN
  - Streams the file bytes directly to disk`,
  )
  .action(
    withErrorHandler(async (fileId: string, options: { out?: string }) => {
      const outPath = options.out ?? defaultOutPath(fileId);
      const result = await downloadWebFile(fileId, outPath);
      console.log(JSON.stringify(result));
    }),
  );
