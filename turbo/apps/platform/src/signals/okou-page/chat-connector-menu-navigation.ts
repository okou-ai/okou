import { command, state, type Command } from "ccstate";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorAccountTargetKey } from "@okouai/api-contracts/validators/connector-accounts";

import { onRef } from "../utils.ts";

/** Keep a focus destination when a connector disappears with its submenu open. */
export function createChatConnectorMenuNavigationSignals(
  closeTarget$: Command<void, []>,
) {
  const viewport$ = state<HTMLElement | null>(null);
  const setViewport$ = onRef<HTMLElement>(
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
    }),
  );
  const restoreFocus$ = command(
    ({ get, set }, target: ConnectorAccountTarget): false => {
      const viewport = get(viewport$);
      const row = Array.from(
        viewport?.querySelectorAll<HTMLButtonElement>(
          "button[data-connector-target]",
        ) ?? [],
      ).find((button) => {
        return (
          button.dataset.connectorTarget === connectorAccountTargetKey(target)
        );
      });
      const popupId = row?.getAttribute("aria-controls");
      const popup =
        row && popupId ? row.ownerDocument.getElementById(popupId) : null;
      // Base UI calls before a removed trigger leaves the DOM. Recheck after
      // removal and preserve any deliberate move to search or another control.
      queueMicrotask(() => {
        const currentViewport = get(viewport$);
        if (!currentViewport?.isConnected) {
          return;
        }
        if (!row?.isConnected) {
          set(closeTarget$);
        }
        const doc = currentViewport.ownerDocument;
        if (
          doc.activeElement !== doc.body &&
          !popup?.contains(doc.activeElement)
        ) {
          return;
        }
        (row?.isConnected ? row : currentViewport).focus({
          preventScroll: true,
        });
      });
      return false;
    },
  );
  return { setViewport$, restoreFocus$ };
}
