import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";

type ModelPickerCategory = "chat" | "image" | "video";

type ModelPickerMenuPage =
  | { readonly kind: "overview" }
  | { readonly kind: "models"; readonly category: ModelPickerCategory };

/** One compact navigation state per composer, including split chats. */
export function createModelPickerMenuSignals() {
  const internalPage$ = state<ModelPickerMenuPage>({ kind: "overview" });
  const page$ = computed((get) => {
    return get(internalPage$);
  });
  const reset$ = command(({ set }) => {
    set(internalPage$, { kind: "overview" });
  });
  const showModels$ = command(({ set }, category: ModelPickerCategory) => {
    set(internalPage$, { kind: "models", category });
  });

  // Anchor the flyout to the rail's card so every category shares its bottom
  // edge. Base UI owns collision positioning and focus for the nested menu.
  const internalFlyoutRoot$ = state<HTMLElement | null>(null);
  const flyoutRoot$ = computed((get) => {
    return get(internalFlyoutRoot$);
  });
  const flyoutRootRef$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      set(internalFlyoutRoot$, element);
      signal.addEventListener("abort", () => {
        set(internalFlyoutRoot$, null);
      });
    }),
  );

  return { page$, reset$, showModels$, flyoutRoot$, flyoutRootRef$ };
}

export type ModelPickerMenuSignals = ReturnType<
  typeof createModelPickerMenuSignals
>;
