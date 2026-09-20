import { command } from "ccstate";
import { createElement } from "react";
import { enableViewportZoom } from "../lib/viewport-pinch.ts";
import { OAuthConsentPage } from "../views/oauth-consent-page/oauth-consent-page.tsx";
import { AuthV1LoadError } from "../views/auth-v1/auth-v1-load-error.tsx";
import { clerk$, clerkUser$, ensureClerkUiLoaded$ } from "./auth.ts";
import { logger } from "./log.ts";
import { updatePage$ } from "./react-router.ts";
import { settle } from "./utils.ts";

const L = logger("OAuthConsent");

export const setupOAuthConsentPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    enableViewportZoom(signal);
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const user = await get(clerkUser$);
    signal.throwIfAborted();

    if (!user) {
      window.location.assign(
        clerk.buildSignInUrl({ redirectUrl: window.location.href }),
      );
      return;
    }

    const uiLoad = await settle(set(ensureClerkUiLoaded$, signal), signal);
    if (!uiLoad.ok) {
      L.error("Clerk OAuth consent UI failed to load", uiLoad.error);
      set(updatePage$, createElement(AuthV1LoadError));
      return;
    }

    set(updatePage$, createElement(OAuthConsentPage));
  },
);
