import { command } from "ccstate";
import type { SendMode } from "@okouai/api-contracts/contracts/user-preferences";

import { sendMode$ } from "../../send-mode.ts";
import { updateUserPreference$ } from "./user-preferences.ts";

/**
 * Update send mode preference. After saving, await the confirmed value so the
 * UI never flashes back to the old value before the signal updates.
 */
export const updateSendMode$ = command(
  async ({ get, set }, value: SendMode, signal: AbortSignal) => {
    signal.throwIfAborted();
    await set(updateUserPreference$, { sendMode: value }, signal);
    signal.throwIfAborted();
    await get(sendMode$);
    signal.throwIfAborted();
  },
);
