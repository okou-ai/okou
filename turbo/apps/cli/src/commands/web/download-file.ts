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

export function createDownloadFileCommand(name: string, invocation: string) {
  return new Command(name)
    .description(
      "Download a file or hosted HTML page by ID or authorized artifact reference",
    )
    .argument(
      "<file-id>",
      "File UUID, artifact URL, or /artifacts/<hash> reference",
    )
    .option(
      "-o, --out <path>",
      "Output path for the downloaded file (default: /tmp/web-<file-id>)",
    )
    .addHelpText(
      "after",
      `
Examples:
  Download to default temp path: ${invocation} /artifacts/abc123def4.pdf
  Download to explicit path:     ${invocation} /artifacts/abc123def4.pdf -o /tmp/report.pdf
  Download from an artifact URL: ${invocation} https://app.okou.ai/artifacts/abc123def4.pdf
  Download a hosted HTML page:   ${invocation} /artifacts/abc123def4.html -o /tmp/index.html

Output:
  Prints a JSON object to stdout on success:
    {"path":"/tmp/web-abc123def4.pdf","mimetype":"application/pdf","size":12345}

How to read the downloaded file:
  - Images (png/jpg/gif/webp/svg): open the file path with your image viewing tool
  - Videos (mp4/mov/webm): transcribe audio first with
      okou video transcribe --url <download-url>
    or extract frames with
      ffmpeg -i <path> -vf "fps=1" -q:v 2 /tmp/<file-id>_frame_%03d.jpg
  - PDF/text/csv/json/markdown: read the file directly

Notes:
  - Use this command for the ID in a [Web file] block, an artifact URL, or a /artifacts/<hash> reference
  - Artifact references require artifact:read and allow owned, organization-shared, or public artifacts under their current access policy
  - Raw file IDs and /api/web/download-file URLs require file:read and retain their existing file access checks
  - Hosted HTML downloads only the entry page; use okou host clone for all files of an owned site
  - The output path is local to this runtime; users cannot open it directly
  - Authenticates access via OKOU_TOKEN; delivery URLs do not receive the token
  - Streams the file bytes directly to disk`,
    )
    .action(
      withErrorHandler(async (fileId: string, options: { out?: string }) => {
        const outPath = options.out ?? defaultOutPath(fileId);
        const result = await downloadWebFile(fileId, outPath);
        console.log(JSON.stringify(result));
      }),
    );
}

export const downloadFileCommand = createDownloadFileCommand(
  "download-file",
  "okou web download-file",
);
