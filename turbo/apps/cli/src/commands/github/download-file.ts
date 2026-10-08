import { basename, join } from "path";
import { tmpdir } from "os";
import { Command } from "commander";
import { downloadGithubFile } from "../../lib/api/domains/integrations-github";
import { withErrorHandler } from "../../lib/command/with-error-handler";

function filenameFromUrl(fileUrl: string): string {
  if (URL.canParse(fileUrl)) {
    const segment = new URL(fileUrl).pathname.split("/").filter(Boolean).pop();
    if (!segment) {
      return "file";
    }
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }
  return basename(fileUrl) || "file";
}

function safeDefaultFilename(filename: string): string {
  const component = basename(filename.replaceAll("\\", "/"));
  if (!component || component === "." || component === "..") {
    return "file";
  }
  return component;
}

function defaultOutPath(fileUrl: string, filename?: string): string {
  return join(
    tmpdir(),
    `github-${safeDefaultFilename(filename || filenameFromUrl(fileUrl))}`,
  );
}

export const downloadFileCommand = new Command()
  .name("download-file")
  .description("Download a file from a GitHub context block")
  .argument("<url>", "URL from a [GitHub file] block")
  .option(
    "-o, --out <path>",
    "Output path for the downloaded file (default: /tmp/github-<filename-or-url-basename>)",
  )
  .option("--filename <name>", "Filename hint from the [GitHub file] block")
  .addHelpText(
    "after",
    `
Examples:
  Download to default temp path: okou github download-file https://github.com/user-attachments/assets/abc123 --filename screenshot.png
  Download to explicit path:     okou github download-file https://github.com/user-attachments/assets/abc123 -o /tmp/screenshot.png

Output:
  Prints a JSON object to stdout on success:
    {"path":"/tmp/github-screenshot.png","mimetype":"image/png","size":12345}

How to read the downloaded file:
  - Images (png/jpg/gif/webp/svg): open the file path with your image viewing tool
  - Videos (mp4/mov/webm): extract frames with
      ffmpeg -i <path> -vf "fps=1" -q:v 2 /tmp/github_frame_%03d.jpg
  - PDF/text/csv/json/markdown: read the file directly

Notes:
  - The URL comes from a [GitHub file] block
  - Streams the GitHub file bytes through Okou directly to disk`,
  )
  .action(
    withErrorHandler(
      async (fileUrl: string, options: { out?: string; filename?: string }) => {
        const outPath =
          options.out ?? defaultOutPath(fileUrl, options.filename);
        const result = await downloadGithubFile(
          fileUrl,
          outPath,
          options.filename,
        );
        console.log(JSON.stringify(result));
      },
    ),
  );
