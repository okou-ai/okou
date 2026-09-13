import { ClerkProvider as BaseClerkProvider } from "@clerk/react";
import { useGet, useLastResolved } from "ccstate-react";
import type { ReactNode } from "react";
import {
  clerkLocalizationForLocale,
  clerkLocalizations$,
} from "../i18n/clerk-localization.ts";
import { resolvePlatformRuntimeConfig } from "../lib/platform-host.ts";
import {
  clerk$,
  getAllowedAuthRedirectOriginsForCurrentPage,
  resolveAppAuthUrl,
  resolveAppUrl,
} from "../signals/auth.ts";
import { locale$ } from "../signals/locale.ts";
import { theme$ } from "../signals/theme.ts";
import { getAuthV1ProviderAppearance } from "./auth-v1/provider-appearance.ts";

/**
 * The single Clerk provider for the whole app.
 *
 * Clerk accepts `localization` and `appearance` only as global options and
 * pushes them into the runtime from this provider, so components it opens
 * outside the React tree — the hosted Add account dialog above all — follow the
 * selected language only while this is mounted. `@clerk/react` throws on a
 * second provider, so the auth route consumes this one instead of creating its
 * own.
 *
 * Children stay unmounted until the runtime resolves. Mounting them earlier
 * would move the whole tree under the provider once Clerk arrives, and every
 * route already waits for the same runtime before it publishes a page, so the
 * app skeleton covers this gap.
 */
export function ClerkOptionsProvider({ children }: { children: ReactNode }) {
  const clerk = useLastResolved(clerk$);
  const clerkLocalizations = useGet(clerkLocalizations$);
  const locale = useGet(locale$);
  const theme = useGet(theme$);

  if (!clerk) {
    return null;
  }

  const appUrl = resolveAppUrl();
  return (
    <BaseClerkProvider
      Clerk={clerk}
      afterSignOutUrl={resolveAppAuthUrl("/sign-in")}
      allowedRedirectOrigins={getAllowedAuthRedirectOriginsForCurrentPage()}
      appearance={getAuthV1ProviderAppearance(theme)}
      localization={clerkLocalizationForLocale(clerkLocalizations, locale)}
      // The runtime already holds the deferred hosted UI handle from its own
      // `load()`, so this must not request a second download.
      prefetchUI={false}
      publishableKey={resolvePlatformRuntimeConfig().clerkPublishableKey}
      signInFallbackRedirectUrl={appUrl}
      signInUrl={resolveAppAuthUrl("/sign-in")}
      signUpFallbackRedirectUrl={appUrl}
      signUpUrl={resolveAppAuthUrl("/sign-up")}
    >
      {children}
    </BaseClerkProvider>
  );
}
