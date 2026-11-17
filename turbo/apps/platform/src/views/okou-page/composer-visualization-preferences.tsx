import { useGet } from "ccstate-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { VisualizationPreferencesChip } from "./visualization-preferences-chip.tsx";

export function ComposerVisualizationPreferences({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const enabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatMessageVisualizationSummary];
  const task = useGet(signals.taskChips.task$);
  const preferences = useGet(signals.taskChips.visualization.preferences$);
  if (!enabled || task !== "visualization") {
    return null;
  }
  return <VisualizationPreferencesChip preferences={preferences} />;
}
