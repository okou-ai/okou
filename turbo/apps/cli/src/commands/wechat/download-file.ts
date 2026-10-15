import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { downloadWechatFile } from "../../lib/api/domains/integrations-wechat-files";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface DownloadFileOptions {
  readonly channel: string;
  readonly message: string;
  readonly out?: string;
}

export const downloadFileCommand = new Command()
  .name("download-file")
  .description(
    "Download a Wechat attachment by channel, message and attachment IDs",
  )
  .argument("<attachment-id>", "Wechat attachment ID")
  .requiredOption("-c, --channel <id>", "Conversation UUID from channel list")
  .requiredOption("-m, --message <id>", "Wechat message ID")
  .option(
    "-o, --out <path>",
    "Output path (default: /tmp/wechat-<message-id>-<attachment-id>)",
  )
  .addHelpText(
    "after",
    `
Example:
  okou wechat download-file 0 -c <conversation-id> -m <stored-message-id> -o /tmp/report.pdf

Output:
  Prints JSON: {"path":"/tmp/report.pdf","mimetype":"application/octet-stream","size":12345}

Notes:
  - Requires your own verified WeChat binding in the current workspace.
  - Only attachments recorded by your current Okou connection are accessible.
  - Downloads are limited to 10 MiB; attachment URLs are resolved by the server.
  - The output file is replaced only after the full download is validated.`,
  )
  .action(
    withErrorHandler(
      async (attachmentId: string, options: DownloadFileOptions) => {
        const result = await downloadWechatFile(
          {
            channelId: options.channel,
            messageId: options.message,
            attachmentId,
          },
          options.out ??
            join(tmpdir(), `wechat-${options.message}-${attachmentId}`),
        );
        console.log(JSON.stringify(result));
      },
    ),
  );
