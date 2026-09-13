import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Card, ToggleButton, cn } from "@okouai/ui";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import {
  VISUALIZATION_OUTPUTS,
  type VisualizationChart,
  type VisualizationOutput,
} from "../../signals/okou-page/composer-visualization.ts";
import { CURATED_VISUALIZATION_CHARTS } from "./composer-visualization-chart-data.ts";
import { VisualizationChartPreview } from "./composer-visualization-previews.tsx";

function VisualizationHeader() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.visualization;
    },
    { returnObjects: true },
  );
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <h3 className="text-sm font-semibold">{copy.title}</h3>
      <span className="shrink-0 text-xs text-muted-foreground">
        {copy.optional}
      </span>
    </div>
  );
}

function VisualizationOutputButton({
  output,
  signals,
}: {
  readonly output: VisualizationOutput;
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.visualization;
    },
    { returnObjects: true },
  );
  const selectedOutput = useGet(signals.taskChips.visualization.output$);
  const setOutput = useSet(signals.taskChips.visualization.setOutput$);
  const label = copy.outputs[output];
  const selected = selectedOutput === output;
  return (
    <ToggleButton
      selected={selected}
      layout="tile"
      aria-label={label}
      className={cn(
        "h-11 rounded-xl px-3 py-2 text-center text-xs font-medium text-foreground last:col-span-2 sm:last:col-span-1",
        !selected && "bg-transparent",
      )}
      onClick={() => {
        setOutput(output);
      }}
    >
      <span className="block truncate">{label}</span>
    </ToggleButton>
  );
}

function VisualizationOutputPicker({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.visualization;
    },
    { returnObjects: true },
  );
  return (
    <section className="flex min-w-0 flex-col gap-2.5">
      <h4 className="text-xs font-medium">{copy.outputFormat}</h4>
      <div
        className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4"
        role="group"
        aria-label={copy.outputFormat}
      >
        {VISUALIZATION_OUTPUTS.map((output) => {
          return (
            <VisualizationOutputButton
              key={output}
              output={output}
              signals={signals}
            />
          );
        })}
      </div>
    </section>
  );
}

function VisualizationChartButton({
  chart,
  signals,
}: {
  readonly chart: VisualizationChart;
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.visualization;
    },
    { returnObjects: true },
  );
  const charts = useGet(signals.taskChips.visualization.charts$);
  const toggleChart = useSet(signals.taskChips.visualization.toggleChart$);
  const label = copy.charts[chart];
  const selected = charts.includes(chart);
  return (
    <ToggleButton
      selected={selected}
      layout="tile"
      aria-label={label}
      className={cn(
        "group min-h-[104px] overflow-hidden rounded-xl p-1.5 text-foreground",
        !selected && "bg-transparent",
      )}
      onClick={() => {
        toggleChart(chart);
      }}
    >
      <span className="block h-[70px]">
        <VisualizationChartPreview chart={chart} />
      </span>
      <span className="mt-1.5 block truncate px-1 text-center text-xs font-medium">
        {label}
      </span>
    </ToggleButton>
  );
}

function VisualizationChartPicker({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.visualization;
    },
    { returnObjects: true },
  );
  return (
    <section className="flex min-w-0 flex-col gap-2.5 border-t pt-3">
      <h4 className="text-xs font-medium">{copy.preferredCharts}</h4>
      <div
        className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"
        role="group"
        aria-label={copy.preferredCharts}
      >
        {CURATED_VISUALIZATION_CHARTS.map((chart) => {
          return (
            <VisualizationChartButton
              key={chart}
              chart={chart}
              signals={signals}
            />
          );
        })}
      </div>
    </section>
  );
}

export function ComposerVisualizationOptions({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.visualization;
    },
    { returnObjects: true },
  );
  return (
    <Card
      className="min-w-0 rounded-3xl p-3 sm:p-4"
      role="region"
      aria-label={copy.panelLabel}
    >
      <div className="flex min-w-0 flex-col gap-3">
        <VisualizationHeader />
        <VisualizationOutputPicker signals={signals} />
        <VisualizationChartPicker signals={signals} />
        <p className="text-xs text-muted-foreground">{copy.chartSafety}</p>
      </div>
    </Card>
  );
}
