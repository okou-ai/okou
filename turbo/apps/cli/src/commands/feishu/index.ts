import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { Command } from "commander";

import { createFeishuDownloadCommand } from "./download-file";
import { createFeishuMessageCommand } from "./message";
import { createFeishuUploadCommand } from "./upload-file";

export function createFeishuCommand(platform: FeishuPlatform) {
  return new Command()
    .name(platform)
    .description(
      `Send messages and transfer files through ${FEISHU_PLATFORMS[platform].name}`,
    )
    .addCommand(createFeishuMessageCommand(platform))
    .addCommand(createFeishuDownloadCommand(platform))
    .addCommand(createFeishuUploadCommand(platform))
    .addHelpText(
      "after",
      `
Examples:
  Send to a chat:       okou ${platform} message send -c <chat-id> -t "Hello!"
  Send a DM:            okou ${platform} message send -u <open-id> -t "Hello!"
  Reply in a thread:    okou ${platform} message send -r <message-id> --thread -t "Reply"
  Upload a file:        okou ${platform} upload-file -f /tmp/report.pdf -c <chat-id>
  Download a file:      okou ${platform} download-file <message-id> <file-key> --type file`,
    );
}

export const feishuCommand = createFeishuCommand("feishu");
