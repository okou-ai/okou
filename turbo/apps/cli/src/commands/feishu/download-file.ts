import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { Command } from "commander";
import type { FeishuResourceType } from "@okouai/api-contracts/contracts/integrations";

import { downloadFeishuFile } from "../../lib/api/domains/integrations-feishu";
import { withErrorHandler } from "../../lib/command/with-error-handler";

function defaultOutPath(fileKey: string, platform: FeishuPlatform): string {
  return join(tmpdir(), `${platform}-${basename(fileKey).slice(0, 80)}`);
}

function parseResourceType(value: string): FeishuResourceType {
  if (value !== "file" && value !== "image") {
    throw new Error("--type must be either file or image");
  }
  return value;
}

export function createFeishuDownloadCommand(platform: FeishuPlatform) {
  const providerName = FEISHU_PLATFORMS[platform].name;
  return new Command()
    .name("download-file")
    .description(`Download a file from a ${providerName} message`)
    .argument("<message-id>", `Message ID from a [${providerName} file] block`)
    .argument("<file-key>", `File key from a [${providerName} file] block`)
    .requiredOption(
      "--type <type>",
      "Resource type from the block: file or image",
    )
    .option("-i, --installation <id>", `${providerName} installation ID`)
    .option(
      "-o, --out <path>",
      `Output path (default: /tmp/${platform}-<file-key>)`,
    )
    .addHelpText(
      "after",
      `
Examples:
  Download a file:   okou ${platform} download-file om_xxx file_xxx --type file
  Download an image: okou ${platform} download-file om_xxx img_xxx --type image -o /tmp/image.png
  Select an app:     okou ${platform} download-file om_xxx file_xxx --type file -i <installation-id>

Output:
  Prints a JSON object to stdout on success:
    {"path":"/tmp/${platform}-file_xxx","mimetype":"application/pdf","size":12345}

Notes:
  - Use the message ID, file key, and type exactly as shown in a [${providerName} file] block
  - Specify --installation when the organization has multiple ${providerName} bots
  - Streams the file bytes directly to disk`,
    )
    .action(
      withErrorHandler(
        async (
          messageId: string,
          fileKey: string,
          options: {
            readonly type: string;
            readonly installation?: string;
            readonly out?: string;
          },
        ) => {
          const outPath = options.out ?? defaultOutPath(fileKey, platform);
          const result = await downloadFeishuFile(
            messageId,
            fileKey,
            parseResourceType(options.type),
            options.installation,
            outPath,
            platform,
          );
          console.log(JSON.stringify(result));
        },
      ),
    );
}
