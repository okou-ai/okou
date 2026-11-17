import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { VisualizationPreferencesChip } from "./visualization-preferences-chip.tsx";
import { ComposerVisualizationOptions } from "./composer-visualization-options.tsx";

export function ComposerVisualizationPreferences({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const enabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatMessageVisualizationSummary];
  const task = useGet(signals.taskChips.task$);
  const preferences = useGet(signals.taskChips.visualization.preferences$);
  if (!enabled || task !== "visualization") {
    return null;
  }
  return (
    <div className="min-w-0 px-4 pb-2">
      <Popover>
        <VisualizationPreferencesChip
          preferences={preferences}
          interactive
          render={
            <PopoverTrigger render={<Button type="button" variant="quiet" />} />
          }
        />
        <PopoverContent
          side="top"
          align="start"
          className="max-h-[min(60dvh,32rem)] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto"
          aria-label={t(($) => {
            return $.chat.taskChips.visualization.panelLabel;
          })}
        >
          <ComposerVisualizationOptions signals={signals} />
        </PopoverContent>
      </Popover>
    </div>
  );
}
