import type { PresentationOutputFormat } from "./presentation-output-format.ts";
import type {
  ComposerCreateMode,
  PresentationSlideCount,
} from "./composer-create.ts";
import {
  VISUALIZATION_CHARTS,
  VISUALIZATION_OUTPUTS,
  type VisualizationChart,
  type VisualizationOutput,
  type VisualizationPreferences,
} from "./composer-visualization.ts";

/** Freeze the composer's selections as agent-only context for this message. */
export function parseComposerVisualizationPreferences(
  additionalInfo: string,
): VisualizationPreferences | undefined {
  const sections = additionalInfo.split("\n\n");
  const selectionSection = sections.find((part) => {
    return part.startsWith("# Visualization Selection\n");
  });
  const section =
    selectionSection ??
    sections.find((part) => {
      return part.startsWith("# Visualization\n");
    });
  if (!section) {
    return undefined;
  }

  const outputValue = selectionSection
    ? section.match(/^- User-selected output format: (.+)$/mu)?.[1]
    : section.match(/^- Preferred output format: (.+)$/mu)?.[1];
  // `report` can be a default in legacy messages, so don't claim it was selected.
  const legacyReportDefault = !selectionSection && outputValue === "report";
  const output: VisualizationOutput | null = legacyReportDefault
    ? null
    : (VISUALIZATION_OUTPUTS.find((candidate) => {
        return candidate === outputValue;
      }) ?? null);
  const chartValues = section
    .match(
      selectionSection
        ? /^- User-selected chart types: (.+)$/mu
        : /^- Preferred chart types: (.+)$/mu,
    )?.[1]
    ?.split(",")
    .map((chart) => {
      return chart.trim();
    });
  const charts =
    chartValues?.filter((chart): chart is VisualizationChart => {
      return (VISUALIZATION_CHARTS as readonly string[]).includes(chart);
    }) ?? [];

  return output || charts.length > 0 ? { output, charts } : undefined;
}

export function buildComposerAdditionalInfo(
  mode: ComposerCreateMode | null,
  presentationSlideCount: PresentationSlideCount,
  visualization: VisualizationPreferences | undefined,
  presentationFormat?: PresentationOutputFormat,
): string | undefined {
  const text = [
    mode ? `Create ${mode === "image" ? "an" : "a"} ${mode}.` : "",
    mode === "presentation"
      ? [
          "# Presentation Generation Defaults",
          "The user set these for presentations generated in this run:",
          ...(presentationFormat
            ? [`- Output format: ${presentationFormat.toUpperCase()} format`]
            : []),
          `- Slide count: ${
            presentationSlideCount === "auto"
              ? "Auto (choose the number of slides based on the content)"
              : presentationSlideCount
          }`,
          presentationFormat
            ? "The output format is a preference. Where this run's message asks for a different output format or slide count, the message wins."
            : "Where this run's message asks for a different slide count, the message wins.",
        ].join("\n")
      : "",
    visualization
      ? [
          "# Visualization",
          "The user wants a visualized result for this run.",
          `- Preferred output format: ${visualization.output ?? "report"}${
            visualization.output === "presentation" && presentationFormat
              ? ` (${presentationFormat.toUpperCase()} format)`
              : ""
          }`,
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
    visualization
      ? [
          "# Visualization Selection",
          "These are the preferences the user explicitly selected in the composer:",
          `- User-selected output format: ${visualization.output ?? "none"}`,
          visualization.charts.length > 0
            ? `- User-selected chart types: ${visualization.charts.join(", ")}`
            : "",
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
