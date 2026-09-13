import { command, computed, state } from "ccstate";

export const VISUALIZATION_OUTPUTS = [
  "presentation",
  "website",
  "spreadsheet",
  "report",
] as const;

export const VISUALIZATION_CHARTS = [
  "bar",
  "line",
  "pie",
  "scatter",
  "area",
  "stacked-bar",
  "heatmap",
  "bubble",
  "radar",
  "sankey",
  "gantt",
  "bar-race",
  "candlestick",
  "funnel",
  "nested-donut",
  "route-map",
  "choropleth-map",
  "word-cloud",
] as const;

export type VisualizationOutput = (typeof VISUALIZATION_OUTPUTS)[number];
export type VisualizationChart = (typeof VISUALIZATION_CHARTS)[number];

export interface VisualizationPreferences {
  readonly output: VisualizationOutput | null;
  readonly charts: readonly VisualizationChart[];
}

export function createComposerVisualizationSignals() {
  const output$ = state<VisualizationOutput | null>(null);
  const charts$ = state<readonly VisualizationChart[]>([]);
  const preferences$ = computed((get): VisualizationPreferences => {
    return {
      output: get(output$),
      charts: get(charts$),
    };
  });
  const setOutput$ = command(({ get, set }, output: VisualizationOutput) => {
    set(output$, get(output$) === output ? null : output);
  });
  const toggleChart$ = command(({ get, set }, chart: VisualizationChart) => {
    const charts = get(charts$);
    set(
      charts$,
      charts.includes(chart)
        ? charts.filter((item) => {
            return item !== chart;
          })
        : [...charts, chart],
    );
  });
  return {
    output$,
    charts$,
    preferences$,
    setOutput$,
    toggleChart$,
  };
}
