import { command, computed, state, type Command, type Computed } from "ccstate";
import type { Protocol } from "devtools-protocol";
import { resetSignal } from "../../utils.ts";
import { createNativeComposition } from "./composition.ts";
import { createNativeClipboard, type ClipboardRecovery } from "./clipboard.ts";
import type { InputOwner, InputTransition } from "./lifecycle.ts";
import { imagePoint, localPoint } from "./geometry.ts";
import type { Point } from "../display/geometry.ts";
import type { NativeInputHost, NativeInputPort } from "./port.ts";
import { createInputIngress, type InputBinding } from "./ingress.ts";
import { createTouchInput } from "./touch.ts";

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
interface NativeElements {
  readonly surface: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly proxy: HTMLTextAreaElement;
}
interface Admission {
  readonly input: NativeInputPort | null;
  readonly transition: {
    readonly id: number;
    readonly reason: InputTransition;
  } | null;
  readonly owner: InputOwner | null;
}
export interface NativeInput extends NativeInputHost {
  readonly bind$: Command<
    void,
    [
      surface: HTMLElement,
      canvas: HTMLCanvasElement,
      proxy: HTMLTextAreaElement,
      signal: AbortSignal,
    ]
  >;
  readonly reset$: Command<void, [reason?: InputTransition]>;
  readonly place$: Command<void, [point: Point]>;
  readonly dispose$: Command<void, []>;
  readonly copyClipboard$: Command<Promise<void>, [signal: AbortSignal]>;
  readonly recovery$: Computed<ClipboardRecovery | null>;
  readonly dismissClipboard$: Command<void, []>;
}

function createNativeState(
  input$: Computed<NativeInputPort | null>,
  releaseFocus$: Command<void, []>,
) {
  const elements$ = state<NativeElements | null>(null);
  const canvas$ = computed((get) => {
    return get(elements$)?.canvas ?? null;
  });
  const proxy$ = computed((get) => {
    return get(elements$)?.proxy ?? null;
  });
  const resetBinding$ = resetSignal();
  const bindingIdentity$ = state<object | null>(null);
  const resetting$ = state(false);
  const forwarded$ = state<ReadonlySet<string>>(new Set());
  const clipboardKeys$ = state<ReadonlySet<string>>(new Set());
  const pointerId$ = state<number | null>(null);
  const pointerInput$ = state<InputBinding | null>(null);
  const pressedButtons$ = state<ReadonlySet<number>>(new Set());
  const admission$ = state<Admission | null>(null);
  const composition = createNativeComposition();
  const ingress = createInputIngress(input$, canvas$);
  const clipboard = createNativeClipboard(
    proxy$,
    input$,
    ingress,
    composition.composing$,
  );

  return {
    input$,
    releaseFocus$,
    elements$,
    canvas$,
    proxy$,
    resetBinding$,
    bindingIdentity$,
    resetting$,
    forwarded$,
    clipboardKeys$,
    pointerId$,
    pointerInput$,
    pressedButtons$,
    admission$,
    composition,
    ingress,
    touch: createTouchInput(elements$, ingress),
    clipboard,
  };
}
type NativeBase = ReturnType<typeof createNativeState>;
type NativeGraph = NativeBase &
  ReturnType<typeof createNativeReset> &
  ReturnType<typeof createNativeCoordination> &
  ReturnType<typeof createNativeButtons>;
type NativeHandlers = NativeGraph &
  ReturnType<typeof createNativePress> &
  ReturnType<typeof createNativeMousePress> &
  ReturnType<typeof createNativeMovement> &
  ReturnType<typeof createNativeRelease> &
  ReturnType<typeof createNativeFocus> &
  ReturnType<typeof createNativeCompositionEvents> &
  ReturnType<typeof createNativeTextEvents> &
  ReturnType<typeof createNativeKeyDown> &
  ReturnType<typeof createNativeKeyUp>;

