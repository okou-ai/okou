import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ToggleButton, cn } from "@okouai/ui";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import {
  VISUALIZATION_OUTPUTS,
  type VisualizationChart,
} from "../../signals/okou-page/composer-visualization.ts";
import { ComposerRail } from "./composer-rail.tsx";
import { TEMPLATE_CARD, TemplateCardFace } from "./template-card.tsx";
import { CURATED_VISUALIZATION_CHARTS } from "./composer-visualization-chart-data.ts";
import { VisualizationChartPreview } from "./composer-visualization-previews.tsx";
import {
  COMPOSER_SECTION_LABEL,
  ComposerOutputPicker,
} from "./composer-output-picker.tsx";

function VisualizationOutputPicker({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const outputFormat = t(($) => {
    return $.chat.taskChips.visualization.outputFormat;
  });
  const outputs = t(
    ($) => {
      return $.chat.taskChips.visualization.outputs;
    },
    { returnObjects: true },
  );
  const selectedOutput = useGet(signals.taskChips.visualization.output$);
  const setOutput = useSet(signals.taskChips.visualization.setOutput$);
  return (
    <ComposerOutputPicker
      label={outputFormat}
      options={VISUALIZATION_OUTPUTS.map((value) => {
        return { value, label: outputs[value] };
      })}
      selectedValue={selectedOutput}
      onSelect={setOutput}
    />
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
  const label = t(($) => {
    return $.chat.taskChips.visualization.charts[chart];
  });
  const charts = useGet(signals.taskChips.visualization.charts$);
  const toggleChart = useSet(signals.taskChips.visualization.toggleChart$);
  const selected = charts.includes(chart);
  return (
    /*
      A persistent pressed state, so the shared toggle owns `aria-pressed`, the
      focus ring and the disabled appearance. Its own selected treatment is for
      a control that is itself the surface; here the card is, so the outer
      control is neutralised down to the template card's control and the card
      carries the state in the picker's selection frame.
    */
    <ToggleButton
      selected={selected}
      layout="tile"
      aria-label={label}
      // The button base clamps any nested icon to `size-4`; this tile's child is
      // a drawing that has to fill its box, not an icon.
      className={cn(
        TEMPLATE_CARD,
        "border-0",
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
      <TemplateCardFace
        title={label}
        ratio="aspect-video"
        selected={selected}
        className={selected ? "bg-primary/10" : undefined}
      >
        {/* A drawing sits on the card rather than bleeding to its edge the
            way a screenshot does, so it keeps a padding of its own. */}
        <span
          className={cn(
            "flex size-full items-center justify-center p-3 transition-colors",
            selected ? "text-foreground" : "text-foreground/45",
          )}
        >
          <VisualizationChartPreview chart={chart} />
        </span>
      </TemplateCardFace>
    </ToggleButton>
  );
}

function VisualizationChartPicker({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const preferredCharts = t(($) => {
    return $.chat.taskChips.visualization.preferredCharts;
  });
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      role="group"
      aria-label={preferredCharts}
    >
      <p className={COMPOSER_SECTION_LABEL}>{preferredCharts}</p>
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
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const panelLabel = t(($) => {
    return $.chat.taskChips.visualization.panelLabel;
  });
  return (
    <section
      className="flex min-w-0 flex-col gap-6"
      role="region"
      aria-label={panelLabel}
    >
      <VisualizationOutputPicker signals={signals} />
      <VisualizationChartPicker signals={signals} />
    </section>
  );
}
