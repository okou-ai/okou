import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import type { Protocol } from "devtools-protocol";
import { animationFrame } from "signal-timers";
import type { InputOwner } from "./lifecycle.ts";
import type { NativeInputPort, PointerDetails } from "./port.ts";
import type { Point } from "../display/geometry.ts";
import { imagePoint } from "./geometry.ts";
import { sameDirection, samePointerState } from "./coalescing.ts";

export type ContinuousSample = { readonly details: PointerDetails } & (
  | {
      readonly type: "mouseMoved";
      readonly clientX: number;
      readonly clientY: number;
      readonly captured: boolean;
    }
  | { readonly type: "mouseWheel"; readonly point: Point }
);

/** A capability can lose its original authority, but can never acquire another. */
function createInputBinding(
  target: NativeInputPort,
  captured: InputOwner,
  input$: Computed<NativeInputPort | null>,
  closed$: Computed<boolean>,
) {
  const owner$ = computed((get): InputOwner | null => {
    return !get(closed$) &&
      get(input$) === target &&
      get(target.available$) &&
      get(target.owner$) === captured
      ? captured
      : null;
  });
  const focus$ = command(({ get, set }) => {
    if (get(owner$)) {
      set(target.focus$, captured);
    }
  });
  const blur$ = command(({ get, set }) => {
    return get(owner$) ? set(target.blur$, captured) : null;
  });
  const completion$ = command(
    async (
      { get, set },
      owner: InputOwner,
      signal: AbortSignal,
    ): Promise<void> => {
      if (owner !== captured || !get(owner$)) {
        throw new Error("Input cancelled");
      }
      await set(target.completion$, captured);
      signal.throwIfAborted();
      if (!get(owner$)) {
        throw new Error("Input cancelled");
      }
    },
  );
  const pointer$ = command(
    (
      { get, set },
      type: Protocol.Input.DispatchMouseEventRequest["type"],
      point: Point,
      details: PointerDetails,
    ) => {
      if (get(owner$)) {
        set(target.pointer$, type, point, details, captured);
      }
    },
  );
  const key$ = command(
    ({ get, set }, key: Protocol.Input.DispatchKeyEventRequest) => {
      if (get(owner$)) {
        set(target.key$, key, captured);
      }
    },
  );
  const text$ = command(
    ({ get, set }, text: string, owner: InputOwner = captured) => {
      if (owner === captured && get(owner$)) {
        set(target.text$, text, captured);
      }
    },
  );
  const preedit$ = command(
    (
      { get, set },
      text: string,
      owner: InputOwner,
      start?: number,
      end?: number,
    ) => {
      if (owner === captured && get(owner$)) {
        set(target.preedit$, text, captured, start, end);
      }
    },
  );
  const commitComposition$ = command(
    ({ get, set }, text: string, owner: InputOwner) => {
      if (owner === captured && get(owner$)) {
        set(target.commitComposition$, text, captured);
      }
    },
  );
  const selection$ = command(
    async ({ get, set }, owner: InputOwner, signal: AbortSignal) => {
      if (owner !== captured || !get(owner$)) {
        throw new Error("Selection cancelled");
      }
      const result = await set(target.selection$, captured);
      signal.throwIfAborted();
      if (!get(owner$)) {
        throw new Error("Selection cancelled");
      }
      return result;
    },
  );
  const clipboardError$ = command(({ get, set }, message: string) => {
    if (get(owner$)) {
      set(target.clipboardError$, message, captured);
    }
  });
  return {
    target,
    captured,
    owner$,
    focus$,
    blur$,
    completion$,
    pointer$,
    key$,
    text$,
    preedit$,
    commitComposition$,
    selection$,
    clipboardError$,
  };
}
export type InputBinding = ReturnType<typeof createInputBinding>;
type Pending = ContinuousSample & { readonly input: InputBinding };

/** Continuous samples combine only within their original captured capability. */
function createPendingCoalescing(pending$: State<Pending | null>) {
  const coalesce$ = command(
    ({ get, set }, sample: ContinuousSample, input: InputBinding): boolean => {
      const previous = get(pending$);
      if (
        previous?.input !== input ||
        !samePointerState(previous.details, sample.details)
      ) {
        return false;
      }
      if (previous.type === "mouseMoved" && sample.type === "mouseMoved") {
        set(pending$, { ...sample, input });
        return true;
      }
      if (previous.type === "mouseWheel" && sample.type === "mouseWheel") {
        const x = sample.details.deltaX ?? 0;
        const y = sample.details.deltaY ?? 0;
        const px = previous.details.deltaX ?? 0;
        const py = previous.details.deltaY ?? 0;
        if (
          previous.point.x === sample.point.x &&
          previous.point.y === sample.point.y &&
          sameDirection(px, x) &&
          sameDirection(py, y) &&
          [px + x, py + y].every(Number.isFinite)
        ) {
          set(pending$, {
            ...previous,
            details: { ...previous.details, deltaX: px + x, deltaY: py + y },
          });
          return true;
        }
      }
      return false;
    },
  );
  return coalesce$;
}

