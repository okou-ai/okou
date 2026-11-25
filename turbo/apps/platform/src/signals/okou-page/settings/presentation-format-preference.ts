import { command } from "ccstate";
import type { PresentationOutputFormat } from "@okouai/core/presentation-output-format";

import { presentationOutputFormat$ } from "../presentation-output-format.ts";
import { updateUserPreference$ } from "./user-preferences.ts";

/** Keep the save pending until readers observe the confirmed format. */
export const updatePresentationFormat$ = command(
  async (
    { get, set },
    value: PresentationOutputFormat,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    await set(updateUserPreference$, { presentationFormat: value }, signal);
    signal.throwIfAborted();
    await get(presentationOutputFormat$);
    signal.throwIfAborted();
  },
);
