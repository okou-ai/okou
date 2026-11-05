import { command, state, type Computed } from "ccstate";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorAccountTargetKey } from "@okouai/api-contracts/validators/connector-accounts";

import { onRef } from "../utils.ts";

/** One popup's scroll snapshot and command-owned, one-shot focus handoff. */
export function createChatConnectorMenuNavigationSignals(
  target$: Computed<{ readonly target: ConnectorAccountTarget } | null>,
) {
  const viewport$ = state<HTMLElement | null>(null);
  const overview$ = state<{
    readonly top: number;
    readonly key: string;
  } | null>(null);
  const handoff$ = state<"detail" | "overview" | null>(null);
  const selectFocus$ = state<{
    readonly key: string;
    readonly popup: HTMLElement;
    readonly trigger: HTMLButtonElement;
  } | null>(null);
  const enter$ = command(({ get, set }, target: ConnectorAccountTarget) => {
    const viewport = get(viewport$);
    if (!viewport) {
      throw new Error("Connector overview viewport is not mounted");
    }
    set(overview$, {
      top: viewport.scrollTop,
      key: connectorAccountTargetKey(target),
    });
    set(handoff$, "detail");
  });
  const back$ = command(({ get, set }) => {
    set(handoff$, get(overview$) ? "overview" : null);
  });
  const reset$ = command(({ set }) => {
    set(overview$, null);
    set(handoff$, null);
    set(selectFocus$, null);
  });
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
      const view = get(target$) ? "detail" : "overview";
      if (get(handoff$) !== view) {
        return;
      }
      // Data-driven remounts must not replay a completed navigation action.
      set(handoff$, null);
      const position = view === "overview" ? get(overview$) : null;
      if (view === "overview") {
        set(overview$, null);
      }
      element.scrollTop = position?.top ?? 0;
      const row = position
        ? Array.from(
            element.querySelectorAll<HTMLButtonElement>(
              "button[data-connector-target]",
            ),
          ).find((button) => {
            return button.dataset.connectorTarget === position.key;
          })
        : undefined;
      // Entry stays outside nested controls; a removed return row uses the viewport.
      (row ?? element).focus({ preventScroll: true });
    }),
  );
  const rememberSelectFocus$ = command(
    ({ get, set }, key: string, popup: HTMLElement) => {
      if (get(selectFocus$)?.popup === popup) {
        return;
      }
      const list = popup.querySelector<HTMLElement>('[role="listbox"]');
      const trigger = Array.from(
        get(viewport$)?.querySelectorAll<HTMLButtonElement>(
          '[role="combobox"]',
        ) ?? [],
      ).find((element) => {
        return element.getAttribute("aria-controls") === list?.id;
      });
      if (!trigger) {
        throw new Error("Account Select trigger is not mounted");
      }
      set(selectFocus$, { key, popup, trigger });
    },
  );
  const restoreSelectFocus$ = command(({ get, set }, key: string): false => {
    const focus = get(selectFocus$);
    if (focus?.key === key) {
      set(selectFocus$, null);
      const viewport = get(viewport$);
      // Base UI asks before DOM removal/native pointer focus has finished.
      // Recheck afterward so an outside press keeps its deliberate destination.
      queueMicrotask(() => {
        const doc = focus.popup.ownerDocument;
        if (
          doc.activeElement !== doc.body &&
          !focus.popup.contains(doc.activeElement)
        ) {
          return;
        }
        const destination = focus.trigger.isConnected
          ? focus.trigger
          : viewport;
        if (destination?.isConnected) {
          destination.focus({ preventScroll: true });
        }
      });
    }
    // The explicit handoff also covers simultaneous trigger/portal removal.
    return false;
  });
  return {
    enter$,
    back$,
    reset$,
    setViewport$,
    rememberSelectFocus$,
    restoreSelectFocus$,
  };
}
