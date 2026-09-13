import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../i18n/index.ts";
import { enableViewportZoom } from "../lib/viewport-pinch.ts";
import {
  AuthV1Page,
  type AuthV1PageMode,
} from "../views/auth-v1/auth-v1-page.tsx";
import {
  clerk$,
  ensureClerkUiLoaded$,
  resolveAuthBrandContext,
} from "./auth.ts";
import { updateDocumentTitle$ } from "./document-title.ts";
import { updatePage$ } from "./react-router.ts";
import { AuthV1LoadError } from "../views/auth-v1/auth-v1-load-error.tsx";
import { logger } from "./log.ts";
import { settle } from "./utils.ts";
import { createAuthV1ClerkSignals } from "./auth-v1-clerk.ts";

const L = logger("AuthV1");

function setupAuthV1Page(mode: AuthV1PageMode) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    enableViewportZoom(signal);
    const authBrand = resolveAuthBrandContext();
    set(
      updateDocumentTitle$,
      mode === "sign-in"
        ? i18n.t(($) => {
            return $.auth.documentTitles.signIn;
          })
        : i18n.t(($) => {
            return $.auth.documentTitles.signUp;
          }),
      authBrand.brandName,
    );
    // The app runtime owns initialization. Mounting the external React UI only
    // after readiness lets its provider reuse the loaded instance directly.
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    // The optional hosted UI can fail before a form exists, so `settle` keeps
    // cancellation propagating while this route offers a visible reload.
    const uiLoad = await settle(set(ensureClerkUiLoaded$, signal), signal);
    if (!uiLoad.ok) {
      L.error("Clerk UI failed to load", uiLoad.error);
      set(updatePage$, createElement(AuthV1LoadError));
      return;
    }
    const signals = createAuthV1ClerkSignals(clerk);
    set(updatePage$, createElement(AuthV1Page, { mode, signals }));
  });
}

export const setupSignInV1Page$ = setupAuthV1Page("sign-in");
export const setupSignUpV1Page$ = setupAuthV1Page("sign-up");
