import { command } from "ccstate";

import { cloudBrowserEnabledByDefault$ } from "../../cloud-browser-preference.ts";
import { invalidateConnectorOverview$ } from "../connector-overview.ts";
import { updateUserPreference$ } from "./user-preferences.ts";

export const updateCloudBrowserEnabledByDefault$ = command(
  async (
    { get, set },
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    await set(
      updateUserPreference$,
      { cloudBrowserEnabledByDefault: enabled },
      signal,
    );
    signal.throwIfAborted();
    set(invalidateConnectorOverview$);
    await get(cloudBrowserEnabledByDefault$);
    signal.throwIfAborted();
  },
);
