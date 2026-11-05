import { command, state, type Computed } from "ccstate";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorAccountTargetKey } from "@okouai/api-contracts/validators/connector-accounts";

import { onRef } from "../utils.ts";

/** Only the return-focus identity is remembered; the overview keeps its DOM. */
export function createChatConnectorMenuFocusSignals(
  target$: Computed<{ readonly target: ConnectorAccountTarget } | null>,
) {
  const returnKey$ = state<string | null>(null);
  const rememberTarget$ = command(({ set }, target: ConnectorAccountTarget) => {
    set(returnKey$, connectorAccountTargetKey(target));
  });
  const reset$ = command(({ set }) => {
    set(returnKey$, null);
  });
  const setViewport$ = onRef<HTMLElement>(
    command(({ get, set }, element: HTMLElement) => {
      if (get(target$)) {
        // Keep entry focus outside nested controls that can consume Escape.
        element.focus({ preventScroll: true });
      } else {
        const key = get(returnKey$);
        if (key !== null) {
          // A later data refresh must not replay this navigation handoff.
          set(returnKey$, null);
          const row = Array.from(
            element.querySelectorAll<HTMLButtonElement>(
              "button[data-connector-target]",
            ),
          ).find((button) => {
            return button.dataset.connectorTarget === key;
          });
          // The target can disappear while its account panel is open.
          (row ?? element).focus({ preventScroll: true });
        }
      }
    }),
  );
  return { rememberTarget$, reset$, setViewport$ };
}
