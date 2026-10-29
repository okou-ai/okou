import type { Protocol } from "devtools-protocol";
import type { Point } from "../display/geometry.ts";

type Key = Protocol.Input.DispatchKeyEventRequest;
type Button = NonNullable<Protocol.Input.DispatchMouseEventRequest["button"]>;

/** Object identity also binds this token to its viewer/connection/session. */
export interface InputOwner {
  readonly sessionId: string;
  readonly document: number;
  readonly focus: number;
}

export type InputStop =
  "target-replaced" | "paused" | "disconnected" | "disposed";

export type InputTransition =
  | InputStop
  | "blur"
  | "navigation-started"
  | "same-document"
  | "document-lost"
  | "failed";

const policy = {
  blur: { release: true, documentLost: false, terminal: false },
  "navigation-started": { release: true, documentLost: false, terminal: false },
  "same-document": { release: true, documentLost: false, terminal: false },
  "document-lost": { release: false, documentLost: true, terminal: false },
  "target-replaced": { release: true, documentLost: false, terminal: true },
  paused: { release: true, documentLost: false, terminal: true },
  disconnected: { release: false, documentLost: false, terminal: true },
  disposed: { release: true, documentLost: false, terminal: true },
  failed: { release: true, documentLost: false, terminal: false },
} satisfies Record<
  InputTransition,
  { release: boolean; documentLost: boolean; terminal: boolean }
>;

/** State and cleanup decisions only: no DOM, sockets, callbacks or timers. */
export class InputLifecycle {
  private current: InputOwner;
  private closed = false;
  private readonly keys = new Map<string, Key>();
  private readonly buttons = new Map<Button, Point>();
  private point: Point = { x: 0, y: 0 };
  private composing: object | null = null;

  constructor(sessionId: string) {
    this.current = Object.freeze({ sessionId, document: 0, focus: 0 });
  }

  get owner(): InputOwner {
    return this.current;
  }

  get available(): boolean {
    return !this.closed;
  }

  owns(owner: InputOwner): boolean {
    return !this.closed && owner === this.current;
  }

  retainsDocument(owner: InputOwner): boolean {
    return (
      owner.sessionId === this.current.sessionId &&
      owner.document === this.current.document
    );
  }

  composition(owner: InputOwner): object | null {
    return this.owns(owner) ? this.composing : null;
  }

  compose(owner: InputOwner): object | null {
    if (!this.owns(owner)) {
      return null;
    }
    this.composing = {};
    return this.composing;
  }

  finishComposition(owner: InputOwner, token: object | null): void {
    if (this.owns(owner) && this.composing === token) {
      this.composing = null;
    }
  }

  pressKey(owner: InputOwner, key: Key): void {
    if (this.owns(owner)) {
      this.keys.set(key.code || key.key || "", { ...key });
    }
  }

  pressedKey(owner: InputOwner, key: Key): Key | undefined {
    return this.owns(owner)
      ? this.keys.get(key.code || key.key || "")
      : undefined;
  }

  releaseKey(owner: InputOwner, key: Key, pressed: Key | undefined): void {
    const id = key.code || key.key || "";
    if (this.owns(owner) && this.keys.get(id) === pressed) {
      this.keys.delete(id);
    }
  }

  pointer(owner: InputOwner, point: Point, pressed?: Button): void {
    if (!this.owns(owner)) {
      return;
    }
    this.point = point;
    if (pressed) {
      this.buttons.set(pressed, { ...point });
    }
  }

  pressedButton(owner: InputOwner, button: Button): Point | undefined {
    return this.owns(owner) ? this.buttons.get(button) : undefined;
  }

  releaseButton(
    owner: InputOwner,
    button: Button,
    pressed: Point | undefined,
  ): void {
    if (this.owns(owner) && this.buttons.get(button) === pressed) {
      this.buttons.delete(button);
    }
  }

  transition(reason: InputTransition) {
    if (this.closed) {
      return null;
    }
    const rule = policy[reason];
    const cleanup = {
      owner: this.current,
      keys: rule.release ? [...this.keys.values()] : [],
      buttons: rule.release ? [...this.buttons.keys()] : [],
      point: this.point,
      composition: rule.release && this.composing !== null,
    };
    // Publish the new owner before running any effects, including DOM blur.
    this.current = Object.freeze({
      sessionId: this.current.sessionId,
      document: this.current.document + (rule.documentLost ? 1 : 0),
      focus: this.current.focus + 1,
    });
    this.closed = rule.terminal;
    this.keys.clear();
    this.buttons.clear();
    this.composing = null;
    return cleanup;
  }
}
