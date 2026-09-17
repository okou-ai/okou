import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { Command } from "commander";

import { createFeishuSendCommand } from "./send";

export function createFeishuMessageCommand(platform: FeishuPlatform) {
  return new Command()
    .name("message")
    .description(`Send ${FEISHU_PLATFORMS[platform].name} messages`)
    .addCommand(createFeishuSendCommand(platform));
}
