import type { Command, Computed } from "ccstate";
import type { Protocol } from "devtools-protocol";
import type { Point } from "../display/geometry.ts";
import type { InputOwner, InputTransition } from "./lifecycle.ts";
import type { SelectionResult } from "./selection.ts";
import type { EditingTarget } from "./editing.ts";

type Mouse = Protocol.Input.DispatchMouseEventRequest;
export type PointerDetails = Pick<
  Mouse,
  "button" | "buttons" | "clickCount" | "modifiers" | "deltaX" | "deltaY"
>;

/** Preconstructed native DOM reconciliation, invoked by semantic fact writers. */
export interface NativeInputHost {
  readonly synchronize$: Command<void, []>;
}

/** Keyboard metadata only; remote field values never enter this observation. */
export interface EditingContext {
  readonly type: string;
  readonly multiline: boolean;
  readonly inputMode: string;
  readonly enterKeyHint: string;
  readonly autoCapitalize: string;
  readonly lang: string;
}

export type EditingObservation =
  | {
      readonly kind: "editable";
      readonly target: EditingTarget;
      readonly context: EditingContext;
    }
  | { readonly kind: "inactive"; readonly target: EditingTarget }
  | { readonly kind: "unknown"; readonly target: EditingTarget | null };

/** Session graph capabilities; native bindings retain their original owner. */
export interface NativeInputPort {
  readonly available$: Computed<boolean>;
  readonly owner$: Computed<InputOwner | null>;
  readonly transition$: Computed<{
    readonly id: number;
    readonly reason: InputTransition;
  } | null>;
  readonly clipboardEpoch$: Computed<number>;
  readonly caret$: Computed<Point | null>;
  readonly editing$: Computed<EditingObservation>;
  readonly focus$: Command<void, [owner?: InputOwner]>;
  readonly blur$: Command<InputOwner | null, [owner?: InputOwner]>;
  readonly completion$: Command<Promise<void>, [owner: InputOwner]>;
  readonly pointer$: Command<
    void,
    [
      type: Mouse["type"],
      point: Point,
      details: PointerDetails,
      owner?: InputOwner,
    ]
  >;
  readonly key$: Command<
    void,
    [key: Protocol.Input.DispatchKeyEventRequest, owner?: InputOwner]
  >;
  readonly text$: Command<void, [text: string, owner?: InputOwner]>;
  readonly beginComposition$: Command<void, [owner: InputOwner]>;
  readonly preedit$: Command<
    void,
    [
      text: string,
      owner: InputOwner,
      selectionStart?: number,
      selectionEnd?: number,
    ]
  >;
  readonly commitComposition$: Command<void, [text: string, owner: InputOwner]>;
  readonly selection$: Command<Promise<SelectionResult>, [owner: InputOwner]>;
  readonly clipboardError$: Command<
    void,
    [message: string, owner?: InputOwner]
  >;
}
