import { useTranslation } from "react-i18next";
import { ChartNoAxesCombined, File } from "lucide-react";
import {
  cn,
  inlineReferenceVariants,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import type { VisualizationPreferences } from "../../signals/okou-page/composer-visualization.ts";

export function VisualizationPreferencesChip({
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
  const chartNames =
    chartLabels.length > 2
      ? `${chartLabels[0]} +${chartLabels.length - 1}`
      : chartLabels.join(", ");
  const fullChartNames = fullChartLabels.join(", ");
  const accessibleName = [
    ...(outputLabel ? [outputLabel] : []),
    ...(fullChartNames ? [`${copy.messageCharts}: ${fullChartNames}`] : []),
  ].join(", ");
  const Icon = outputLabel ? File : ChartNoAxesCombined;
  return (
    <span className="inline-flex min-w-0 max-w-full align-middle">
      <TooltipProvider delay={300}>
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={accessibleName}
                data-structured-visualization-preferences=""
                role="group"
                tabIndex={0}
                className={cn(
                  inlineReferenceVariants(),
                  "top-0 mx-0 my-0 min-w-0 max-w-[20rem] whitespace-nowrap font-normal leading-5",
                )}
              />
            }
          >
            <Icon
              className="size-4 shrink-0 text-selected-foreground"
              aria-hidden
            />
            <span className="min-w-0 truncate">
              {outputLabel ? (
                <span data-structured-visualization-output="">
                  {outputLabel}
                </span>
              ) : null}
              {outputLabel && chartLabels.length > 0 ? (
                <span aria-hidden>{" · "}</span>
              ) : null}
              {chartLabels.length > 0 ? (
                <span data-structured-visualization-chart-labels="">
                  {chartNames}
                </span>
              ) : null}
            </span>
          </TooltipTrigger>
          <TooltipContent>{accessibleName}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}
