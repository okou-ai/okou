import { command, computed, state, type Command, type State } from "ccstate";
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

/** Held key identity survives only until its own original acknowledgement. */
function createHeldKeys(
  keys$: State<ReadonlyMap<string, Key>>,
  owns$: Command<boolean, [InputOwner]>,
) {
  const pressKey$ = command(
    ({ get, set }, owner: InputOwner, key: Key): void => {
      if (set(owns$, owner)) {
        set(
          keys$,
          new Map(get(keys$)).set(
            key.code || key.key || "",
            Object.freeze({ ...key }),
          ),
        );
      }
    },
  );
  const pressedKey$ = command(
    ({ get, set }, owner: InputOwner, key: Key): Key | undefined => {
      return set(owns$, owner)
        ? get(keys$).get(key.code || key.key || "")
        : undefined;
    },
  );
  const releaseKey$ = command(
    (
      { get, set },
      owner: InputOwner,
      key: Key,
      pressed: Key | undefined,
    ): void => {
      const id = key.code || key.key || "";
      if (set(owns$, owner) && get(keys$).get(id) === pressed) {
        const keys = new Map(get(keys$));
        keys.delete(id);
        set(keys$, keys);
      }
    },
  );
  return { pressKey$, pressedKey$, releaseKey$ };
}

/** State and cleanup decisions only: no DOM, sockets, callbacks or timers. */
export function createInputLifecycle(sessionId: string) {
  const current$ = state<InputOwner>(
    Object.freeze({ sessionId, document: 0, focus: 0 }),
  );
  const closed$ = state(false);
  const keys$ = state<ReadonlyMap<string, Key>>(new Map());
  const buttons$ = state<ReadonlyMap<Button, Point>>(new Map());
  const point$ = state<Point>(Object.freeze({ x: 0, y: 0 }));
  const composing$ = state<object | null>(null);

  const owner$ = computed((get) => {
    return get(current$);
  });
  const available$ = computed((get) => {
    return !get(closed$);
  });
  const owns$ = command(({ get }, owner: InputOwner): boolean => {
    return get(available$) && owner === get(owner$);
  });
  const retainsDocument$ = command(({ get }, owner: InputOwner): boolean => {
    const current = get(owner$);
    return (
      owner.sessionId === current.sessionId &&
      owner.document === current.document
    );
  });
  const composition$ = command(
    ({ get, set }, owner: InputOwner): object | null => {
      return set(owns$, owner) ? get(composing$) : null;
    },
  );
  const compose$ = command(({ set }, owner: InputOwner): object | null => {
    if (!set(owns$, owner)) {
      return null;
    }
    const token = Object.freeze({});
    set(composing$, token);
    return token;
  });
  const finishComposition$ = command(
    ({ get, set }, owner: InputOwner, token: object | null): void => {
      if (set(owns$, owner) && get(composing$) === token) {
        set(composing$, null);
      }
    },
  );
  const pointer$ = command(
    ({ get, set }, owner: InputOwner, point: Point, pressed?: Button): void => {
      if (!set(owns$, owner)) {
        return;
      }
      const position = Object.freeze({ ...point });
      set(point$, position);
      if (pressed) {
        set(buttons$, new Map(get(buttons$)).set(pressed, position));
      }
    },
  );
  const pressedButton$ = command(
    ({ get, set }, owner: InputOwner, button: Button): Point | undefined => {
      return set(owns$, owner) ? get(buttons$).get(button) : undefined;
    },
  );
  const releaseButton$ = command(
    (
      { get, set },
      owner: InputOwner,
      button: Button,
      pressed: Point | undefined,
    ): void => {
      if (set(owns$, owner) && get(buttons$).get(button) === pressed) {
        const buttons = new Map(get(buttons$));
        buttons.delete(button);
        set(buttons$, buttons);
      }
    },
  );
  const transition$ = command(({ get, set }, reason: InputTransition) => {
    if (!get(available$)) {
      return null;
    }
    const rule = policy[reason];
    const current = get(owner$);
    const cleanup = {
      owner: current,
      keys: rule.release ? [...get(keys$).values()] : [],
      buttons: rule.release ? [...get(buttons$).keys()] : [],
      point: get(point$),
      composition: rule.release && get(composing$) !== null,
    };
    // Publish the successor before callers run cleanup or reentrant DOM work.
    set(
      current$,
      Object.freeze({
        sessionId: current.sessionId,
        document: current.document + (rule.documentLost ? 1 : 0),
        focus: current.focus + 1,
      }),
    );
    set(closed$, rule.terminal);
    set(keys$, new Map());
    set(buttons$, new Map());
    set(composing$, null);
    return cleanup;
  });

  return {
    owner$,
    available$,
    owns$,
    retainsDocument$,
    composition$,
    compose$,
    finishComposition$,
    ...createHeldKeys(keys$, owns$),
    pointer$,
    pressedButton$,
    releaseButton$,
    transition$,
  };
}

export type InputLifecycle = ReturnType<typeof createInputLifecycle>;
