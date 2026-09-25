import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { downloadDiscordFile } from "../../lib/api/domains/integrations-discord-files";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface DownloadFileOptions {
  readonly channel: string;
  readonly message: string;
  readonly guildId?: string;
  readonly out?: string;
}

export const downloadFileCommand = new Command()
  .name("download-file")
  .description(
    "Download a Discord attachment by channel, message and attachment IDs",
  )
  .argument("<attachment-id>", "Discord attachment ID")
  .requiredOption("-c, --channel <id>", "Discord channel or thread ID")
  .requiredOption("-m, --message <id>", "Discord message ID")
  .option(
    "--guild-id <id>",
    "Optional; must match your organization's bound guild",
  )
  .option(
    "-o, --out <path>",
    "Output path (default: /tmp/discord-<attachment-id>)",
  )
  .addHelpText(
    "after",
    `
Example:
  okou discord download-file 123456789012345680 -c 123456789012345678 -m 123456789012345679 -o /tmp/report.pdf

Output:
  Prints JSON: {"path":"/tmp/report.pdf","mimetype":"application/pdf","size":12345}

Notes:
  - Both the requesting user and bot must have access to the message.
  - Downloads are limited to 10 MiB; attachment URLs are resolved by the server.
  - The output file is replaced only after the full download is validated.`,
  )
  .action(
    withErrorHandler(
      async (attachmentId: string, options: DownloadFileOptions) => {
        const result = await downloadDiscordFile(
          {
            channelId: options.channel,
            messageId: options.message,
            attachmentId,
            ...(options.guildId === undefined
              ? {}
              : { guildId: options.guildId }),
          },
          options.out ?? join(tmpdir(), `discord-${attachmentId}`),
        );
        console.log(JSON.stringify(result));
      },
    ),
  );
