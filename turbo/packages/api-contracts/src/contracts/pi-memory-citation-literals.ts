/** Bounded recognition of isolated citation examples, shared with the Rust adapter. */
export interface CitationCharacter {
  readonly value: string;
  readonly source: number;
}

type Emit = (item: CitationCharacter, escape: boolean) => void;
type Mode = "text" | "run" | "inline" | "header" | "fence";

export class CitationLiteralEscaper {
  readonly #open: string;
  readonly #close: string;
  #mode: Mode = "text";
  #pending: CitationCharacter[] = [];
  #eligible = false;
  #marker = "";
  #width = 0;
  #closing = 0;
  #fenceStart = false;
  #fenceClose = false;
  #fenceTail = false;
  #indent = 0;
  #escaped = false;
  #token = "";
  #tokenEnded = false;

  constructor(open: string, close: string) {
    this.#open = open;
    this.#close = close;
  }

  push(item: CitationCharacter, emit: Emit): void {
    this.#consume(item, emit);
    this.#indent =
      item.value === "\n"
        ? 0
        : item.value === " " && this.#indent < 4
          ? this.#indent + 1
          : 4;
  }

  #consume(item: CitationCharacter, emit: Emit): void {
    const c = item.value;
    switch (this.#mode) {
      case "text":
        if ((c === "`" && !this.#escaped) || (c === "~" && this.#indent <= 3)) {
          this.#mode = "run";
          this.#marker = c;
          this.#width = 1;
          this.#fenceStart = this.#indent <= 3;
          this.#eligible = true;
          this.#token = "";
          this.#tokenEnded = false;
          this.#closing = 0;
          this.#pending.push(item);
        } else {
          emit(item, false);
        }
        this.#escaped = c === "\\" && !this.#escaped;
        return;
      case "run":
        if (c === this.#marker) {
          this.#width += 1;
          this.#retain(item, emit);
        } else {
          if (
            this.#fenceStart &&
            this.#width >= 3 &&
            !(this.#marker === "`" && c === "<")
          ) {
            this.#mode = "header";
          } else if (this.#marker === "`") {
            this.#mode = "inline";
          } else {
            this.#flush(false, emit);
            this.#mode = "text";
          }
          this.#consume(item, emit);
        }
        return;
      case "inline":
        this.#consumeInline(item, emit);
        return;
      case "header":
        if (c === "\n") {
          this.#mode = "fence";
          this.#fenceClose = true;
          this.#fenceTail = false;
          this.#closing = 0;
        } else if (!/^[a-zA-Z0-9 \t\r_-]$/.test(c)) {
          // Only simple language labels are supported literal fence headers.
          this.#invalidate(emit);
        }
        this.#retain(item, emit);
        return;
      case "fence":
        this.#consumeFence(item, emit);
    }
  }

  #consumeInline(item: CitationCharacter, emit: Emit): void {
    const c = item.value;
    if (c !== "`" && this.#closing === this.#width) {
      this.#flush(this.#completeToken(), emit);
      this.#mode = "text";
      this.#consume(item, emit);
      return;
    }
    if (c === "`") {
      this.#closing += 1;
      if (this.#closing > this.#width || !this.#completeToken()) {
        this.#invalidate(emit);
      }
    } else {
      if (this.#closing > 0) {
        this.#invalidate(emit);
      }
      this.#closing = 0;
      this.#consumeToken(c, false, emit);
    }
    this.#retain(item, emit);
  }

  #consumeFence(item: CitationCharacter, emit: Emit): void {
    const c = item.value;
    if (c === "\n") {
      const closes = this.#fenceClose && this.#closing >= this.#width;
      if (!closes) {
        if (this.#closing > 0) {
          // A failed closing run is non-whitespace body content.
          this.#invalidate(emit);
        }
        this.#consumeToken(c, true, emit);
      }
      this.#retain(item, emit);
      if (closes) {
        this.#flush(this.#completeToken(), emit);
        this.#mode = "text";
      }
      this.#fenceClose = true;
      this.#fenceTail = false;
      this.#closing = 0;
      return;
    }
    if (this.#fenceClose) {
      if (this.#closing === 0 && c === " " && this.#indent < 3) {
        this.#consumeToken(c, true, emit);
      } else if (c === this.#marker && !this.#fenceTail) {
        this.#closing += 1;
      } else if (this.#closing > 0 && /^[ \t\r]$/.test(c)) {
        this.#fenceTail = true;
      } else {
        this.#fenceClose = false;
        if (this.#closing > 0) {
          this.#invalidate(emit);
        }
        this.#consumeToken(c, true, emit);
      }
    } else {
      this.#consumeToken(c, true, emit);
    }
    this.#retain(item, emit);
  }

  #consumeToken(c: string, whitespace: boolean, emit: Emit): void {
    if (!this.#eligible) {
      return;
    }
    if (whitespace && /^[ \t\r\n]$/.test(c)) {
      if (this.#token.length > 0) {
        if (!this.#completeToken()) {
          this.#invalidate(emit);
        }
        this.#tokenEnded = true;
      }
      return;
    }
    if (this.#tokenEnded) {
      this.#invalidate(emit);
      return;
    }
    this.#token += c;
    if (
      !this.#open.startsWith(this.#token) &&
      !this.#close.startsWith(this.#token)
    ) {
      this.#invalidate(emit);
    }
  }

  #completeToken(): boolean {
    return (
      this.#eligible &&
      (this.#token === this.#open || this.#token === this.#close)
    );
  }

  #retain(item: CitationCharacter, emit: Emit): void {
    if (this.#pending.length >= 4096) {
      this.#invalidate(emit);
    }
    if (this.#eligible) {
      this.#pending.push(item);
    } else {
      emit(item, false);
    }
  }

  #invalidate(emit: Emit): void {
    this.#flush(false, emit);
    this.#eligible = false;
  }

  #flush(escape: boolean, emit: Emit): void {
    for (const item of this.#pending) {
      emit(item, escape);
    }
    this.#pending = [];
  }

  finish(emit: Emit): void {
    const closed =
      (this.#mode === "inline" && this.#closing === this.#width) ||
      (this.#mode === "fence" &&
        this.#fenceClose &&
        this.#closing >= this.#width);
    this.#flush(closed && this.#completeToken(), emit);
  }
}
