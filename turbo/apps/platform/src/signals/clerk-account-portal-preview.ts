import { buildAccountsBaseUrl } from "@clerk/shared/buildAccountsBaseUrl";
import type { BrowserClerk } from "@clerk/shared/types";
import { command } from "ccstate";
import { resolvePlatformEnvironment } from "../lib/platform-host.ts";
import { buildSignInRedirectUrl, buildSignupRedirectUrl } from "./auth.ts";
import { sessionStorageSignals } from "./external/session-storage.ts";

// Disposable PR comparison fixture, not a production rollout switch. Keeping
// the choice in this tab also exercises the normal sign-out return to /sign-in.
const previewMode$ = sessionStorageSignals("okou:account-portal-preview");

export const redirectToClerkAccountPortalPreview$ = command(
  ({ get, set }, clerk: BrowserClerk, mode: "sign-in" | "sign-up"): boolean => {
    if (
      resolvePlatformEnvironment() !== "preview" ||
      clerk.instanceType !== "development"
    ) {
      return false;
    }

    const params = new URLSearchParams(location.search);
    const modeParam = params.get("auth_ui");
    if (modeParam === "embedded") {
      set(previewMode$.clear$);
    } else if (modeParam === "portal") {
      set(previewMode$.set$, "portal");
    }
    if (get(previewMode$.get$) !== "portal") {
      return false;
    }

    const buildRedirectUrl =
      mode === "sign-in" ? buildSignInRedirectUrl : buildSignupRedirectUrl;
    const redirectUrl = buildRedirectUrl(
      location.search,
      undefined,
      location.hash,
    );
    const portalUrl = new URL(
      location.pathname,
      buildAccountsBaseUrl(clerk.frontendApi),
    );
    portalUrl.searchParams.set("redirect_url", redirectUrl);
    // Forward Clerk's documented prefills and invitation state, never raw
    // redirect overrides or the Preview Protection credential to its origin.
    for (const key of [
      "email_address",
      "phone_number",
      "username",
      "first_name",
      "last_name",
      "__clerk_ticket",
      "__clerk_status",
    ]) {
      const value = params.get(key);
      if (value !== null) {
        portalUrl.searchParams.set(key, value);
      }
    }

    window.location.replace(clerk.buildUrlWithAuth(portalUrl.toString()));
    return true;
  },
);
