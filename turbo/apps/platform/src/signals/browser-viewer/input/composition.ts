import type { InputOwner } from "./lifecycle.ts";

export interface Preedit {
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

type State =
  | { kind: "idle" }
  | {
      kind: "composing";
      owner: InputOwner;
      before: string;
      after: string;
      preedit: Preedit | null;
    }
  | { kind: "trailing"; value: string };

/** Native composition state, independent of DOM and CDP event timing. */
export class NativeComposition {
  private state: State = { kind: "idle" };

  get composing(): boolean {
    return this.state.kind === "composing";
  }

  reset(): void {
    this.state = { kind: "idle" };
  }

  start(
    owner: InputOwner | null,
    value = "",
    start = value.length,
    end = start,
  ): void {
    this.state = owner
      ? {
          kind: "composing",
          owner,
          before: value.slice(0, start),
          after: value.slice(end),
          preedit: null,
        }
      : { kind: "idle" };
  }

  owns(owner: InputOwner | null): boolean {
    return this.state.kind === "composing" && this.state.owner === owner;
  }

  update(
    text: string,
    owner: InputOwner | null,
    start = text.length,
    end = start,
  ): Preedit | null {
    if (this.state.kind !== "composing" || this.state.owner !== owner) {
      return null;
    }
    const selectionStart = Math.max(0, Math.min(start, text.length));
    const selectionEnd = Math.max(selectionStart, Math.min(end, text.length));
    const previous = this.state.preedit;
    if (
      previous?.text === text &&
      previous.selectionStart === selectionStart &&
      previous.selectionEnd === selectionEnd
    ) {
      return null;
    }
    const preedit = { text, selectionStart, selectionEnd };
    this.state.preedit = preedit;
    return preedit;
  }

  end(data: string, owner: InputOwner | null) {
    const commit =
      owner !== null &&
      this.state.kind === "composing" &&
      this.state.owner === owner;
    const value = owner ? data : "";
    // A late end may only consume its following value, never commit to a new owner.
    this.state = value ? { kind: "trailing", value } : { kind: "idle" };
    return { value, text: commit ? data : "" };
  }

  input(
    value: string,
    owner: InputOwner | null,
    compositionInput: boolean,
    isComposing: boolean,
    {
      start = value.length,
      end = start,
    }: { start?: number; end?: number } = {},
  ) {
    if (!owner || (this.state.kind === "idle" && compositionInput)) {
      this.reset();
      return { keep: false, text: "" };
    }
    if (this.state.kind === "composing") {
      const { before, after } = this.state;
      const preedit =
        value.length >= before.length + after.length &&
        value.startsWith(before) &&
        value.endsWith(after)
          ? this.update(
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
    const consumed = this.state.kind === "trailing" ? this.state.value : "";
    const text =
      consumed && value.startsWith(consumed)
        ? value.slice(consumed.length)
        : value;
    this.reset();
    return { keep: false, text };
  }
}
