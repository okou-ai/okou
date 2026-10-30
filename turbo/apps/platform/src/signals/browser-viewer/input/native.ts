import type { Protocol } from "devtools-protocol";
import { NativeComposition } from "./composition.ts";
import { NativeClipboard, type ClipboardRecovery } from "./clipboard.ts";

import type { InputTransition } from "./lifecycle.ts";
import { imagePoint, localPoint } from "./geometry.ts";
import type { Point } from "../display/geometry.ts";
import type { NativeInputPort } from "./port.ts";
import { InputIngress, type InputBinding } from "./ingress.ts";

const buttons = ["left", "middle", "right", "back", "forward"] as const;
const buttonMasks = [1, 4, 2, 8, 16] as const;
function modifiers(event: MouseEvent | KeyboardEvent): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

/** Keys an input method or dead-key sequence owns; the viewer never sends them. */
export function isCompositionKey(event: KeyboardEvent): boolean {
  return (
    event.isComposing ||
    event.keyCode === 229 ||
    ["Dead", "Process", "Unidentified"].includes(event.key)
  );
}

/** The key that releases focus from the page to the viewer's own controls. */
export const FOCUS_RELEASE_KEY = "F8";

/** DOM listeners belong to this surface only; the textarea stays uncontrolled. */
export class NativeInput {
  private readonly composition = new NativeComposition();
  private resetting = false;
  private readonly forwarded = new Set<string>();
  private readonly clipboardKeys = new Set<string>();
  private pointerId: number | null = null;
  private pointerInput: InputBinding | null = null;
  private readonly pressedButtons = new Set<number>();
  private readonly ingress: InputIngress;
  private readonly listenerCleanup: (() => void)[] = [];
  private readonly clipboard: NativeClipboard;

  constructor(
    private readonly surface: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly proxy: HTMLTextAreaElement,
    private readonly host: {
      readonly input: () => NativeInputPort | null;
      readonly releaseFocus: () => void;
      readonly clipboardChanged: (value: ClipboardRecovery | null) => void;
    },
    signal: AbortSignal,
  ) {
    const { input, clipboardChanged } = host;
    this.ingress = new InputIngress(
      input,
      (sample) => {
        return sample.type === "mouseMoved"
          ? imagePoint(canvas, sample.clientX, sample.clientY, sample.captured)
          : sample.point;
      },
      signal,
    );
    for (const type of ["copy", "paste", "cut"] as const) {
      this.listen(proxy, type, this.clipboardBoundary, {
        signal,
        capture: true,
      });
    }
    this.clipboard = new NativeClipboard(
      proxy,
      (event) => {
        return event ? this.ingress.boundary(event) : this.ingress.current();
      },
      () => {
        return this.composition.composing;
      },
      clipboardChanged,
      signal,
    );
    this.listen(surface, "pointerdown", this.pointerDown, { signal });
    this.listen(surface, "mousedown", this.mouseDown, { signal });
    this.listen(window, "mouseup", this.mouseUp, { signal });
    this.listen(surface, "pointermove", this.pointerMove, { signal });
    this.listen(surface, "pointerup", this.pointerUp, { signal });
    this.listen(surface, "pointercancel", this.cancel, { signal });
    this.listen(surface, "lostpointercapture", this.lostCapture, {
      signal,
    });
    this.listen(surface, "contextmenu", this.suppressSurfaceDefault, {
      signal,
    });
    this.listen(surface, "auxclick", this.suppressSurfaceDefault, {
      signal,
    });
    this.listen(surface, "wheel", this.wheel, { signal, passive: false });
    this.listen(
      proxy,
      "focus",
      () => {
        // A pointer gesture establishes remote focus after its release. Avoid
        // querying the previous control before that click has reached Chrome.
        if (this.pointerId === null) {
          this.ingress.boundary()?.focus();
        }
      },
      { signal },
    );
    this.listen(proxy, "blur", this.cancel, { signal });
    this.listen(proxy, "keydown", this.keyDown, { signal });
    this.listen(proxy, "keyup", this.keyUp, { signal });
    this.listen(
      proxy,
      "compositionstart",
      () => {
        const input = this.ingress.boundary();
        this.composition.start(
          document.activeElement === this.proxy ? (input?.owner ?? null) : null,
          this.proxy.value,
          this.proxy.selectionStart,
          this.proxy.selectionEnd,
        );
        // Leave the native value alone while an OS composition is starting.
      },
      { signal },
    );
    this.listen(proxy, "compositionupdate", this.compositionUpdate, {
      signal,
    });
    this.listen(proxy, "compositionend", this.compositionEnd, { signal });
    this.listen(proxy, "input", this.text, { signal });
    this.listen(proxy, "select", this.selection, { signal });
    this.listen(window, "blur", this.cancel, { signal });
  }

