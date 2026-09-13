import type { ChatRunVideoOptionsRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { buildVideoRunOptionsPrompt } from "@okouai/core/video-run-options-prompt";
import type {
  ComposerCreateMode,
  PresentationSlideCount,
} from "./composer-create.ts";
import type { VisualizationPreferences } from "./composer-visualization.ts";

/** Freeze the composer's selections as agent-only context for this message. */
export function buildComposerAdditionalInfo(
  mode: ComposerCreateMode | null,
  videoRunOptions: ChatRunVideoOptionsRequest | undefined,
  presentationSlideCount: PresentationSlideCount,
  visualization: VisualizationPreferences | undefined,
): string | undefined {
  const text = [
    buildVideoRunOptionsPrompt(videoRunOptions ?? null),
    mode ? `Create ${mode === "image" ? "an" : "a"} ${mode}.` : "",
    mode === "presentation"
      ? [
          "# Presentation Generation Defaults",
          "The user set these for presentations generated in this run:",
          `- Slide count: ${
            presentationSlideCount === "auto"
              ? "Auto (choose the number of slides based on the content)"
              : presentationSlideCount
          }`,
          "Where this run's message asks for a different slide count, the message wins.",
        ].join("\n")
      : "",
    visualization
      ? [
          "# Visualization",
          "The user wants a visualized result for this run.",
          visualization.output
            ? `- Preferred output format: ${visualization.output}`
            : "",
          visualization.charts.length > 0
            ? `- Preferred chart types: ${visualization.charts.join(", ")}`
            : "",
          "Chart selections are preferences, not requirements. Never invent or alter data to force a preferred chart; use another suitable visual treatment when the data does not support one.",
          "Where this run's message asks for a different output or visual treatment, the message wins.",
        ]
          .filter((part) => {
            return part.length > 0;
          })
          .join("\n")
      : "",
  ]
    .filter((part) => {
      return part.length > 0;
    })
    .join("\n\n");
  return text.length > 0 ? text : undefined;
}
