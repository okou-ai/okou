import { Command } from "commander";
import { framesCommand } from "./frames";
import { cameraCommand } from "./camera";

export const videoCommand = new Command()
  .name("video")
  .description("Video processing utilities")
  .addCommand(cameraCommand)
  .addCommand(framesCommand)
  .addHelpText(
    "after",
    `
Examples:
  Extract frames:      okou video frames --url "https://..." --at 00:21,01:40
  Camera moves:        okou video camera --file recording.mp4 --events recording.clicks.json --output draft.mp4

Tip (video understanding):
  Extract frames at the moments worth inspecting instead of watching
  the whole video.`,
  );