  reset(reason?: InputTransition): void {
    this.resetLocal(reason);
  }

  private resetLocal(reason?: InputTransition | "pointer-restarted"): void {
    if (this.resetting) {
      return;
    }
    this.resetting = true;
    {
      using _retirement1 = {
        [Symbol.dispose]: () => {
          this.resetting = false;
        },
      };

      this.clipboard.reset(reason === "blur");
      this.composition.reset();
      this.proxy.value = "";
      this.forwarded.clear();
      this.clipboardKeys.clear();
      this.ingress.reset();
      const pointer = this.pointerId;
      this.pointerId = null;
      this.pointerInput = null;
      this.pressedButtons.clear();
      if (pointer !== null && this.surface.hasPointerCapture(pointer)) {
        this.surface.releasePointerCapture(pointer);
      }
      // Same-tab cleanup invalidates old input without ending local focus.
      if (
        reason !== "navigation-started" &&
        reason !== "same-document" &&
        reason !== "document-lost" &&
        reason !== "failed" &&
        reason !== "pointer-restarted"
      ) {
        this.proxy.blur();
      }
    }
  }

  clearClipboard(): void {
    this.clipboard.reset();
  }

  copyClipboard(): void {
    this.clipboard.copyRecovery();
  }

  private listen<K extends keyof GlobalEventHandlersEventMap>(
    target: EventTarget,
    type: K,
    listener: (event: GlobalEventHandlersEventMap[K]) => void,
    options: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener as EventListener, options);
    this.listenerCleanup.push(() => {
      return target.removeEventListener(
        type,
        listener as EventListener,
        options,
      );
    });
  }

  dispose(): void {
    for (const cleanup of this.listenerCleanup.splice(0)) {
      cleanup();
    }
    this.ingress.dispose();
    this.reset();
  }

  place(point: Point): void {
    const local = localPoint(this.canvas, point);
    if (![local.x, local.y].every(Number.isFinite)) {
      return;
    }
    this.proxy.style.left = `${local.x}px`;
    this.proxy.style.top = `${Math.max(0, local.y - 20)}px`;
  }

  private readonly cancel = () => {
    if (this.resetting) {
      return;
    }
    this.ingress.blur();
    this.reset("blur");
  };

  private readonly lostCapture = () => {
    if (this.pointerId !== null) {
      this.cancel();
    }
  };

  private readonly suppressSurfaceDefault = (event: Event) => {
    event.preventDefault();
  };

  private readonly pointerDown = (event: PointerEvent) => {
    const point = imagePoint(this.canvas, event.clientX, event.clientY);
    if (!point || event.pointerType !== "mouse") {
      return;
    }
    const composing = this.composition.composing;
    const input = this.ingress.pointerBoundary({
      clientX: event.clientX,
      clientY: event.clientY,
      modifiers: modifiers(event),
      composing,
      heldButtons: this.pressedButtons.size,
    });
    if (!input) {
      return;
    }
    if (composing) {
      this.resetLocal("pointer-restarted");
    }
    if (!input.owner) {
      return;
    }
    // Preserve queued gestures, held modifiers and the consumed composition
    // boundary for another click in the same viewer. The ordered press follows
    // preceding committed input on the same CDP session.
    this.place(point);
    this.pointerId = event.pointerId;
    this.pointerInput = input;
    this.proxy.focus({ preventScroll: true });
    if (!input.owner) {
      return;
    }
    this.surface.setPointerCapture(event.pointerId);
  };

  private readonly mouseDown = (event: MouseEvent) => {
    if (this.pointerId === null) {
      return;
    }
    const point = imagePoint(this.canvas, event.clientX, event.clientY);
    if (!point) {
      return;
    }
    // PointerEvent.detail is zero. The compatibility mouse event supplies the
    // browser/OS click count, including native double/triple-click settings.
    event.preventDefault();
    const input = this.ingress.boundary(undefined, this.pointerInput);
    if (!input) {
      return;
    }
    this.pressedButtons.add(event.button);
    input.pointer("mousePressed", point, {
      button: buttons[event.button] ?? "left",
      buttons: this.ownedButtons(event.buttons),
      modifiers: modifiers(event),
      clickCount: event.detail,
    });
  };

  private readonly pointerMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") {
      return;
    }
    const held = this.ownedButtons(event.buttons);
    this.ingress.continuous(
      {
        type: "mouseMoved",
        clientX: event.clientX,
        clientY: event.clientY,
        captured: this.pointerId !== null,
        details: {
          button:
            held & 1
              ? "left"
              : held & 2
                ? "right"
                : held & 4
                  ? "middle"
                  : "none",
          buttons: held,
          modifiers: modifiers(event),
        },
      },
      this.pointerId === null ? this.ingress.current() : this.pointerInput,
    );
  };

  private readonly clipboardBoundary = (event: Event) => {
    if (this.ingress.boundary(event)) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly pointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) {
      return;
    }
    this.ingress.boundary(undefined, this.pointerInput);
    this.pointerId = null;
    if (this.surface.hasPointerCapture(event.pointerId)) {
      this.surface.releasePointerCapture(event.pointerId);
    }
  };

  private ownedButtons(physical: number): number {
    let owned = 0;
    for (const button of this.pressedButtons) {
      owned |= buttonMasks[button] ?? 0;
    }
    return physical & owned;
  }

  private readonly mouseUp = (event: MouseEvent) => {
    // Mouseup occurs for every released button, including a chord's non-final
    // button. The window listener also owns release outside the captured stage.
    if (!this.pressedButtons.has(event.button)) {
      return;
    }
    event.preventDefault();
    const input = this.ingress.boundary(undefined, this.pointerInput);
    if (!input) {
      return;
    }
    this.pressedButtons.delete(event.button);
    const point = imagePoint(this.canvas, event.clientX, event.clientY, true);
    if (point) {
      input.pointer("mouseReleased", point, {
        button: buttons[event.button] ?? "left",
        buttons: this.ownedButtons(event.buttons),
        modifiers: modifiers(event),
        clickCount: event.detail,
      });
    }
  };

  private readonly wheel = (event: WheelEvent) => {
    const point = imagePoint(this.canvas, event.clientX, event.clientY);
    if (!point || !this.ingress.current()) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const unit =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? this.canvas.clientHeight
          : 1;
    this.ingress.continuous({
      type: "mouseWheel",
      point,
      details: {
        buttons: this.ownedButtons(event.buttons),
        modifiers: modifiers(event),
        deltaX: event.deltaX * unit,
        deltaY: event.deltaY * unit,
      },
    });
  };

  private readonly compositionUpdate = (event: CompositionEvent) => {
    const input = this.ingress.boundary();
    const owner =
      document.activeElement === this.proxy ? (input?.owner ?? null) : null;
    const preedit = this.composition.update(event.data, owner);
    if (preedit && owner) {
      input?.preedit(
        preedit.text,
        owner,
        preedit.selectionStart,
        preedit.selectionEnd,
      );
    }
  };

  private readonly compositionEnd = (event: CompositionEvent) => {
    const input = this.ingress.boundary();
    const owner =
      document.activeElement === this.proxy ? (input?.owner ?? null) : null;
    const composed = this.composition.owns(owner);
    const result = this.composition.end(event.data, owner);
    this.proxy.value = result.value;
    if (owner) {
      this.proxy.setSelectionRange(result.value.length, result.value.length);
    }
    if (composed && owner) {
      input?.commitComposition(result.text, owner);
    }
  };

  private readonly text = (event: Event) => {
    const input = this.ingress.boundary();
    const owner =
      document.activeElement === this.proxy ? (input?.owner ?? null) : null;
    const result = this.composition.input(
      this.proxy.value,
      owner,
      event instanceof InputEvent &&
        (event.isComposing || event.inputType.includes("Composition")),
      event instanceof InputEvent && event.isComposing,
      { start: this.proxy.selectionStart, end: this.proxy.selectionEnd },
    );
    if (result.keep) {
      if (result.preedit && owner) {
        input?.preedit(
          result.preedit.text,
          owner,
          result.preedit.selectionStart,
          result.preedit.selectionEnd,
        );
      }
      return;
    }
    this.proxy.value = "";
    if (result.text && owner) {
      input?.text(result.text, owner);
    }
  };

  private readonly selection = (event: Event) => {
    if (this.composition.composing) {
      this.text(event);
    }
  };

  private readonly keyDown = (event: KeyboardEvent) => {
    if (this.composition.composing || isCompositionKey(event)) {
      return;
    }
    event.stopPropagation();
    if (event.key === FOCUS_RELEASE_KEY) {
      event.preventDefault();
      this.cancel();
      this.host.releaseFocus();
      return;
    }
    const input = this.ingress.boundary();
    if (!input) {
      event.preventDefault();
      return;
    }
    const shortcut =
      (event.ctrlKey || event.metaKey) && !event.getModifierState("AltGraph");
    if (shortcut && ["c", "v", "x"].includes(event.key.toLowerCase())) {
      this.clipboardKeys.add(event.code || event.key);
    }
    // Clipboard events carry local gesture activation and the actual paste data.
    // Let the browser generate them; do not also send a remote C/V chord.
    if (shortcut && ["c", "v"].includes(event.key.toLowerCase())) {
      return;
    }
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) {
      event.preventDefault();
    }
    if (shortcut && event.key.toLowerCase() === "x") {
      return;
    }
    const key = remoteKey(event, shortcut);
    this.forwarded.add(event.code || event.key);
    input.key(key);
  };

  private readonly keyUp = (event: KeyboardEvent) => {
    const id = event.code || event.key;
    const clipboard = this.clipboardKeys.delete(id);
    if (!this.forwarded.delete(id)) {
      if (clipboard) {
        event.stopPropagation();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.ingress.boundary()?.key({
      type: "keyUp",
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.keyCode,
      modifiers: modifiers(event),
    });
  };
}

function remoteKey(
  event: KeyboardEvent,
  shortcut: boolean,
): Protocol.Input.DispatchKeyEventRequest {
  const printable = Array.from(event.key).length === 1;
  const text =
    event.key === "Enter"
      ? "\r"
      : printable && !shortcut
        ? event.key
        : undefined;
  const key: Protocol.Input.DispatchKeyEventRequest = {
    type: text === undefined ? "rawKeyDown" : "keyDown",
    key: event.key,
    code: event.code,
    windowsVirtualKeyCode: event.keyCode,
    modifiers: modifiers(event),
    autoRepeat: event.repeat,
    ...(text === undefined ? {} : { text, unmodifiedText: text }),
  };
  if (shortcut) {
    const letter = event.key.toLowerCase();
    if (letter === "a") {
      key.commands = ["selectAll"];
    } else if (letter === "z") {
      key.commands = [event.shiftKey ? "redo" : "undo"];
    } else if (letter === "y") {
      key.commands = ["redo"];
    }
  }

  return key;
}
