import type { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

export type ConnectorFeatureStates =
  | Partial<Record<FeatureSwitchKey, boolean>>
  | null
  | undefined;
