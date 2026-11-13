import { useGet, useSet } from "ccstate-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ToggleButton, cn } from "@okouai/ui";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import {
  VISUALIZATION_OUTPUTS,
  type VisualizationChart,
} from "../../signals/okou-page/composer-visualization.ts";
import {
  ComposerRail,
  RAIL_TILE,
  RAIL_TILE_CAPTION,
} from "./composer-rail.tsx";
import { CURATED_VISUALIZATION_CHARTS } from "./composer-visualization-chart-data.ts";
import { VisualizationChartPreview } from "./composer-visualization-previews.tsx";
import {
  COMPOSER_SECTION_LABEL,
  ComposerOutputPicker,
} from "./composer-output-picker.tsx";
import { ComposerPresentationOutputPicker } from "./composer-presentation-output-picker.tsx";

function VisualizationOutputPicker({
  signals,
  headerAction,
}: {
  readonly signals: ComposerSignals;
  readonly headerAction?: ReactNode;
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
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ComposerOutputPicker
        label={copy.outputFormat}
        options={VISUALIZATION_OUTPUTS.map((value) => {
          return { value, label: copy.outputs[value] };
        })}
        selectedValue={selectedOutput}
        onSelect={setOutput}
        headerAction={headerAction}
      />
      {selectedOutput === "presentation" && (
        <ComposerPresentationOutputPicker nested />
      )}
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
        "w-full border-0 text-left font-normal",
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
          // and `docs/app/styles.md` gives selection on a picture tile the emphasis
          // width -- at the hairline the selected rim reads as an antialiasing
          // artifact rather than as a state. Both branches carry that width so
          // selecting a tile never moves its siblings.
          "border-(length:--border-width-emphasis)",
          selected
            ? "border-primary bg-primary/10 text-foreground"
            : "border-transparent bg-muted text-foreground/45 group-hover/tile:text-foreground/70 in-data-[slot=capability-tray]:bg-card in-data-[slot=capability-tray]:shadow-segment-selected",
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
      <p className={COMPOSER_SECTION_LABEL}>{copy.preferredCharts}</p>
      <ComposerRail
        rail="charts"
        // The shelf labels its own wrapper, so the rail inside stays unnamed:
        // two groups of the same name would be two things to address.
        itemWidth={200}
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
  headerAction,
}: {
  readonly signals: ComposerSignals;
  readonly headerAction?: ReactNode;
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
      className="flex min-w-0 flex-col gap-10 in-data-[slot=capability-tray]:gap-6"
      role="region"
      aria-label={copy.panelLabel}
    >
      <VisualizationOutputPicker
        signals={signals}
        headerAction={headerAction}
      />
      <VisualizationChartPicker signals={signals} />
    </section>
  );
}
