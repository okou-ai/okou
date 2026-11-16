import { useRender } from "@base-ui/react/use-render";
import { useTranslation } from "react-i18next";
import { ChartNoAxesCombined, ChevronDown, File } from "lucide-react";
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
  interactive = false,
  render,
}: {
  readonly preferences: VisualizationPreferences;
  readonly interactive?: boolean;
  readonly render?: useRender.ComponentProps<"div">["render"];
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
  const hasSelection = !!outputLabel || chartLabels.length > 0;
  const chartNames =
    chartLabels.length > 2
      ? `${chartLabels[0]} +${chartLabels.length - 1}`
      : chartLabels.join(", ");
  const fullChartNames = fullChartLabels.join(", ");
  const accessibleName =
    [
      ...(outputLabel ? [outputLabel] : []),
      ...(fullChartNames ? [`${copy.messageCharts}: ${fullChartNames}`] : []),
    ].join(", ") || copy.messageCharts;
  const Icon = outputLabel ? File : ChartNoAxesCombined;
  const chip = useRender({
    defaultTagName: "div",
    render,
    props: {
      "aria-label": accessibleName,
      "data-structured-visualization-preferences": "",
      role: interactive ? undefined : "group",
      tabIndex: interactive ? undefined : 0,
      className: cn(
        inlineReferenceVariants({ interactive }),
        "top-0 mx-0 my-0 min-w-0 max-w-[20rem] whitespace-nowrap font-normal leading-5",
      ),
      children: (
        <>
          <Icon
            className="size-4 shrink-0 text-selected-foreground"
            aria-hidden
          />
          <span className="min-w-0 truncate">
            {outputLabel ? (
              <span data-structured-visualization-output="">{outputLabel}</span>
            ) : null}
            {outputLabel && chartLabels.length > 0 ? (
              <span aria-hidden>{" · "}</span>
            ) : null}
            {chartLabels.length > 0 ? (
              <span data-structured-visualization-chart-labels="">
                {chartNames}
              </span>
            ) : null}
            {!hasSelection ? copy.messageCharts : null}
          </span>
          {interactive ? (
            <ChevronDown
              className="size-3 shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : null}
        </>
      ),
    },
  });

  if (!hasSelection && !interactive) {
    return null;
  }
  return (
    <span className="inline-flex max-w-full align-middle">
      <TooltipProvider delay={300}>
        <Tooltip>
          <TooltipTrigger render={chip} />
          <TooltipContent>{accessibleName}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}
