import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Button, ToggleButton, cn } from "@okouai/ui";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import {
  VISUALIZATION_OUTPUTS,
  type VisualizationChart,
  type VisualizationOutput,
} from "../../signals/okou-page/composer-visualization.ts";
import {
  ComposerRail,
  RAIL_TILE,
  RAIL_TILE_CAPTION,
} from "./composer-rail.tsx";
import { CURATED_VISUALIZATION_CHARTS } from "./composer-visualization-chart-data.ts";
import { VisualizationChartPreview } from "./composer-visualization-previews.tsx";

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
      // `tile` is `block w-full`, which made every chip claim its own row once
      // the picker stopped being a grid. `inline` is the layout that shrinks.
      layout="inline"
      aria-label={label}
      className={cn(
        "h-8 shrink-0 rounded-full px-3.5 py-0 text-xs font-medium",
        !selected && "border-control-border bg-transparent",
      )}
      onClick={() => {
        setOutput(output);
      }}
    >
      {label}
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
        className="flex min-w-0 flex-wrap items-center gap-1.5"
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
    // Built like a cover tile rather than a toggle: art in its own box, caption
    // under it and outside it, so the row reads the same as every other type's
    // shelf. The pressed state rides on the box, not on the whole control.
    <Button
      type="button"
      variant="quiet"
      aria-pressed={selected}
      aria-label={label}
      // The button base clamps any nested icon to `size-4`; this tile's child is
      // a drawing that has to fill its box, not an icon.
      className={cn(RAIL_TILE, "w-[140px] [&_svg]:size-full")}
      onClick={() => {
        toggleChart(chart);
      }}
    >
      <span
        className={cn(
          "flex h-[84px] items-center justify-center rounded-lg border-2 p-2.5 transition-colors",
          // Selection is a heavier stroke, which survives a row of grey
          // silhouettes in a way a fill alone does not.
          selected
            ? "border-primary bg-primary/10 text-foreground"
            : "border-transparent bg-muted/60 text-foreground/45 group-hover/tile:bg-muted group-hover/tile:text-foreground/70",
        )}
      >
        <VisualizationChartPreview chart={chart} />
      </span>
      <span
        className={cn(
          RAIL_TILE_CAPTION,
          selected ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </Button>
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
    <section className="flex min-w-0 flex-col gap-2.5">
      <h4 className="text-xs font-medium">{copy.preferredCharts}</h4>
      <ComposerRail
        signals={signals}
        rail="charts"
        label={copy.preferredCharts}
        gap="gap-2"
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
      </ComposerRail>
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
    <section
      className="flex min-w-0 flex-col gap-4"
      role="region"
      aria-label={copy.panelLabel}
    >
      <VisualizationOutputPicker signals={signals} />
      <VisualizationChartPicker signals={signals} />
    </section>
  );
}
