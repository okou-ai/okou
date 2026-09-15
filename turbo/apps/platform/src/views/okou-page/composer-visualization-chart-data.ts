import type { VisualizationChart } from "../../signals/okou-page/composer-visualization.ts";

/** A focused mix of familiar charts and distinctive visual treatments. */
export const CURATED_VISUALIZATION_CHARTS = [
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
] as const satisfies readonly VisualizationChart[];