function createNativeReset(graph: NativeBase) {
  const {
    admission$,
    clipboard,
    clipboardKeys$,
    composition,
    elements$,
    forwarded$,
    ingress,
    input$,
    pointerId$,
    pointerInput$,
    pressedButtons$,
    resetting$,
    touch,
  } = graph;
  const acknowledge$ = command(({ get, set }) => {
    const input = get(input$);
    set(admission$, {
      input,
      transition: input ? get(input.transition$) : null,
      owner: input ? get(input.owner$) : null,
    });
  });
  const resetLocal$ = command(
    ({ get, set }, reason?: InputTransition | "pointer-restarted") => {
      if (get(resetting$)) {
        return;
      }
      set(resetting$, true);
      using _reset = {
        [Symbol.dispose]: () => {
          set(resetting$, false);
        },
      };
      set(clipboard.reset$, reason === "blur");
      set(composition.reset$);
      set(touch.reset$);
      const elements = get(elements$);
      if (elements) {
        elements.proxy.value = "";
      }
      set(forwarded$, new Set<string>());
      set(clipboardKeys$, new Set<string>());
      set(ingress.reset$);
      const pointer = get(pointerId$);
      set(pointerId$, null);
      set(pointerInput$, null);
      set(pressedButtons$, new Set<number>());
      if (
        elements &&
        pointer !== null &&
        elements.surface.hasPointerCapture(pointer)
      ) {
        elements.surface.releasePointerCapture(pointer);
      }
      // Same-tab cleanup invalidates old input without ending local focus.
      if (
        elements &&
        reason !== "navigation-started" &&
        reason !== "same-document" &&
        reason !== "document-lost" &&
        reason !== "failed" &&
        reason !== "pointer-restarted"
      ) {
        elements.proxy.blur();
      }
    },
  );
  const reset$ = command(({ set }, reason?: InputTransition) => {
    set(acknowledge$);
    set(resetLocal$, reason);
  });
  return { acknowledge$, resetLocal$, reset$ };
}

function createNativeCoordination(
  graph: NativeBase & ReturnType<typeof createNativeReset>,
) {
  const {
    admission$,
    clipboard,
    elements$,
    ingress,
    input$,
    pointerId$,
    reset$,
    resetLocal$,
    resetting$,
    touch,
  } = graph;
  const place$ = command(({ get }, point: Point) => {
    const elements = get(elements$);
    if (!elements) {
      return;
    }
    const local = localPoint(elements.canvas, point);
    if (![local.x, local.y].every(Number.isFinite)) {
      return;
    }
    elements.proxy.style.left = `${local.x}px`;
    elements.proxy.style.top = `${Math.max(0, local.y - 20)}px`;
  });
  const synchronize$ = command(({ get, set }) => {
    const previous = get(admission$);
    const input = get(input$);
    const transition = input ? get(input.transition$) : null;
    const owner = input ? get(input.owner$) : null;
    // Publish the fence before any release/blur listener can reenter.
    set(admission$, { input, transition, owner });
    set(clipboard.synchronize$);
    if (previous) {
      if (previous.input !== input) {
        set(resetLocal$, "target-replaced");
      } else if (previous.transition !== transition) {
        set(resetLocal$, transition?.reason);
      } else if (previous.owner && owner && previous.owner !== owner) {
        set(resetLocal$, "blur");
      }
    }
    // Admission gating is not a focus transition. In particular, reopening a
    // navigation gate must not synthesize blur or discard local proxy focus.
    const current = get(input$);
    const caret = current ? get(current.caret$) : null;
    if (caret) {
      set(place$, caret);
    }
  });
  const cancel$ = command(({ get, set }) => {
    if (get(resetting$)) {
      return;
    }
    set(ingress.blur$);
    set(reset$, "blur");
  });
  const lostCapture$ = command(({ get, set }, event: PointerEvent) => {
    if (get(pointerId$) !== null || set(touch.owns$, event.pointerId)) {
      set(cancel$);
    }
  });
  return { synchronize$, place$, cancel$, lostCapture$ };
}

function createNativeButtons(graph: NativeBase) {
  const { pressedButtons$ } = graph;
  const ownedButtons$ = command(({ get }, physical: number): number => {
    let owned = 0;
    for (const button of get(pressedButtons$)) {
      owned |= buttonMasks[button] ?? 0;
    }
    return physical & owned;
  });
  return { ownedButtons$ };
}

