import { command } from "ccstate";

import { getClerkAuthAppearance } from "../views/auth-v1/clerk-auth-appearance.ts";
import {
  clerk$,
  ensureClerkUiLoaded$,
  resolveAuthBrandContext,
} from "./auth.ts";
import { theme$ } from "./theme.ts";

/** Open Clerk's hosted account switcher without leaving the active app page. */
export const openClerkAddAccount$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    await set(ensureClerkUiLoaded$, signal);
    signal.throwIfAborted();
    await clerk.openSignIn({
      appearance: getClerkAuthAppearance(
        resolveAuthBrandContext().homeUrl,
        get(theme$),
      ),
      fallbackRedirectUrl: "/",
      forceRedirectUrl: "/",
    });
    signal.throwIfAborted();
  },
);