/** One animation-frame buffer preserves captured capability and sample ordering. */
function createContinuousIngress(
  canvas$: Computed<HTMLCanvasElement | null>,
  current$: Command<InputBinding | null, []>,
) {
  const pending$ = state<Pending | null>(null);
  // A frame id that no longer matches makes its callback a no-op.
  const frame$ = state<object | null>(null);
  const reset$ = command(({ set }) => {
    set(pending$, null);
    set(frame$, null);
  });
  const send$ = command(({ get, set }, pending: Pending) => {
    if (!get(pending.input.owner$)) {
      return;
    }
    const canvas = get(canvas$);
    const point =
      pending.type === "mouseMoved"
        ? canvas &&
          imagePoint(canvas, pending.clientX, pending.clientY, pending.captured)
        : pending.point;
    if (point) {
      set(pending.input.pointer$, pending.type, point, pending.details);
    }
  });
  const flush$ = command(({ get, set }) => {
    const pending = get(pending$);
    set(reset$);
    if (pending) {
      set(send$, pending);
    }
  });
  const coalesce$ = createPendingCoalescing(pending$);
  const frameReady$ = command(({ get, set }, id: object) => {
    if (get(frame$) !== id) {
      return;
    }
    set(frame$, null);
    const pending = get(pending$);
    set(pending$, null);
    if (pending) {
      set(send$, pending);
    }
  });
  const continuous$ = command(
    (
      { get, set },
      sample: ContinuousSample,
      captured: InputBinding | null | undefined,
      signal: AbortSignal,
    ) => {
      const input = captured === undefined ? set(current$) : captured;
      if (!input || !get(input.owner$) || signal.aborted) {
        return;
      }
      if (set(coalesce$, sample, input)) {
        return;
      }
      if (get(pending$)) {
        set(flush$);
      }
      if (!get(input.owner$)) {
        return;
      }
      set(pending$, { ...sample, input });
      if (get(frame$) === null) {
        const id = {};
        animationFrame(
          () => {
            set(frameReady$, id);
          },
          { signal },
        );
        set(frame$, id);
      }
    },
  );
  return { pending$, reset$, flush$, continuous$ };
}

/** Discrete native boundaries flush samples before accepting their owner. */
function createIngressAdmission(
  input$: Computed<NativeInputPort | null>,
  events$: State<WeakMap<Event, InputBinding | null> | null>,
  current$: Command<InputBinding | null, []>,
  continuous: ReturnType<typeof createContinuousIngress>,
) {
  const { pending$, flush$ } = continuous;
  const boundary$ = command(
    (
      { get, set },
      event?: Event,
      captured?: InputBinding | null,
    ): InputBinding | null => {
      const events = get(events$);
      if (event && events?.has(event)) {
        const input = events.get(event);
        return input && get(input.owner$) ? input : null;
      }
      // Capture before flushing; a synchronous callback may revoke this owner.
      const input = captured === undefined ? set(current$) : captured;
      set(flush$);
      const admitted = input && get(input.owner$) ? input : null;
      if (event) {
        events?.set(event, admitted);
      }
      return admitted;
    },
  );
  const pointerBoundary$ = command(
    (
      { get, set },
      {
        clientX,
        clientY,
        modifiers,
        composing,
        heldButtons,
      }: {
        clientX: number;
        clientY: number;
        modifiers: number;
        composing: boolean;
        heldButtons: number;
      },
    ): InputBinding | null => {
      const original = set(current$);
      const pending = get(pending$);
      // The press already supplies the identical unheld hover position.
      if (
        pending?.type === "mouseMoved" &&
        heldButtons === 0 &&
        pending.details.buttons === 0 &&
        pending.details.modifiers === modifiers &&
        pending.clientX === clientX &&
        pending.clientY === clientY
      ) {
        set(pending$, null);
      }
      const input = set(boundary$, undefined, original);
      if (!input || !composing) {
        return input;
      }
      if (input !== original) {
        return null;
      }
      // Only the successor returned by this deliberate blur may own the new click.
      const owner = set(input.blur$);
      return owner &&
        get(input$) === input.target &&
        get(input.target.owner$) === owner
        ? set(current$)
        : null;
    },
  );
  return { boundary$, pointerBoundary$ };
}

/** One origin/admission boundary; native preparation and reply pressure stay in the queue. */
export function createInputIngress(
  input$: Computed<NativeInputPort | null>,
  canvas$: Computed<HTMLCanvasElement | null>,
) {
  const internalClosed$ = state(true);
  const closed$ = computed((get) => {
    return get(internalClosed$);
  });
  const accepted$ = state<InputBinding | null>(null);
  const events$ = state<WeakMap<Event, InputBinding | null> | null>(null);
  const binding$ = computed((get): InputBinding | null => {
    const target = get(input$);
    const owner = target && get(target.available$) ? get(target.owner$) : null;
    return !get(closed$) && target && owner
      ? createInputBinding(target, owner, input$, closed$)
      : null;
  });
  const current$: Command<InputBinding | null, []> = command(
    ({ get, set }): InputBinding | null => {
      const input = get(binding$);
      if (get(accepted$) !== input) {
        set(continuous.reset$);
        set(accepted$, input);
      }
      return input;
    },
  );
  const continuous = createContinuousIngress(canvas$, current$);
  const admission = createIngressAdmission(
    input$,
    events$,
    current$,
    continuous,
  );
  const blur$ = command(({ set }) => {
    const input = set(current$);
    set(continuous.reset$);
    if (input) {
      set(input.blur$);
    }
  });
  const dispose$ = command(({ get, set }) => {
    const target = get(closed$) ? null : get(input$);
    const owner = target ? get(target.owner$) : null;
    // Stop admission before original-owner cleanup can synchronously reenter.
    set(internalClosed$, true);
    set(accepted$, null);
    set(events$, null);
    set(continuous.reset$);
    if (target && owner) {
      set(target.blur$, owner);
    }
  });
  const bind$ = command(({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(continuous.reset$);
    set(events$, new WeakMap<Event, InputBinding | null>());
    set(accepted$, null);
    set(internalClosed$, false);
  });
  return {
    bind$,
    current$,
    ...admission,
    continuous$: continuous.continuous$,
    reset$: continuous.reset$,
    blur$,
    dispose$,
  };
}
export type InputIngress = ReturnType<typeof createInputIngress>;
