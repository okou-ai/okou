import { basename, join } from "path";
import { tmpdir } from "os";
import { Command } from "commander";
import { downloadTeamsFile } from "../../lib/api/domains/integrations-teams";
import { withErrorHandler } from "../../lib/command/with-error-handler";

function defaultOutPath(fileId: string): string {
  return join(tmpdir(), `teams-${basename(fileId).slice(0, 48)}`);
}

export const downloadFileCommand = new Command()
  .name("download-file")
  .description("Download a Microsoft Teams file by signed file id")
  .argument("<file-id>", "Microsoft Teams file id from a [Teams file] block")
  .option(
    "-o, --out <path>",
    "Output path for the downloaded file (default: /tmp/teams-<file-id>)",
  )
  .addHelpText(
    "after",
    `
Examples:
  Download to default temp path: okou teams download-file <file-id>
  Download to explicit path:     okou teams download-file <file-id> -o /tmp/file.png

Output:
  Prints a JSON object to stdout on success:
    {"path":"/tmp/teams-...","mimetype":"image/png","size":12345}

Notes:
  - File IDs must belong to this run and a conversation your connected account can access
  - Use the file id from a [Teams file] block in the prompt
  - Streams the file bytes directly to disk`,
  )
  .action(
    withErrorHandler(async (fileId: string, options: { out?: string }) => {
      const outPath = options.out ?? defaultOutPath(fileId);
      const result = await downloadTeamsFile(fileId, outPath);
      console.log(JSON.stringify(result));
    }),
  );
