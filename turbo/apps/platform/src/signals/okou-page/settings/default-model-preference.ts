import { command } from "ccstate";

import type { ModelProviderSelection } from "../../../views/okou-page/components/model-provider-picker.tsx";
import {
  reloadUserModelPreference$,
  updateUserModelPreference$,
  userModelPreference$,
} from "../../external/user-model-preference.ts";

export const updateDefaultModelPreference$ = command(
  async (
    { get, set },
    selection: ModelProviderSelection | null,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const preference = await get(userModelPreference$);
    signal.throwIfAborted();
    const selectedModel = selection?.selectedModel;
    const selectedEffort = selectedModel
      ? selection.modelSettings?.[selectedModel]?.effort
      : undefined;
    const storedEffort = selectedModel
      ? preference.modelSettings[selectedModel]?.effort
      : undefined;
    await set(
      updateUserModelPreference$,
      {
        selectedModel: selection?.selectedModel ?? null,
        serviceTier: selection?.codexServiceTier === "fast" ? "priority" : null,
        ...(selectedModel &&
        selectedEffort !== undefined &&
        selectedEffort !== storedEffort
          ? {
              modelSettingsPatch: {
                model: selectedModel,
                effort: selectedEffort,
              },
            }
          : {}),
      },
      signal,
    );
    signal.throwIfAborted();
    set(reloadUserModelPreference$);
    await get(userModelPreference$);
    signal.throwIfAborted();
  },
);
