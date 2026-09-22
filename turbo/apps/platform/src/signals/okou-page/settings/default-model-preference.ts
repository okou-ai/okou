import { command, computed, state, type State } from "ccstate";

import { authenticatedSessionKey$ } from "../../auth.ts";
import type { ModelProviderSelection } from "../../../views/okou-page/components/model-provider-picker.tsx";
import {
  reloadUserModelPreference$,
  updateOwnedUserModelPreference$,
  userModelPreference$,
  userModelPreferenceOwner$,
} from "../../external/user-model-preference.ts";

interface DefaultModelPreferenceOperation {
  readonly key: string;
  readonly supersedesPending: boolean;
}

const pendingDefaultModelPreference$ = computed((get) => {
  get(authenticatedSessionKey$);
  return state<DefaultModelPreferenceOperation | null>(null);
});

const persistDefaultModelPreference$ = command(
  async (
    { get, set },
    selection: ModelProviderSelection | null,
    pending$: State<DefaultModelPreferenceOperation | null>,
    operation: DefaultModelPreferenceOperation,
    signal: AbortSignal,
  ): Promise<void> => {
    const [preference, assertCurrent] = await Promise.all([
      get(userModelPreference$),
      get(userModelPreferenceOwner$),
    ]);
    signal.throwIfAborted();
    assertCurrent();
    if (
      get(pendingDefaultModelPreference$) !== pending$ ||
      get(pending$) !== operation
    ) {
      return;
    }
    const selectedModel = selection?.selectedModel ?? null;
    const serviceTier =
      selection?.codexServiceTier === "fast" ? "priority" : null;
    const selectedEffort =
      selection?.modelSettings?.[selection.selectedModel]?.effort;
    const storedEffort = selectedModel
      ? preference.modelSettings[selectedModel]?.effort
      : undefined;
    const effortChanged =
      selectedEffort !== undefined && selectedEffort !== storedEffort;
    if (
      preference.selectedModel === selectedModel &&
      preference.serviceTier === serviceTier &&
      !effortChanged &&
      !operation.supersedesPending
    ) {
      return;
    }
    await set(
      updateOwnedUserModelPreference$,
      {
        selectedModel,
        serviceTier,
        ...(selectedModel && effortChanged
          ? {
              modelSettingsPatch: {
                model: selectedModel,
                effort: selectedEffort,
              },
            }
          : {}),
      },
      assertCurrent,
      signal,
    );
    signal.throwIfAborted();
    if (get(pendingDefaultModelPreference$) !== pending$) {
      return;
    }
    set(reloadUserModelPreference$);
    await get(userModelPreference$);
    signal.throwIfAborted();
  },
);

export const updateDefaultModelPreference$ = command(
  async (
    { get, set },
    selection: ModelProviderSelection | null,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const selectedModel = selection?.selectedModel ?? null;
    const selectedEffort =
      selection?.modelSettings?.[selection.selectedModel]?.effort;
    const key = JSON.stringify([
      selectedModel,
      selection?.codexServiceTier === "fast" ? "priority" : null,
      selectedEffort,
    ]);
    const pending$ = get(pendingDefaultModelPreference$);
    const pending = get(pending$);
    if (pending?.key === key) {
      return;
    }
    const operation = { key, supersedesPending: pending !== null };
    const clearPending = () => {
      if (get(pending$) === operation) {
        set(pending$, null);
      }
    };
    set(pending$, operation);
    signal.addEventListener("abort", clearPending, { once: true });
    await set(
      persistDefaultModelPreference$,
      selection,
      pending$,
      operation,
      signal,
    ).finally(() => {
      signal.removeEventListener("abort", clearPending);
      clearPending();
    });
    signal.throwIfAborted();
  },
);
