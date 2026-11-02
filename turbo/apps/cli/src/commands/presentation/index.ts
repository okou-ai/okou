import { Command } from "commander";

import { presentationConvertCommand } from "./convert";
import { presentationScreenshotCommand } from "./screenshot";

export const presentationCommand = new Command()
  .name("presentation")
  .description("Render presentations to page images and editable decks")
  .addCommand(presentationScreenshotCommand)
  .addCommand(presentationConvertCommand);
