import { createDeferredPromise, detach, Reason } from "../../utils.ts";

import { clipboardTextLimit } from "./selection.ts";
import type { InputBinding } from "./ingress.ts";

export interface ClipboardRecovery {
  readonly message: string;
  readonly text: string | null;
}

const recoveryMessage =
  "Automatic copy is unavailable. Select the text below and use your browser's Copy command, or try Copy text.";
const unavailableMessage =
  "Copy is unavailable for this selection. Use selected page text or a supported text control.";

interface CopyAttempt {
  reject: (reason: Error) => void;
  text: string | null;
  failed: boolean;
}

/** Local clipboard effects belong to this proxy and the original user gesture. */
export class NativeClipboard {
  private attempt: CopyAttempt | null = null;
  private recovery: ClipboardRecovery | null = null;

  constructor(
    private readonly proxy: HTMLTextAreaElement,
    private readonly input: (event?: Event) => InputBinding | null,
    private readonly composing: () => boolean,
    private readonly changed: (recovery: ClipboardRecovery | null) => void,
    private readonly signal: AbortSignal,
  ) {
    proxy.addEventListener("copy", this.copy, { signal });
    proxy.addEventListener("paste", this.paste, { signal });
    proxy.addEventListener(
      "cut",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
      },
      { signal },
    );
  }

  reset(keepRecovery = false): void {
    const attempt = this.attempt;
    this.attempt = null;
    attempt?.reject(new Error("Copy cancelled"));
    if (!keepRecovery) {
      this.show(null);
    }
  }

  private show(value: ClipboardRecovery | null): void {
    this.recovery = value;
    this.changed(value);
  }

  private focused(event?: Event): InputBinding | null {
    return document.activeElement === this.proxy ? this.input(event) : null;
  }

  private readonly paste = (event: ClipboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const input = this.focused(event);
    const owner = input?.owner;
    if (!event.isTrusted || !input || !owner) {
      return;
    }
    if (this.composing()) {
      input.clipboardError("Finish composing text before pasting.");
      return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text.length > clipboardTextLimit) {
      input.clipboardError("Clipboard text exceeds the supported size.");
      return;
    }
    if (
      !text &&
      event.clipboardData?.types.length &&
      !event.clipboardData.types.includes("text/plain")
    ) {
      input.clipboardError("Only plain-text clipboard transfer is supported.");
      return;
    }
    if (text) {
      input.text(text, owner);
    }
  };

  private readonly copy = (event: ClipboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const input = this.focused(event);
    const owner = input?.owner;
    if (!event.isTrusted || !input || !owner) {
      return;
    }
    this.reset();
    if (this.composing()) {
      input.clipboardError("Finish composing text before copying.");
      return;
    }
    const deferred = createDeferredPromise<Blob>(this.signal);
    const data = deferred.promise;
    const resolveData = (value: Blob) => {
      if (!deferred.settled()) {
        deferred.resolve(value);
      }
    };
    const rejectData = (reason: Error) => {
      if (!deferred.settled()) {
        deferred.reject(reason);
      }
    };
    const attempt: CopyAttempt = {
      reject: rejectData,
      text: null,
      failed: false,
    };
    this.attempt = attempt;
    const failed = () => {
      if (this.attempt !== attempt) {
        return;
      }
      attempt.failed = true;
      if (attempt.text !== null) {
        this.show({ message: recoveryMessage, text: attempt.text });
        input.clipboardError(
          "Local clipboard access failed. Use the copy recovery controls.",
        );
      }
    };
    // Invoke write in the original browser gesture, before any remote read awaits.
    detach(
      this.writeData(data, attempt, failed),
      Reason.DomCallback,
      "browser copy",
    );
    detach(
      (async () => {
        const [reply3] = await Promise.allSettled([input.selection(owner)]);
        if (reply3.status === "fulfilled") {
          const result = reply3.value;

          if (
            this.attempt !== attempt ||
            this.focused() !== input ||
            input.owner !== owner
          ) {
            rejectData(new Error("Copy cancelled"));
            return;
          }
          if (result.status !== "ok" || !result.text) {
            this.attempt = null;
            rejectData(new Error("No supported selection"));
            if (result.status !== "empty") {
              const message =
                result.status === "too-large"
                  ? "Selected text exceeds the supported clipboard size."
                  : result.status === "stale"
                    ? "The selection changed while copying. Select the text again."
                    : unavailableMessage;
              input.clipboardError(message);
              this.show({ message, text: null });
            }
            return;
          }
          attempt.text = result.text;
          resolveData(new Blob([result.text], { type: "text/plain" }));
          if (attempt.failed) {
            failed();
          }

          return;
        }
        rejectData(new Error("Selection unavailable"));
        if (this.attempt !== attempt) {
          return;
        }
        this.attempt = null;
        input.clipboardError(
          "Copy could not be completed. Select the text and try again.",
        );

        return;
      })(),
      Reason.DomCallback,
      "browser operation",
    );
  };

  private async writeData(
    data: Promise<Blob>,
    attempt: CopyAttempt,
    failed: () => void,
  ): Promise<void> {
    const [result] = await Promise.allSettled([this.commitData(data, attempt)]);
    if (result.status === "rejected") {
      failed();
      throw result.reason;
    }
  }

  private async commitData(
    data: Promise<Blob>,
    attempt: CopyAttempt,
  ): Promise<void> {
    await navigator.clipboard.write([
      new ClipboardItem({ "text/plain": data }),
    ]);
    if (this.attempt === attempt) {
      this.attempt = null;
      this.show(null);
    }
  }

  /** A fresh local gesture uses only the original recovered text. */
  copyRecovery(): void {
    const recovery = this.recovery;
    if (!recovery || recovery.text === null) {
      return;
    }
    const text = recovery.text;
    detach(
      this.writeRecovery(recovery, text),
      Reason.DomCallback,
      "browser clipboard recovery",
    );
  }
  private async writeRecovery(
    recovery: ClipboardRecovery,
    text: string,
  ): Promise<void> {
    const [result] = await Promise.allSettled([
      this.commitRecovery(recovery, text),
    ]);
    if (result.status === "rejected") {
      if (this.recovery === recovery) {
        this.input()?.clipboardError(
          "Use your browser's Copy command on the selected recovery text.",
        );
      }
      throw result.reason;
    }
  }

  private async commitRecovery(
    recovery: ClipboardRecovery,
    text: string,
  ): Promise<void> {
    await navigator.clipboard.writeText(text);
    if (this.recovery === recovery) {
      this.reset();
    }
  }
}
