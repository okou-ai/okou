import { command } from "ccstate";

import { chatResourcesEnabledByDefault$ } from "../../chat-page/chat-resources.ts";
import { updateUserPreference$ } from "./user-preferences.ts";

export const updateChatResourcesEnabledByDefault$ = command(
  async (
    { get, set },
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    await set(
      updateUserPreference$,
      { chatResourcesEnabledByDefault: enabled },
      signal,
    );
    signal.throwIfAborted();
    await get(chatResourcesEnabledByDefault$);
    signal.throwIfAborted();
  },
);
