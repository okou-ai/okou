import { useGet } from "ccstate-react";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { VisualizationPreferencesChip } from "./visualization-preferences-chip.tsx";

export function ComposerVisualizationPreferences({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const task = useGet(signals.taskChips.task$);
  const preferences = useGet(signals.taskChips.visualization.preferences$);
  if (task !== "visualization") {
    return null;
  }
  return <VisualizationPreferencesChip preferences={preferences} />;
}
