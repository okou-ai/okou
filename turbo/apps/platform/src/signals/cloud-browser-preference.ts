import { computed } from "ccstate";

import { composerConnectorOverview$ } from "./okou-page/composer-connector-overview.ts";

/** Whether Cloud browser should be enabled for untouched new-chat drafts. */
export const cloudBrowserEnabledByDefault$ = computed(
  async (get): Promise<boolean> => {
    return (await get(composerConnectorOverview$)).cloudBrowserEnabledByDefault;
  },
);
