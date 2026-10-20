import { computed } from "ccstate";

import { userPreferences$ } from "./okou-page/settings/user-preferences.ts";

/** The saved user default shown in Chat settings; submission resolves it server-side. */
export const cloudBrowserEnabledByDefault$ = computed(
  async (get): Promise<boolean> => {
    return (await get(userPreferences$)).cloudBrowserEnabledByDefault;
  },
);
