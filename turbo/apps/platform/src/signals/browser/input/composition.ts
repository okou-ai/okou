import { command, computed, state } from "ccstate";
import type { InputOwner } from "./lifecycle.ts";

export interface Preedit {
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

type CompositionState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "composing";
      readonly owner: InputOwner;
      readonly before: string;
      readonly after: string;
      readonly preedit: Preedit | null;
    }
  | { readonly kind: "trailing"; readonly value: string };

/** Native composition state, independent of DOM and CDP event timing. */
export function createNativeComposition() {
  const internalState$ = state<CompositionState>({ kind: "idle" });
  const composing$ = computed((get) => {
    return get(internalState$).kind === "composing";
  });
  const reset$ = command(({ set }) => {
    set(internalState$, { kind: "idle" });
  });
  const start$ = command<
    void,
    [owner: InputOwner | null, value?: string, start?: number, end?: number]
  >(({ set }, owner, value = "", start = value.length, end = start) => {
    set(
      internalState$,
      owner
        ? {
            kind: "composing",
            owner,
            before: value.slice(0, start),
            after: value.slice(end),
            preedit: null,
          }
        : { kind: "idle" },
    );
  });
  const owns$ = command(({ get }, owner: InputOwner | null) => {
    const current = get(internalState$);
    return current.kind === "composing" && current.owner === owner;
  });
  const update$ = command(
    (
      { get, set },
      text: string,
      owner: InputOwner | null,
      start: number = text.length,
      end: number = start,
    ): Preedit | null => {
      const current = get(internalState$);
      if (current.kind !== "composing" || current.owner !== owner) {
        return null;
      }
      const selectionStart = Math.max(0, Math.min(start, text.length));
      const selectionEnd = Math.max(selectionStart, Math.min(end, text.length));
      const previous = current.preedit;
      if (
        previous?.text === text &&
        previous.selectionStart === selectionStart &&
        previous.selectionEnd === selectionEnd
      ) {
        return null;
      }
      const preedit = { text, selectionStart, selectionEnd };
      set(internalState$, { ...current, preedit });
      return preedit;
    },
  );
  const end$ = command(
    ({ get, set }, data: string, owner: InputOwner | null) => {
      const current = get(internalState$);
      const commit =
        owner !== null &&
        current.kind === "composing" &&
        current.owner === owner;
      const value = owner ? data : "";
      // A late end consumes its following value, never commits to a new owner.
      set(
        internalState$,
        value ? { kind: "trailing", value } : { kind: "idle" },
      );
      return { value, text: commit ? data : "" };
    },
  );
  const input$ = command(
    (
      { get, set },
      value: string,
      owner: InputOwner | null,
      ...details: [
        compositionInput: boolean,
        isComposing: boolean,
        selection?: { start?: number; end?: number },
      ]
    ): { keep: boolean; text: string; preedit?: Preedit | null } => {
      const [
        compositionInput,
        isComposing,
        { start = value.length, end = start } = {},
      ] = details;
      const current = get(internalState$);
      if (!owner || (current.kind === "idle" && compositionInput)) {
        set(reset$);
        return { keep: false, text: "" };
      }
      if (current.kind === "composing") {
        const { before, after } = current;
        const preedit =
          value.length >= before.length + after.length &&
          value.startsWith(before) &&
          value.endsWith(after)
            ? set(
                update$,
                value.slice(before.length, value.length - after.length),
                owner,
                start - before.length,
                end - before.length,
              )
            : null;
        return { keep: true, text: "", preedit };
      }
      if (isComposing) {
        return { keep: true, text: "" };
      }
      const consumed = current.kind === "trailing" ? current.value : "";
      const text =
        consumed && value.startsWith(consumed)
          ? value.slice(consumed.length)
          : value;
      set(reset$);
      return { keep: false, text };
    },
  );
  return { composing$, reset$, start$, owns$, update$, end$, input$ };
}
