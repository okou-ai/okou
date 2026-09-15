import type { ResolvedVideoGenerationOptions } from "./video-model-catalog";

type VideoRunOptions = Partial<Omit<ResolvedVideoGenerationOptions, "model">>;

function selectedVideoParameterLabels(
  options: VideoRunOptions,
): readonly string[] {
  const labels: string[] = [];
  if (options.aspectRatio !== undefined) {
    labels.push(`Aspect ratio: ${options.aspectRatio}`);
  }
  if (options.duration !== undefined) {
    labels.push(`Duration: ${options.duration}`);
  }
  if (options.resolution !== undefined) {
    labels.push(`Resolution: ${options.resolution}`);
  }
  if (options.generateAudio !== undefined) {
    labels.push(`Audio: ${options.generateAudio ? "on" : "off"}`);
  }
  return labels;
}

/**
 * The video parameters the composer sent with this message, as agent-only
 * context prepended to the visible request.
 *
 * These are defaults, and the wording has to say so. The user set them on a
 * chip before writing anything, so the message itself is the later and more
 * specific statement of intent: "make it square" has to win over a 16:9 chip
 * rather than fight it. Overrides land per parameter, so a message that names
 * only a ratio leaves the chosen duration and resolution in force.
 *
 * Values only, never the generation flags they map to. A pre-assembled flag
 * string is a ready-made answer that stops being correct the moment the
 * message overrides one value, which is the same pull toward treating these as
 * requirements that the wording above works to avoid.
 *
 * Returns "" when no video parameters are supplied. Creative Video composers
 * send all displayed settings, including defaults; unrelated runs omit this
 * block so they do not spend context on video generation settings.
 *
 * The model is not part of this block. The run already carries the video model
 * resolved from the thread pin and the member default, and the generation
 * endpoint pins that snapshot regardless of what the prompt says.
 */
export function buildVideoRunOptionsPrompt(
  options: VideoRunOptions | null,
): string {
  if (!options) {
    return "";
  }
  const labels = selectedVideoParameterLabels(options);
  if (labels.length === 0) {
    return "";
  }
  return [
    "# Video Generation Defaults",
    "The user set these for videos generated in this run:",
    ...labels.map((label) => {
      return `- ${label}`;
    }),
    "Where this run's message asks for something else, the message wins, for that parameter only.",
  ].join("\n");
}
