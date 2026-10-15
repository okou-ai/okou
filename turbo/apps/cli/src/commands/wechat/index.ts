import { uploadFileCommand } from "./upload-file";
import { downloadFileCommand } from "./download-file";
import { Command } from "commander";
import { connectCommand } from "./connect";
import { listCommand } from "./channel/list";
import { historyCommand } from "./message/history";
import { sendCommand } from "./message/send";
export const wechatCommand = new Command()
  .name("wechat")
  .description("Connect WeChat, read recorded history and send messages")
  .addCommand(connectCommand)
  .addCommand(uploadFileCommand)
  .addCommand(downloadFileCommand)
  .addCommand(
    new Command("channel")
      .description("Discover your WeChat conversation")
      .addCommand(listCommand),
  )
  .addCommand(
    new Command("message")
      .description("Read and send WeChat messages")
      .addCommand(historyCommand)
      .addCommand(sendCommand),
  );