function createNativePress(graph: NativeGraph) {
  const {
    acknowledge$,
    composition,
    elements$,
    ingress,
    place$,
    pointerId$,
    pointerInput$,
    pressedButtons$,
    resetLocal$,
    synchronize$,
    touch,
  } = graph;
  const pointerDown$ = command(({ get, set }, event: PointerEvent) => {
    set(synchronize$);
    const elements = get(elements$);
    if (!elements) {
      return;
    }
    if (event.pointerType === "touch" && !event.isPrimary) {
      set(touch.reset$);
      set(ingress.reset$);
      return;
    }
    if (
      get(touch.active$) ||
      (event.pointerType === "touch" && get(pointerId$) !== null)
    ) {
      return;
    }
    const point = imagePoint(elements.canvas, event.clientX, event.clientY);
    if (!point || !["mouse", "touch"].includes(event.pointerType)) {
      return;
    }
    const composing = get(composition.composing$);
    const input = set(ingress.pointerBoundary$, {
      clientX: event.clientX,
      clientY: event.clientY,
      modifiers: modifiers(event),
      composing,
      heldButtons: get(pressedButtons$).size,
    });
    if (!input) {
      return;
    }
    if (composing) {
      set(acknowledge$);
      set(resetLocal$, "pointer-restarted");
    }
    if (!get(input.owner$)) {
      return;
    }
    if (event.pointerType === "touch") {
      set(touch.press$, event, point, input);
      return;
    }
    // Preserve queued gestures, held modifiers and consumed composition for
    // another click in the same viewer. Ordered presses follow committed input.
    set(place$, point);
    set(pointerId$, event.pointerId);
    set(pointerInput$, input);
    elements.proxy.focus({ preventScroll: true });
    if (get(input.owner$)) {
      elements.surface.setPointerCapture(event.pointerId);
    }
  });
  return { pointerDown$ };
}

function createNativeMousePress(graph: NativeGraph) {
  const {
    elements$,
    ingress,
    ownedButtons$,
    pointerId$,
    pointerInput$,
    pressedButtons$,
    synchronize$,
  } = graph;
  const mouseDown$ = command(({ get, set }, event: MouseEvent) => {
    set(synchronize$);
    const elements = get(elements$);
    if (!elements || get(pointerId$) === null) {
      return;
    }
    const point = imagePoint(elements.canvas, event.clientX, event.clientY);
    if (!point) {
      return;
    }
    // Compatibility mouse events carry the browser/OS double/triple-click count.
    event.preventDefault();
    const input = set(ingress.boundary$, undefined, get(pointerInput$));
    if (!input) {
      return;
    }
    set(pressedButtons$, new Set([...get(pressedButtons$), event.button]));
    set(input.pointer$, "mousePressed", point, {
      button: buttons[event.button] ?? "left",
      buttons: set(ownedButtons$, event.buttons),
      modifiers: modifiers(event),
      clickCount: event.detail,
    });
  });
  return { mouseDown$ };
}

