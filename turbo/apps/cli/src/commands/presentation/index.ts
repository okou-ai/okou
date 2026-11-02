import { Command } from "commander";

import { presentationScreenshotCommand } from "./screenshot";

export const presentationCommand = new Command()
  .name("presentation")
  .description("Render presentations to page images")
  .addCommand(presentationScreenshotCommand);
