import { command, computed, state, type Command, type Computed } from "ccstate";
import { defaultCapture } from "./viewer/capture.ts";
import type { ViewerCaptureOptions } from "./viewer/types.ts";

export const captureQualityPresets = [40, 70, 90] as const;

function parseQuality(text: string): number | null {
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const quality = Number(text);
  return Number.isInteger(quality) && quality >= 0 && quality <= 100
    ? quality
    : null;
}

/** Editing belongs to one viewer; partial values never reconfigure capture. */
export function createCaptureQualitySignals(
  capture$: Computed<ViewerCaptureOptions>,
  changeCapture$: Command<Promise<void>, [ViewerCaptureOptions, AbortSignal]>,
) {
  const draft$ = state<string | null>(null);
  const invalid$ = state(false);
  const editing$ = state(false);
  const operationState$ = state<Promise<void> | null>(null);
  const operation$ = computed((get) => {
    return get(operationState$);
  });
  const values$ = computed((get) => {
    const quality = get(capture$).quality ?? defaultCapture.quality;
    const text = get(draft$) ?? String(quality);
    const preset = captureQualityPresets.find((value) => {
      return value === quality;
    });
    return {
      text,
      slider: parseQuality(text) ?? quality,
      preset: preset === undefined ? "" : String(preset),
      invalid: get(invalid$),
    };
  });
  const edit$ = command(({ get, set }, text: string) => {
    if (!get(editing$)) {
      return;
    }
    set(draft$, text);
    set(invalid$, false);
  });
  const reset$ = command(({ set }) => {
    set(draft$, null);
    set(invalid$, false);
  });
  const begin$ = command(({ set }) => {
    set(reset$);
    set(editing$, true);
  });
  const apply$ = command(
    async ({ get, set }, selection: number | "draft", signal: AbortSignal) => {
      signal.throwIfAborted();
      // Closing portals still receive pointer events during their exit animation.
      if (!get(editing$)) {
        return;
      }
      const capture = get(capture$);
      if (capture.format === "png") {
        set(reset$);
        return;
      }
      const text =
        selection === "draft" ? get(values$).text : String(selection);
      if (text === "") {
        set(draft$, null);
        set(invalid$, false);
        return;
      }
      const quality = parseQuality(text);
      if (quality === null) {
        set(invalid$, true);
        return;
      }
      set(draft$, null);
      set(invalid$, false);
      if (quality !== (capture.quality ?? defaultCapture.quality)) {
        const operation = set(changeCapture$, { ...capture, quality }, signal);
        set(operationState$, operation);
        await operation;
      }
    },
  );
  const close$ = command(({ set }, cancel: boolean, signal: AbortSignal) => {
    // Consume the draft before menu dismissal can unmount the field without blur.
    const operation = cancel ? Promise.resolve() : set(apply$, "draft", signal);
    set(editing$, false);
    set(reset$);
    return operation;
  });
  return { values$, operation$, begin$, edit$, reset$, apply$, close$ };
}

export type CaptureQualitySignals = ReturnType<
  typeof createCaptureQualitySignals
>;
