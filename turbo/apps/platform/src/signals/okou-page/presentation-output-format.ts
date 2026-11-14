import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { localStorageSignals } from "../external/local-storage.ts";

export const PRESENTATION_OUTPUT_FORMATS = ["html", "pptx"] as const;
export type PresentationOutputFormat =
  (typeof PRESENTATION_OUTPUT_FORMATS)[number];

const storage = localStorageSignals("presentation-output-format");

export const presentationOutputFormatEnabled$ = computed((get) => {
  const features = get(featureSwitch$);
  return (
    features[FeatureSwitchKey.HomeCapabilities] &&
    features[FeatureSwitchKey.PresentationOutputFormat]
  );
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
