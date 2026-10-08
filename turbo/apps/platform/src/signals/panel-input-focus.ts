import { command, state, type Command } from "ccstate";
import { isMobileTextInputDevice } from "../lib/visual-viewport-keyboard.ts";
import { onRef } from "./utils.ts";

interface InputFocusSession {
  readonly panel: HTMLElement;
  pending: boolean;
  awaitingInitialFocus: boolean;
  focusTarget: Element | null;
  interactionType: string;
}

export interface PanelInputFocusSignals {
  readonly panelRef$: Command<(() => void) | undefined, [HTMLElement | null]>;
  readonly inputRef$: Command<
    (() => void) | undefined,
    [HTMLInputElement | null]
  >;
  readonly initialFocus$: Command<HTMLElement | boolean | null, [string]>;
}

function canFocusInput(session: InputFocusSession): boolean {
  return session.interactionType !== "touch" && !isMobileTextInputDevice();
}

function focusPendingInput(
  session: InputFocusSession,
  input: HTMLInputElement | null,
): void {
  if (
    !session.pending ||
    !canFocusInput(session) ||
    !input ||
    input.disabled ||
    !session.panel.contains(input) ||
    session.panel.dataset.open === undefined
  ) {
    return;
  }

  const document = session.panel.ownerDocument;
  const activeElement = document.activeElement;
  const previousTargetRemoved =
    session.focusTarget !== null && !session.focusTarget.isConnected;
  if (
    activeElement !== session.focusTarget &&
    activeElement !== session.panel &&
    !(previousTargetRemoved && activeElement === document.body)
  ) {
    return;
  }

  session.pending = false;
  input.focus({ preventScroll: true });
}

/** One input handoff per opening, owned by the popup DOM. */
export function createPanelInputFocusSignals(): PanelInputFocusSignals {
  const session$ = state<InputFocusSession | null>(null);
  const input$ = state<HTMLInputElement | null>(null);

  const panelRef$ = onRef(
    command(({ get, set }, panel: HTMLElement, signal: AbortSignal) => {
      const session: InputFocusSession = {
        panel,
        pending: false,
        awaitingInitialFocus: false,
        focusTarget: null,
        interactionType: "",
      };
      set(session$, session);

      const relinquishFocus = () => {
        session.pending = false;
      };
      const trackFocus = (event: FocusEvent) => {
        if (
          !session.pending ||
          !(event.target instanceof Element) ||
          event.target !== panel.ownerDocument.activeElement
        ) {
          return;
        }
        // Base UI may focus its first control on the next frame, after the
        // initialFocus callback. That fallback still belongs to this opening.
        if (session.awaitingInitialFocus && panel.contains(event.target)) {
          session.awaitingInitialFocus = false;
          session.focusTarget = event.target;
          focusPendingInput(session, get(input$));
        } else if (
          event.target === panel &&
          session.focusTarget !== null &&
          !session.focusTarget.isConnected
        ) {
          // Loading content can remove the fallback control. Base UI then
          // restores focus to the popup, which still owns the pending handoff.
          session.focusTarget = panel;
          focusPendingInput(session, get(input$));
        } else if (event.target !== session.focusTarget) {
          session.pending = false;
        }
      };
      const document = panel.ownerDocument;
      document.addEventListener("pointerdown", relinquishFocus, {
        capture: true,
        signal,
      });
      document.addEventListener("keydown", relinquishFocus, {
        capture: true,
        signal,
      });
      document.addEventListener("focusin", trackFocus, { signal });
      signal.addEventListener("abort", () => {
        if (get(session$) === session) {
          set(session$, null);
        }
      });
    }),
  );

  const inputRef$ = onRef(
    command(({ get, set }, input: HTMLInputElement, signal: AbortSignal) => {
      set(input$, input);
      const session = get(session$);
      if (session) {
        focusPendingInput(session, input);
      }
      signal.addEventListener("abort", () => {
        if (get(input$) === input) {
          set(input$, null);
        }
      });
    }),
  );

  const initialFocus$ = command(({ get }, interactionType: string) => {
    const session = get(session$);
    if (!session) {
      return true;
    }
    // A popup can reopen during its exit animation without remounting its ref.
    session.interactionType = interactionType;
    session.focusTarget = session.panel.ownerDocument.activeElement;
    session.awaitingInitialFocus = true;
    session.pending = canFocusInput(session);
    if (!session.pending) {
      return session.panel;
    }
    const input = get(input$);
    if (
      session.focusTarget !== session.panel &&
      session.panel.contains(session.focusTarget)
    ) {
      // Another control already owns focus. Base UI also preserves focus
      // placed inside the popup before its opening microtask runs.
      session.pending = false;
      return false;
    }
    if (input && !input.disabled && session.panel.contains(input)) {
      session.pending = false;
      return input;
    }
    return true;
  });

  return { panelRef$, inputRef$, initialFocus$ };
}
