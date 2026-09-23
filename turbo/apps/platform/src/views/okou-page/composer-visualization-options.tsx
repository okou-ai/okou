import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ToggleButton, cn } from "@okouai/ui";
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
      // The metrics of the task-chip row this panel hangs from: `h-9`, `px-3`
      // and the button base's own radius and text size. A pill at `text-xs` was
      // the one control on the surface drawn to its own scale.
      className={cn(
        "h-9 shrink-0 px-3 py-0",
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
    // The header line, the `gap-3` under it and the group that owns the label
    // are every other type's shelf, so this panel stops being the one laid out
    // to its own metrics.
    <div
      className="flex min-w-0 flex-col gap-3"
      role="group"
      aria-label={copy.outputFormat}
    >
      <p className="min-w-0 truncate text-base font-medium">
        {copy.outputFormat}
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
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
    </div>
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
    /*
      A persistent pressed state, so the shared toggle owns `aria-pressed`, the
      focus ring and the disabled appearance. Its own selected treatment is for
      a control that is itself the surface; here the art box is, and the caption
      sits outside it the way every other type's shelf tile does. So the outer
      control is neutralised down to the frame the other shelves' tiles use, and
      the cover below carries the state.
    */
    <ToggleButton
      selected={selected}
      layout="tile"
      aria-label={label}
      // The button base clamps any nested icon to `size-4`; this tile's child is
      // a drawing that has to fill its box, not an icon.
      className={cn(
        RAIL_TILE,
        // The cover width every other type's shelf carries; the caption and the
        // 16:9 box below follow from it.
        "w-[200px] border-0 text-left font-normal",
        // `bg-transparent` alone leaves the toggle's dark selected fill: a
        // theme-prefixed utility is a different merge key, so it survives an
        // unprefixed one and would wash the tile in dark.
        "bg-transparent dark:bg-transparent",
        "[&:hover]:bg-transparent [&_svg]:size-full",
      )}
      onClick={() => {
        toggleChart(chart);
      }}
    >
      <span
        className={cn(
          // A cover, at the metrics of the covers on the other shelves: 16:9,
          // `rounded-xl` and the same `bg-muted` behind it. Only the padding is
          // this shelf's own -- a drawing sits on the tile rather than bleeding
          // to its edge the way a screenshot does.
          "flex aspect-video items-center justify-center overflow-hidden rounded-xl p-3 transition-colors",
          // Those covers are not selectable and take the hairline; this one is,
          // and `docs/styles.md` gives selection on a picture tile the emphasis
          // width -- at the hairline the selected rim reads as an antialiasing
          // artifact rather than as a state. Both branches carry that width so
          // selecting a tile never moves its siblings.
          "border-(length:--border-width-emphasis)",
          selected
            ? "border-primary bg-primary/10 text-foreground"
            : "border-transparent bg-muted text-foreground/45 group-hover/tile:text-foreground/70",
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
    <div
      className="flex min-w-0 flex-col gap-3"
      role="group"
      aria-label={copy.preferredCharts}
    >
      <p className="min-w-0 truncate text-base font-medium">
        {copy.preferredCharts}
      </p>
      <ComposerRail
        signals={signals}
        rail="charts"
        // The shelf labels its own wrapper, so the rail inside stays unnamed:
        // two groups of the same name would be two things to address.
        gap="gap-3"
        items={CURATED_VISUALIZATION_CHARTS.map((chart) => {
          return (
            <VisualizationChartButton
              key={chart}
              chart={chart}
              signals={signals}
            />
          );
        })}
      />
    </div>
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
      // Two groups, so they take the air the other panels put between their own
      // two: a shelf's `gap-3` is what a title keeps from its row, not what one
      // group keeps from the next. Tracks the panel gap in `composer-task-chips`
      // — the two modes have to read as the same surface.
      className="flex min-w-0 flex-col gap-10"
      role="region"
      aria-label={copy.panelLabel}
    >
      <VisualizationOutputPicker signals={signals} />
      <VisualizationChartPicker signals={signals} />
    </section>
  );
}
