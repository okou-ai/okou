import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useLastResolved } from "ccstate-react";
import { featureSwitches$ } from "../../signals/external/feature-switch.ts";

export function useForYouSimplifiedDeck() {
  const features = useLastResolved(featureSwitches$);
  return features?.[FeatureSwitchKey.ForYouSimplifiedDeck] ?? false;
}