function createNativeMovement(graph: NativeGraph) {
  const {
    elements$,
    ingress,
    ownedButtons$,
    pointerId$,
    pointerInput$,
    synchronize$,
    touch,
  } = graph;
  const pointerMove$ = command(
    ({ get, set }, event: PointerEvent, signal: AbortSignal) => {
      set(synchronize$);
      if (event.pointerType === "touch") {
        set(touch.move$, event, modifiers(event), signal);
        return;
      }
      if (event.pointerType !== "mouse") {
        return;
      }
      const held = set(ownedButtons$, event.buttons);
      set(
        ingress.continuous$,
        {
          type: "mouseMoved",
          clientX: event.clientX,
          clientY: event.clientY,
          captured: get(pointerId$) !== null,
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
        get(pointerId$) === null ? set(ingress.current$) : get(pointerInput$),
        signal,
      );
    },
  );
  const wheel$ = command(
    ({ get, set }, event: WheelEvent, signal: AbortSignal) => {
      set(synchronize$);
      const elements = get(elements$);
      if (!elements) {
        return;
      }
      const point = imagePoint(elements.canvas, event.clientX, event.clientY);
      if (!point || !set(ingress.current$)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? elements.canvas.clientHeight
            : 1;
      set(
        ingress.continuous$,
        {
          type: "mouseWheel",
          point,
          details: {
            buttons: set(ownedButtons$, event.buttons),
            modifiers: modifiers(event),
            deltaX: event.deltaX * unit,
            deltaY: event.deltaY * unit,
          },
        },
        undefined,
        signal,
      );
    },
  );
  return { pointerMove$, wheel$ };
}

function createNativeRelease(graph: NativeGraph) {
  const {
    elements$,
    ingress,
    ownedButtons$,
    pointerId$,
    pointerInput$,
    pressedButtons$,
    synchronize$,
    place$,
    touch,
  } = graph;
  const pointerUp$ = command(
    ({ get, set }, event: PointerEvent, signal: AbortSignal) => {
      set(synchronize$);
      const elements = get(elements$);
      if (event.pointerType === "touch") {
        const tap = set(touch.release$, event, modifiers(event), signal);
        if (elements && tap) {
          set(place$, tap.point);
          set(tap.input.pointer$, "mousePressed", tap.point, {
            button: "left",
            buttons: 1,
            modifiers: modifiers(event),
            clickCount: 1,
          });
          set(tap.input.pointer$, "mouseReleased", tap.point, {
            button: "left",
            buttons: 0,
            modifiers: modifiers(event),
            clickCount: 1,
          });
          // Keep taps' text-entry handoff in the trusted gesture; swipes never focus.
          elements.proxy.focus({ preventScroll: true });
        }
        return;
      }
      if (!elements || event.pointerId !== get(pointerId$)) {
        return;
      }
      set(ingress.boundary$, undefined, get(pointerInput$));
      set(pointerId$, null);
      if (elements.surface.hasPointerCapture(event.pointerId)) {
        elements.surface.releasePointerCapture(event.pointerId);
      }
    },
  );
  const mouseUp$ = command(({ get, set }, event: MouseEvent) => {
    set(synchronize$);
    const elements = get(elements$);
    // Every released button, including non-final chord buttons and outside releases.
    if (!elements || !get(pressedButtons$).has(event.button)) {
      return;
    }
    event.preventDefault();
    const input = set(ingress.boundary$, undefined, get(pointerInput$));
    if (!input) {
      return;
    }
    const remaining = new Set(get(pressedButtons$));
    remaining.delete(event.button);
    set(pressedButtons$, remaining);
    const point = imagePoint(
      elements.canvas,
      event.clientX,
      event.clientY,
      true,
    );
    if (point) {
      set(input.pointer$, "mouseReleased", point, {
        button: buttons[event.button] ?? "left",
        buttons: set(ownedButtons$, event.buttons),
        modifiers: modifiers(event),
        clickCount: event.detail,
      });
    }
  });
  return { pointerUp$, mouseUp$ };
}

function createNativeFocus(graph: NativeGraph) {
  const { ingress, pointerId$, synchronize$ } = graph;
  const clipboardBoundary$ = command(({ set }, event: Event) => {
    set(synchronize$);
    if (set(ingress.boundary$, event)) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  });
  const focus$ = command(({ get, set }) => {
    set(synchronize$);
    // Pointer release establishes remote focus; don't query the previous control.
    if (get(pointerId$) === null) {
      const input = set(ingress.boundary$);
      if (input) {
        set(input.focus$);
      }
    }
  });
  return { clipboardBoundary$, focus$ };
}

function createNativeCompositionEvents(graph: NativeGraph) {
  const { composition, ingress, proxy$, synchronize$ } = graph;
  const compositionStart$ = command(({ get, set }) => {
    set(synchronize$);
    const proxy = get(proxy$);
    if (!proxy) {
      return;
    }
    const input = set(ingress.boundary$);
    set(
      composition.start$,
      document.activeElement === proxy && input ? get(input.owner$) : null,
      proxy.value,
      proxy.selectionStart,
      proxy.selectionEnd,
    );
    // Leave the native value alone while OS composition is starting.
  });
  const compositionUpdate$ = command(
    ({ get, set }, event: CompositionEvent) => {
      set(synchronize$);
      const proxy = get(proxy$);
      const input = set(ingress.boundary$);
      const owner =
        proxy && document.activeElement === proxy && input
          ? get(input.owner$)
          : null;
      const preedit = set(composition.update$, event.data, owner);
      if (input && preedit && owner) {
        set(
          input.preedit$,
          preedit.text,
          owner,
          preedit.selectionStart,
          preedit.selectionEnd,
        );
      }
    },
  );
  const compositionEnd$ = command(({ get, set }, event: CompositionEvent) => {
    set(synchronize$);
    const proxy = get(proxy$);
    if (!proxy) {
      return;
    }
    const input = set(ingress.boundary$);
    const owner =
      document.activeElement === proxy && input ? get(input.owner$) : null;
    const composed = set(composition.owns$, owner);
    const result = set(composition.end$, event.data, owner);
    proxy.value = result.value;
    if (owner) {
      proxy.setSelectionRange(result.value.length, result.value.length);
    }
    if (input && composed && owner) {
      set(input.commitComposition$, result.text, owner);
    }
  });
  return { compositionStart$, compositionUpdate$, compositionEnd$ };
}

function createNativeTextEvents(graph: NativeGraph) {
  const { composition, forwarded$, ingress, proxy$, synchronize$ } = graph;
  const beforeInput$ = command(({ get, set }, event: InputEvent) => {
    set(synchronize$);
    if (
      event.inputType !== "deleteContentBackward" ||
      event.isComposing ||
      get(composition.composing$)
    ) {
      return;
    }
    const proxy = get(proxy$);
    if (!proxy || document.activeElement !== proxy) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const input = set(ingress.boundary$, event);
    // Committed composition text may still await its trailing input event.
    set(composition.reset$);
    proxy.value = "";
    if (!input || get(forwarded$).has("Backspace")) {
      return;
    }
    for (const type of ["rawKeyDown", "keyUp"] as const) {
      set(input.key$, {
        type,
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        modifiers: 0,
      });
    }
  });
  const text$ = command(({ get, set }, event: Event) => {
    set(synchronize$);
    const proxy = get(proxy$);
    if (!proxy) {
      return;
    }
    const input = set(ingress.boundary$);
    const owner =
      document.activeElement === proxy && input ? get(input.owner$) : null;
    const result = set(
      composition.input$,
      proxy.value,
      owner,
      event instanceof InputEvent &&
        (event.isComposing || event.inputType.includes("Composition")),
      event instanceof InputEvent && event.isComposing,
      { start: proxy.selectionStart, end: proxy.selectionEnd },
    );
    if (result.keep) {
      if (input && result.preedit && owner) {
        set(
          input.preedit$,
          result.preedit.text,
          owner,
          result.preedit.selectionStart,
          result.preedit.selectionEnd,
        );
      }
      return;
    }
    proxy.value = "";
    if (input && result.text && owner) {
      set(input.text$, result.text, owner);
    }
  });
  const selection$ = command(({ get, set }, event: Event) => {
    set(synchronize$);
    if (get(composition.composing$)) {
      set(text$, event);
    }
  });
  return { beforeInput$, text$, selection$ };
}

function createNativeKeyDown(graph: NativeGraph) {
  const {
    cancel$,
    clipboardKeys$,
    composition,
    forwarded$,
    ingress,
    releaseFocus$,
    synchronize$,
  } = graph;
  const keyDown$ = command(({ get, set }, event: KeyboardEvent) => {
    set(synchronize$);
    if (
      get(composition.composing$) ||
      event.isComposing ||
      event.keyCode === 229 ||
      ["Dead", "Process", "Unidentified"].includes(event.key)
    ) {
      return;
    }
    event.stopPropagation();
    if (event.key === "F8") {
      event.preventDefault();
      set(cancel$);
      set(releaseFocus$);
      return;
    }
    const input = set(ingress.boundary$);
    if (!input) {
      event.preventDefault();
      return;
    }
    const shortcut =
      (event.ctrlKey || event.metaKey) && !event.getModifierState("AltGraph");
    if (shortcut && ["c", "v", "x"].includes(event.key.toLowerCase())) {
      set(
        clipboardKeys$,
        new Set([...get(clipboardKeys$), event.code || event.key]),
      );
    }
    // Actual clipboard events own activation and paste data; no remote C/V chord.
    if (shortcut && ["c", "v"].includes(event.key.toLowerCase())) {
      return;
    }
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) {
      event.preventDefault();
    }
    if (shortcut && event.key.toLowerCase() === "x") {
      return;
    }
    set(forwarded$, new Set([...get(forwarded$), event.code || event.key]));
    set(input.key$, remoteKey(event, shortcut));
  });
  return { keyDown$ };
}

function createNativeKeyUp(graph: NativeGraph) {
  const { clipboardKeys$, forwarded$, ingress, synchronize$ } = graph;
  const keyUp$ = command(({ get, set }, event: KeyboardEvent) => {
    set(synchronize$);
    const id = event.code || event.key;
    const clipboardKeys = new Set(get(clipboardKeys$));
    const clipboardKey = clipboardKeys.delete(id);
    set(clipboardKeys$, clipboardKeys);
    const forwarded = new Set(get(forwarded$));
    const sent = forwarded.delete(id);
    set(forwarded$, forwarded);
    if (!sent) {
      if (clipboardKey) {
        event.stopPropagation();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const input = set(ingress.boundary$);
    if (input) {
      set(input.key$, {
        type: "keyUp",
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: event.keyCode,
        modifiers: modifiers(event),
      });
    }
  });
  return { keyUp$ };
}

function createNativeClipboardBindings(graph: NativeHandlers) {
  const { clipboard, clipboardBoundary$ } = graph;
  const bindClipboardDom$ = command(
    ({ set }, elements: NativeElements, owner: AbortSignal) => {
      const { proxy } = elements;
      // Capture-phase admission fixes the clipboard Event to its original owner.
      for (const type of ["copy", "paste", "cut"] as const) {
        proxy.addEventListener(
          type,
          (event) => {
            set(clipboardBoundary$, event);
          },
          { signal: owner, capture: true },
        );
      }
      proxy.addEventListener(
        "copy",
        (event) => {
          set(clipboard.copy$, event, owner);
        },
        { signal: owner },
      );
      proxy.addEventListener(
        "paste",
        (event) => {
          set(clipboard.paste$, event);
        },
        { signal: owner },
      );
      proxy.addEventListener(
        "cut",
        (event) => {
          event.preventDefault();
          event.stopPropagation();
        },
        { signal: owner },
      );
    },
  );
  return { bindClipboardDom$ };
}

function createNativePointerBindings(graph: NativeHandlers) {
  const {
    cancel$,
    lostCapture$,
    mouseDown$,
    mouseUp$,
    pointerDown$,
    pointerMove$,
    pointerUp$,
    wheel$,
  } = graph;
  const bindPointerDom$ = command(
    ({ set }, elements: NativeElements, owner: AbortSignal) => {
      const { surface } = elements;
      surface.addEventListener(
        "pointerdown",
        (event) => {
          set(pointerDown$, event);
        },
        { signal: owner },
      );
      surface.addEventListener(
        "mousedown",
        (event) => {
          set(mouseDown$, event);
        },
        { signal: owner },
      );
      window.addEventListener(
        "mouseup",
        (event) => {
          set(mouseUp$, event);
        },
        { signal: owner },
      );
      surface.addEventListener(
        "pointermove",
        (event) => {
          set(pointerMove$, event, owner);
        },
        { signal: owner },
      );
      surface.addEventListener(
        "pointerup",
        (event) => {
          set(pointerUp$, event, owner);
        },
        { signal: owner },
      );
      surface.addEventListener(
        "pointercancel",
        () => {
          set(cancel$);
        },
        { signal: owner },
      );
      surface.addEventListener(
        "lostpointercapture",
        (event) => {
          set(lostCapture$, event);
        },
        { signal: owner },
      );
      surface.addEventListener(
        "contextmenu",
        (event) => {
          event.preventDefault();
        },
        { signal: owner },
      );
      surface.addEventListener(
        "auxclick",
        (event) => {
          event.preventDefault();
        },
        { signal: owner },
      );
      surface.addEventListener(
        "wheel",
        (event) => {
          set(wheel$, event, owner);
        },
        { signal: owner, passive: false },
      );
    },
  );
  return { bindPointerDom$ };
}

function createNativeTextBindings(graph: NativeHandlers) {
  const {
    beforeInput$,
    cancel$,
    compositionEnd$,
    compositionStart$,
    compositionUpdate$,
    focus$,
    keyDown$,
    keyUp$,
    selection$,
    text$,
  } = graph;
  const bindTextDom$ = command(
    ({ set }, elements: NativeElements, owner: AbortSignal) => {
      const { proxy } = elements;
      proxy.addEventListener(
        "focus",
        () => {
          set(focus$);
        },
        { signal: owner },
      );
      proxy.addEventListener(
        "blur",
        () => {
          set(cancel$);
        },
        { signal: owner },
      );
      proxy.addEventListener(
        "keydown",
        (event) => {
          set(keyDown$, event);
        },
        { signal: owner },
      );
      proxy.addEventListener(
        "keyup",
        (event) => {
          set(keyUp$, event);
        },
        { signal: owner },
      );
      proxy.addEventListener(
        "compositionstart",
        () => {
          set(compositionStart$);
        },
        { signal: owner },
      );
      proxy.addEventListener(
        "compositionupdate",
        (event) => {
          set(compositionUpdate$, event);
        },
        { signal: owner },
      );
      proxy.addEventListener(
        "compositionend",
        (event) => {
          set(compositionEnd$, event);
        },
        { signal: owner },
      );
      proxy.addEventListener(
        "beforeinput",
        (event) => {
          set(beforeInput$, event);
        },
        { signal: owner },
      );
      proxy.addEventListener(
        "input",
        (event) => {
          set(text$, event);
        },
        { signal: owner },
      );
      proxy.addEventListener(
        "select",
        (event) => {
          set(selection$, event);
        },
        { signal: owner },
      );
      window.addEventListener(
        "blur",
        () => {
          set(cancel$);
        },
        { signal: owner },
      );
    },
  );
  return { bindTextDom$ };
}

function createNativeLifetime(
  graph: NativeHandlers &
    ReturnType<typeof createNativeClipboardBindings> &
    ReturnType<typeof createNativePointerBindings> &
    ReturnType<typeof createNativeTextBindings>,
) {
  const {
    acknowledge$,
    admission$,
    bindClipboardDom$,
    bindPointerDom$,
    bindTextDom$,
    bindingIdentity$,
    clipboard,
    elements$,
    ingress,
    resetBinding$,
    resetLocal$,
  } = graph;
  const dispose$ = command(({ set }) => {
    set(resetBinding$);
    set(bindingIdentity$, null);
    set(ingress.dispose$);
    set(resetLocal$);
    set(elements$, null);
    set(admission$, null);
  });
  const bindingAborted$ = command(({ get, set }, identity: object) => {
    if (get(bindingIdentity$) !== identity) {
      return;
    }
    set(bindingIdentity$, null);
    set(ingress.dispose$);
    set(resetLocal$);
    set(elements$, null);
    set(admission$, null);
  });
  const bind$ = command(
    (
      { get, set },
      surface: HTMLElement,
      canvas: HTMLCanvasElement,
      proxy: HTMLTextAreaElement,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      set(dispose$);
      const owner = set(resetBinding$, signal);
      const identity = Object.freeze({});
      set(elements$, { surface, canvas, proxy });
      set(bindingIdentity$, identity);
      set(ingress.bind$, owner);
      set(clipboard.bind$, owner);
      set(acknowledge$);
      owner.addEventListener(
        "abort",
        () => {
          set(bindingAborted$, identity);
        },
        { once: true },
      );
      set(bindClipboardDom$, { surface, canvas, proxy }, owner);
      set(bindPointerDom$, { surface, canvas, proxy }, owner);
      set(bindTextDom$, { surface, canvas, proxy }, owner);
      if (get(bindingIdentity$) !== identity || owner.aborted) {
        set(bindingAborted$, identity);
      }
    },
  );
  return { bind$, dispose$ };
}

function createNativeClipboardRecovery(graph: NativeGraph) {
  const { clipboard, synchronize$ } = graph;
  const copyClipboard$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      set(synchronize$);
      await set(clipboard.copyRecovery$, signal);
    },
  );
  return { copyClipboard$ };
}

/** The textarea is uncontrolled; semantic native state belongs to this graph. */
export function createNativeInput(
  input$: Computed<NativeInputPort | null>,
  releaseFocus$: Command<void, []>,
): NativeInput {
  const values = createNativeState(input$, releaseFocus$);
  const reset = createNativeReset(values);
  const coordinated = {
    ...values,
    ...reset,
    ...createNativeCoordination({ ...values, ...reset }),
    ...createNativeButtons(values),
  };
  const handlers = {
    ...coordinated,
    ...createNativePress(coordinated),
    ...createNativeMousePress(coordinated),
    ...createNativeMovement(coordinated),
    ...createNativeRelease(coordinated),
    ...createNativeFocus(coordinated),
    ...createNativeCompositionEvents(coordinated),
    ...createNativeTextEvents(coordinated),
    ...createNativeKeyDown(coordinated),
    ...createNativeKeyUp(coordinated),
  };
  const bindings = {
    ...handlers,
    ...createNativeClipboardBindings(handlers),
    ...createNativePointerBindings(handlers),
    ...createNativeTextBindings(handlers),
  };
  return {
    ...createNativeLifetime(bindings),
    ...createNativeClipboardRecovery(coordinated),
    reset$: coordinated.reset$,
    synchronize$: coordinated.synchronize$,
    place$: coordinated.place$,
    recovery$: values.clipboard.recovery$,
    dismissClipboard$: values.clipboard.dismiss$,
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
