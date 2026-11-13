import type { VisualizationPreferences } from "../../signals/okou-page/composer-visualization.ts";
import { useTranslation } from "react-i18next";
import { File } from "lucide-react";
import { Badge } from "@okouai/ui";

export function UserMessageVisualizationPreferences({
  preferences,
}: {
  readonly preferences: VisualizationPreferences;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.visualization;
    },
    { returnObjects: true },
  );
  const outputLabel = preferences.output
    ? copy.outputs[preferences.output]
    : undefined;
  const fullChartLabels = preferences.charts.map((chart) => {
    return copy.charts[chart];
  });
  const chartLabels = fullChartLabels.map((label) => {
    return label.replace(/\s+(?:chart|plot|diagram)$/iu, "");
  });
  if (!outputLabel && chartLabels.length === 0) {
    return null;
  }

  const chartNames = chartLabels.join(", ");
  const fullChartNames = fullChartLabels.join(", ");
  const accessibleName = [
    ...(outputLabel ? [outputLabel] : []),
    ...(fullChartNames ? [`${copy.messageCharts}: ${fullChartNames}`] : []),
  ].join(", ");

  return (
    <Badge
      render={
        <div
          aria-label={accessibleName}
          data-structured-visualization-preferences=""
          role="group"
          className="w-fit max-w-[20rem] min-w-0 gap-2 whitespace-nowrap py-1 text-xs text-foreground"
        />
      }
    >
      {outputLabel ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background"
          >
            <File className="size-4 text-muted-foreground" aria-hidden="true" />
          </span>
          <span data-structured-visualization-output="">{outputLabel}</span>
        </span>
      ) : null}
      {outputLabel && chartLabels.length > 0 ? (
        <span aria-hidden="true" className="h-5 w-px shrink-0 bg-divider" />
      ) : null}
      {chartLabels.length > 0 ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-muted-foreground">
            {copy.messageCharts}
          </span>
          <span
            data-structured-visualization-chart-labels=""
            className="min-w-0 truncate"
            title={fullChartNames}
          >
            {chartNames}
          </span>
        </span>
      ) : null}
    </Badge>
  );
}
