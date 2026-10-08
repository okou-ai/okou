import { command, state, type Command } from "ccstate";
import { isMobileTextInputDevice } from "../../lib/visual-viewport-keyboard.ts";
import { onRef } from "../utils.ts";

export interface ComposerConnectorSearchFocusSignals {
  readonly panelRef$: Command<(() => void) | undefined, [HTMLElement | null]>;
  readonly inputRef$: Command<
    (() => void) | undefined,
    [HTMLInputElement | null]
  >;
  readonly initialFocus$: Command<HTMLElement | null, [string]>;
}

export function createComposerConnectorSearchFocusSignals(): ComposerConnectorSearchFocusSignals {
  const panel$ = state<HTMLElement | null>(null);
  const pendingFocus$ = state(false);

  const focusSearch$ = command(({ get, set }) => {
    const panel = get(panel$);
    if (
      !get(pendingFocus$) ||
      !panel ||
      panel.dataset.open === undefined ||
      panel.ownerDocument.activeElement !== panel ||
      isMobileTextInputDevice()
    ) {
      return;
    }
    const input = panel.querySelector<HTMLInputElement>(
      "[data-connector-search]",
    );
    if (input) {
      set(pendingFocus$, false);
      input.focus({ preventScroll: true });
    }
  });

  const panelRef$ = onRef(
    command(({ get, set }, panel: HTMLElement, signal: AbortSignal) => {
      set(panel$, panel);
      // Base UI focuses the panel on the next frame. The input may already
      // have mounted by then, or it may arrive later with the connector data.
      panel.addEventListener(
        "focus",
        () => {
          set(focusSearch$);
        },
        { signal },
      );
      signal.addEventListener("abort", () => {
        if (get(panel$) === panel) {
          set(panel$, null);
        }
      });
    }),
  );

  const inputRef$ = onRef(
    command(({ get, set }, input: HTMLInputElement, _signal: AbortSignal) => {
      if (get(panel$)?.contains(input)) {
        set(focusSearch$);
      }
    }),
  );

  const initialFocus$ = command(({ get, set }, interactionType: string) => {
    set(
      pendingFocus$,
      interactionType !== "touch" && !isMobileTextInputDevice(),
    );
    return get(panel$);
  });

  return { panelRef$, inputRef$, initialFocus$ };
}
