import { command } from "ccstate";
import type { PresentationOutputFormat } from "@okouai/core/presentation-output-format";
import {
  presentationFormatPreference$,
  presentationOutputFormatEnabled$,
} from "../presentation-output-format.ts";
import { updateUserPreference$ } from "./user-preferences.ts";

export const updatePresentationFormat$ = command(
  async (
    { get, set },
    format: PresentationOutputFormat,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const enabled = await get(presentationOutputFormatEnabled$);
    signal.throwIfAborted();
    if (!enabled) {
      throw new Error("Presentation format preference is unavailable");
    }
    await set(updateUserPreference$, { presentationFormat: format }, signal);
    await get(presentationFormatPreference$);
    signal.throwIfAborted();
  },
);
