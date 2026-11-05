import { command, state, type Computed } from "ccstate";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorAccountTargetKey } from "@okouai/api-contracts/validators/connector-accounts";

import { onRef } from "../utils.ts";

interface OverviewPosition {
  readonly top: number;
  readonly returnKey: string | null;
}

/** One popup's overview snapshot, captured before changing its DOM geometry. */
export function createChatConnectorMenuScrollSignals(
  target$: Computed<{ readonly target: ConnectorAccountTarget } | null>,
) {
  const viewport$ = state<HTMLElement | null>(null);
  const overview$ = state<OverviewPosition>({ top: 0, returnKey: null });
  const captureOverview$ = command(
    ({ get, set }, target: ConnectorAccountTarget) => {
      const viewport = get(viewport$);
      if (!get(target$) && viewport) {
        set(overview$, {
          top: viewport.scrollTop,
          returnKey: connectorAccountTargetKey(target),
        });
      }
    },
  );
  const reset$ = command(({ get, set }) => {
    set(overview$, { top: 0, returnKey: null });
    const viewport = get(viewport$);
    if (viewport) {
      viewport.scrollTop = 0;
    }
  });
  const setViewport$ = onRef(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      set(viewport$, element);
      signal.addEventListener(
        "abort",
        () => {
          if (get(viewport$) === element) {
            set(viewport$, null);
          }
        },
        { once: true },
      );
      const target = get(target$);
      const position = get(overview$);
      element.scrollTop = target ? 0 : position.top;
      if (target) {
        // Keep entry focus outside nested controls that can consume Escape.
        element.focus({ preventScroll: true });
      } else if (position.returnKey !== null) {
        const row = Array.from(
          element.querySelectorAll<HTMLButtonElement>(
            "button[data-connector-target]",
          ),
        ).find((button) => {
          return button.dataset.connectorTarget === position.returnKey;
        });
        // The target can disappear while its account panel is open.
        (row ?? element).focus({ preventScroll: true });
      }
    }),
  );
  return { captureOverview$, reset$, setViewport$ };
}
