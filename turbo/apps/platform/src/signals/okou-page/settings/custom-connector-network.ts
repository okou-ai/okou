import { computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitches$ } from "../../external/feature-switch.ts";
import { cloudflareAccessConfigs$ } from "../../cloudflare-access.ts";

export const customConnectorCloudflareEnabled$ = computed(async (get) => {
  return (await get(featureSwitches$))[
    FeatureSwitchKey.CustomConnectorCloudflareAccess
  ];
});

export const customConnectorCloudflareChoices$ = computed(async (get) => {
  if (!(await get(customConnectorCloudflareEnabled$))) {
    return [];
  }
  const configs = await get(cloudflareAccessConfigs$);
  return (
    configs?.filter((config) => {
      return config.scope === "organization";
    }) ?? null
  );
});
