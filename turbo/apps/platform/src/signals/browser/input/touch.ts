import { command, computed, state, type State } from "ccstate";
import type { Point } from "../display/geometry.ts";
import { imagePoint } from "./geometry.ts";
import type { InputBinding, InputIngress } from "./ingress.ts";

interface TouchSurface {
  readonly surface: HTMLElement;
  readonly canvas: HTMLCanvasElement;
}
interface Gesture {
  readonly pointerId: number;
  readonly input: InputBinding;
  readonly point: Point;
  readonly origin: Point;
  readonly last: Point;
  readonly scrolling: boolean;
}
const tapSlop = 8;

/** A swipe never holds a remote button; only an ended tap becomes a click. */
export function createTouchInput(
  elements$: State<TouchSurface | null>,
  ingress: InputIngress,
) {
  const gesture$ = state<Gesture | null>(null);
  const active$ = computed((get) => {
    return get(gesture$) !== null;
  });
  const owns$ = command(({ get }, pointerId: number) => {
    return get(gesture$)?.pointerId === pointerId;
  });
  const reset$ = command(({ get, set }) => {
    const gesture = get(gesture$);
    set(gesture$, null);
    const elements = get(elements$);
    if (gesture && elements?.surface.hasPointerCapture(gesture.pointerId)) {
      elements.surface.releasePointerCapture(gesture.pointerId);
    }
  });
  const press$ = command(
    ({ get, set }, event: PointerEvent, point: Point, input: InputBinding) => {
      const elements = get(elements$);
      if (!elements || !get(input.owner$)) {
        return;
      }
      // The remote surface, not local browser panning or compatibility mouse
      // events, owns this admitted single-finger gesture.
      event.preventDefault();
      const origin = { x: event.clientX, y: event.clientY };
      set(gesture$, {
        pointerId: event.pointerId,
        input,
        point,
        origin,
        last: origin,
        scrolling: false,
      });
      elements.surface.setPointerCapture(event.pointerId);
    },
  );
  const move$ = command(
    (
      { get, set },
      event: PointerEvent,
      modifiers: number,
      signal: AbortSignal,
    ) => {
      const gesture = get(gesture$);
      if (
        !gesture ||
        gesture.pointerId !== event.pointerId ||
        !get(gesture.input.owner$)
      ) {
        return;
      }
      event.preventDefault();
      const current = { x: event.clientX, y: event.clientY };
      if (
        !gesture.scrolling &&
        Math.hypot(current.x - gesture.origin.x, current.y - gesture.origin.y) <
          tapSlop
      ) {
        return;
      }
      set(gesture$, { ...gesture, last: current, scrolling: true });
      const deltaX = gesture.last.x - current.x;
      const deltaY = gesture.last.y - current.y;
      if (deltaX || deltaY) {
        set(
          ingress.continuous$,
          {
            type: "mouseWheel",
            // Keep nested-scroll hit testing at the original remote region.
            point: gesture.point,
            details: { buttons: 0, modifiers, deltaX, deltaY },
          },
          gesture.input,
          signal,
        );
      }
    },
  );
  const release$ = command(
    (
      { get, set },
      event: PointerEvent,
      modifiers: number,
      signal: AbortSignal,
    ): { input: InputBinding; point: Point } | null => {
      if (!set(owns$, event.pointerId)) {
        return null;
      }
      // Include a final displacement even when the browser skipped the last move.
      set(move$, event, modifiers, signal);
      const gesture = get(gesture$);
      if (!gesture) {
        return null;
      }
      const input = set(ingress.boundary$, undefined, gesture.input);
      set(reset$);
      const elements = get(elements$);
      const point =
        elements && imagePoint(elements.canvas, event.clientX, event.clientY);
      return input && point && !gesture.scrolling ? { input, point } : null;
    },
  );
  return { active$, owns$, reset$, press$, move$, release$ };
}
