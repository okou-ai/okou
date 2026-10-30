import { createStore } from "ccstate";
import { animationFrame } from "signal-timers";
import { resetSignal } from "../../utils.ts";
import type { InputOwner } from "./lifecycle.ts";
import type { NativeInputPort } from "./port.ts";
import type { Point } from "../display/geometry.ts";
import { sameDirection, samePointerState } from "./coalescing.ts";

export type ContinuousSample = {
  details: Parameters<NativeInputPort["pointer"]>[2];
} & (
  | {
      type: "mouseMoved";
      clientX: number;
      clientY: number;
      captured: boolean;
    }
  | { type: "mouseWheel"; point: Point }
);

/** A capability can lose its original authority, but can never acquire another. */
export class InputBinding {
  constructor(
    private readonly target: NativeInputPort,
    private readonly captured: InputOwner,
    private readonly current: () => boolean,
  ) {}

  get owner(): InputOwner | null {
    return this.current() ? this.captured : null;
  }

  focus(): void {
    if (this.current()) {
      this.target.focus(this.captured);
    }
  }

  blur(): void {
    if (this.current()) {
      this.target.blur(this.captured);
    }
  }

  pointer(
    type: Parameters<NativeInputPort["pointer"]>[0],
    point: Point,
    details: Parameters<NativeInputPort["pointer"]>[2],
  ): void {
    if (this.current()) {
      this.target.pointer(type, point, details, this.captured);
    }
  }

  key(key: Parameters<NativeInputPort["key"]>[0]): void {
    if (this.current()) {
      this.target.key(key, this.captured);
    }
  }

  text(text: string, owner: InputOwner = this.captured): void {
    if (owner === this.captured && this.current()) {
      this.target.text(text, owner);
    }
  }

  preedit(...args: Parameters<NativeInputPort["preedit"]>): void {
    if (args[1] === this.captured && this.current()) {
      this.target.preedit(...args);
    }
  }

  commitComposition(text: string, owner: InputOwner): void {
    if (owner === this.captured && this.current()) {
      this.target.commitComposition(text, owner);
    }
  }

  selection(owner: InputOwner): ReturnType<NativeInputPort["selection"]> {
    return owner === this.captured && this.current()
      ? this.target.selection(owner)
      : Promise.reject(new Error("Selection cancelled"));
  }

  clipboardError(message: string): void {
    if (this.current()) {
      this.target.clipboardError(message, this.captured);
    }
  }
}

type Pending = ContinuousSample & { readonly input: InputBinding };

// The graph is stable; every mounted admission boundary owns its own Store.
const resetInputFrame$ = resetSignal();

/** One origin/admission boundary; native preparation and reply pressure stay in the queue. */
export class InputIngress {
  private binding:
    | { target: NativeInputPort; owner: InputOwner; value: InputBinding }
    | undefined;
  private readonly events = new WeakMap<Event, InputBinding | null>();
  private pending: Pending | null = null;
  private readonly store = createStore();
  private frame: AbortSignal | null = null;
  private closed = false;

  constructor(
    private readonly input: () => NativeInputPort | null,
    private readonly project: (sample: ContinuousSample) => Point | null,
    private readonly signal: AbortSignal,
  ) {}

  current(): InputBinding | null {
    if (this.closed) {
      return null;
    }
    const target = this.input();
    const owner = target?.owner;
    if (!target || !owner) {
      this.reset();
      this.binding = undefined;
      return null;
    }
    if (this.binding?.target !== target || this.binding.owner !== owner) {
      this.reset();
      this.binding = {
        target,
        owner,
        value: new InputBinding(target, owner, () => {
          return (
            !this.closed && this.input() === target && target.owner === owner
          );
        }),
      };
    }
    return this.binding.value;
  }

  /** Capture before flush; the same clipboard Event retains its capture-phase binding. */
  boundary(
    event?: Event,
    input: InputBinding | null = this.current(),
  ): InputBinding | null {
    if (event && this.events.has(event)) {
      const input = this.events.get(event);
      return input?.owner ? input : null;
    }
    this.flush();
    const admitted = input?.owner ? input : null;
    if (event) {
      this.events.set(event, admitted);
    }
    return admitted;
  }

  pointerBoundary({
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
  }): InputBinding | null {
    const original = this.current();
    const binding = this.binding;
    const pending = this.pending;
    // The native press already supplies an identical unheld hover position.
    if (
      pending?.type === "mouseMoved" &&
      heldButtons === 0 &&
      pending.details.buttons === 0 &&
      pending.details.modifiers === modifiers &&
      pending.clientX === clientX &&
      pending.clientY === clientY
    ) {
      this.pending = null;
    }
    const input = this.boundary(undefined, original);
    if (!input || !composing) {
      return input;
    }
    if (binding?.value !== input) {
      return null;
    }
    // This deliberate focus transition returns the token published BEFORE its
    // callbacks. Never infer its successor by reading whichever owner is current.
    const owner = binding.target.blur(binding.owner);
    return owner &&
      this.input() === binding.target &&
      binding.target.owner === owner
      ? this.current()
      : null;
  }

  continuous(
    sample: ContinuousSample,
    input: InputBinding | null = this.current(),
  ): void {
    if (!input?.owner) {
      return;
    }
    if (this.coalesce(sample, input)) {
      return;
    }
    const previous = this.pending;
    if (previous) {
      this.flush();
    }
    if (!input.owner) {
      return;
    }
    const pending: Pending = { ...sample, input };
    this.pending = pending;
    if (this.frame === null) {
      this.schedule();
    }
  }

  private coalesce(sample: ContinuousSample, input: InputBinding): boolean {
    const previous = this.pending;
    if (
      previous?.input === input &&
      samePointerState(previous.details, sample.details)
    ) {
      if (previous.type === "mouseMoved" && sample.type === "mouseMoved") {
        previous.clientX = sample.clientX;
        previous.clientY = sample.clientY;
        previous.captured = sample.captured;
        previous.details = sample.details;
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
          previous.details.deltaX = px + x;
          previous.details.deltaY = py + y;
          return true;
        }
      }
    }

    return false;
  }

  reset(): void {
    this.pending = null;
    const frame = this.frame;
    this.frame = null;
    if (frame && !frame.aborted) {
      this.store.set(resetInputFrame$);
    }
  }

  blur(): void {
    const input = this.current();
    this.reset();
    input?.blur();
  }

  dispose(): void {
    const target = this.closed ? null : this.input();
    const owner = target?.owner;
    this.closed = true;
    this.reset();
    // Terminal admission precedes original-owner cleanup and its callbacks.
    if (owner) {
      target?.blur(owner);
    }
  }

  private flush(): void {
    const pending = this.pending;
    this.reset();
    if (pending) {
      this.send(pending);
    }
  }

  private send(pending: Pending): void {
    if (!pending.input.owner) {
      return;
    }
    const point = this.project(pending);
    if (point) {
      pending.input.pointer(pending.type, point, pending.details);
    }
  }

  private schedule(): void {
    const frame = this.store.set(resetInputFrame$, this.signal);
    this.frame = frame;
    animationFrame(
      () => {
        if (this.frame !== frame) {
          return;
        }
        this.frame = null;
        const pending = this.pending;
        this.pending = null;
        if (pending) {
          this.send(pending);
        }
      },
      { signal: frame },
    );
  }
}
