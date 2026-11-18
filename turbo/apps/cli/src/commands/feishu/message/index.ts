import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { Command } from "commander";
import { createFeishuSendCommand } from "./send";
import { historyCommand } from "./history";

export function createFeishuMessageCommand(platform: FeishuPlatform) {
  const command = new Command()
    .name("message")
    .description(`Send ${FEISHU_PLATFORMS[platform].name} messages`)
    .addCommand(createFeishuSendCommand(platform));
  if (platform === "lark") {
    command.addCommand(historyCommand);
  }
  return command;
}
