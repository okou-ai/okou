import { Command } from "commander";
import { transcribeCommand } from "./transcribe";
import { framesCommand } from "./frames";
import { cameraCommand } from "./camera";

export const videoCommand = new Command()
  .name("video")
  .description("Video processing utilities")
  .addCommand(cameraCommand)
  .addCommand(transcribeCommand)
  .addCommand(framesCommand)
  .addHelpText(
    "after",
    `
Examples:
  Transcribe a video:  okou video transcribe --url "https://..."
  Web file:            okou video transcribe --file-id abc-123
  Extract frames:      okou video frames --url "https://..." --at 00:21,01:40
  Camera moves:        okou video camera --file recording.mp4 --events recording.clicks.json --output draft.mp4

Tip (video understanding):
  Transcribe first to get a timestamped index, then extract only the
  frames worth seeing instead of watching the whole video.`,
  );
