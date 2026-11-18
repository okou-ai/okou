import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import type { PresentationOutputFormat } from "@okouai/core/presentation-output-format";

const storage = localStorageSignals("presentation-output-format");

export const presentationOutputFormatEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.PresentationOutputFormat];
});

export const presentationOutputFormat$ = computed(
  (get): PresentationOutputFormat => {
    return get(storage.get$) === "pptx" ? "pptx" : "html";
  },
);

export const setPresentationOutputFormat$ = command(
  ({ set }, format: PresentationOutputFormat) => {
    set(storage.set$, format);
  },
);
