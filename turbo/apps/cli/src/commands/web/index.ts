import { Command } from "commander";
import { downloadFileCommand } from "./download-file";
import { uploadFileCommand } from "./upload-file";

export const webCommand = new Command()
  .name("web")
  .description("Upload and download files via the web chat endpoint")
  .addCommand(downloadFileCommand)
  .addCommand(uploadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Upload a file:    okou web upload-file -f /tmp/report.pdf
  Download a file:  okou web download-file <file-id> -o /tmp/out.pdf

Files named in [Web file] blocks live in Okou storage; download them before
reading. Local runtime paths are not user-accessible. upload-file delivers a
file into web chat storage but does not publish a hosted artifact view. Use it
when the user needs the file itself; use okou host for a static site or HTML
presentation that should be opened as a view.`,
  );
