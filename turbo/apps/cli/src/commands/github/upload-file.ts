import { readFileSync, statSync } from "fs";
import { basename, extname } from "path";
import { Command } from "commander";
import {
  completeGithubFileUpload,
  initGithubFileUpload,
} from "../../lib/api/domains/integrations-github";
import { withErrorHandler } from "../../lib/command/with-error-handler";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".json": "application/json",
};

function inferContentType(localPath: string): string {
  const ext = extname(localPath).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

function parseIssueNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("issue-number must be a positive integer");
  }
  return parsed;
}

export const uploadFileCommand = new Command()
  .name("upload-file")
  .description("Upload a local file to a GitHub issue or pull request comment")
  .requiredOption("-f, --file <path>", "Local file path to upload")
  .requiredOption("-r, --repo <owner/name>", "GitHub repository")
  .requiredOption(
    "-i, --issue-number <number>",
    "GitHub issue or pull request number",
  )
  .option("--caption <text>", "Text to include before the file link")
  .option("--content-type <mime>", "Override inferred content type")
  .addHelpText(
    "after",
    `
Examples:
  Upload a file:          okou github upload-file -f /tmp/report.pdf -r okou-ai/okou -i 42
  With a caption:         okou github upload-file -f /tmp/data.csv -r okou-ai/okou -i 42 --caption "Daily report"

Output:
  Prints a JSON object to stdout on success:
    {"commentId":"123","repo":"okou-ai/okou","issueNumber":42,"filename":"report.pdf","mimetype":"application/pdf","size":12345,"url":"https://..."}

Notes:
  - Uses the GitHub App installation on the server side
  - Uploads through Okou storage first, then posts a GitHub comment containing the file URL`,
  )
  .action(
    withErrorHandler(
      async (options: {
        file: string;
        repo: string;
        issueNumber: string;
        caption?: string;
        contentType?: string;
      }) => {
        let fileSize: number;
        try {
          const stat = statSync(options.file);
          if (!stat.isFile()) {
            throw new Error(`Not a regular file: ${options.file}`);
          }
          fileSize = stat.size;
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("Not ")) {
            throw error;
          }
          throw new Error(`File not found: ${options.file}`);
        }

        if (fileSize === 0) {
          throw new Error("File is empty");
        }

        const filename = basename(options.file);
        const contentType =
          options.contentType ?? inferContentType(options.file);
        const issueNumber = parseIssueNumber(options.issueNumber);

        const prepared = await initGithubFileUpload({
          filename,
          contentType,
          length: fileSize,
        });

        const fileContent = readFileSync(options.file);
        const uploadResponse = await fetch(prepared.uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": prepared.contentType,
            ...prepared.uploadHeaders,
          },
          body: new Uint8Array(fileContent),
        });

        if (!uploadResponse.ok) {
          throw new Error(
            `File upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
          );
        }

        const result = await completeGithubFileUpload({
          uploadId: prepared.uploadId,
          repo: options.repo,
          issueNumber,
          contentType: prepared.contentType,
          caption: options.caption,
        });

        console.log(JSON.stringify(result));
      },
    ),
  );
