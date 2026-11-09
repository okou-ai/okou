import { Command } from "commander";
import { createEmailUploadFileCommand } from "./upload-file";

export function createEmailCommand() {
  return new Command("email")
    .description("Deliver files to the current Email integration conversation")
    .addCommand(createEmailUploadFileCommand());
}
