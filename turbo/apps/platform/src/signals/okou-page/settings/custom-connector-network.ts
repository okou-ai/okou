import { computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { cloudflareAccessConfigs$ } from "../../cloudflare-access.ts";

export const customConnectorCloudflareEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.CustomConnectorCloudflareAccess];
});

export const customConnectorCloudflareChoices$ = computed(async (get) => {
  if (!get(customConnectorCloudflareEnabled$)) {
    return [];
  }
  const configs = await get(cloudflareAccessConfigs$);
  return (
    configs?.filter((config) => {
      return config.scope === "organization";
    }) ?? null
  );
});
