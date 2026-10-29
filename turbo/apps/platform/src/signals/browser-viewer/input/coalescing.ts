import type { Protocol } from "devtools-protocol";

export type PointerState = Pick<
  Protocol.Input.DispatchMouseEventRequest,
  "button" | "buttons" | "modifiers"
>;

export function samePointerState(a: PointerState, b: PointerState): boolean {
  return (
    (a.button ?? "none") === (b.button ?? "none") &&
    (a.buttons ?? 0) === (b.buttons ?? 0) &&
    (a.modifiers ?? 0) === (b.modifiers ?? 0)
  );
}

export function sameDirection(a: number, b: number): boolean {
  return !a || !b || Math.sign(a) === Math.sign(b);
}
