import { Command } from "commander";
import { downloadFileCommand } from "./download-file";
import { uploadFileCommand } from "./upload-file";

export const githubCommand = new Command()
  .name("github")
  .description("Upload and download GitHub files")
  .addCommand(downloadFileCommand)
  .addCommand(uploadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Upload a file:    okou github upload-file -f /tmp/report.pdf -r okou-ai/okou -i 42
  Download a file:  okou github download-file https://github.com/user-attachments/assets/abc123 -o /tmp/out.png`,
  );
