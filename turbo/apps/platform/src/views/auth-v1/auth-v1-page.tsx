import { GoogleOneTap, SignIn, SignUp } from "@clerk/react";
import { Loader2 } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { activeRoute$ } from "../../signals/active-route.ts";
import {
  buildAuthModeSwitchUrl,
  buildSignInRedirectUrl,
  buildSignupRedirectUrl,
  resolveAuthBrandContext,
} from "../../signals/auth.ts";
import { hideAppSkeletonOnContentReadyRef$ } from "../../signals/app-skeleton.ts";
import { theme$ } from "../../signals/theme.ts";
import type { AuthV1ClerkSignals } from "../../signals/auth-v1-clerk.ts";
import { AuthV1Layout } from "./auth-v1-layout.tsx";
import { getAuthV1ComponentAppearance } from "./component-appearance.ts";

export type AuthV1PageMode = "sign-in" | "sign-up";

interface AuthV1PageProps {
  readonly mode: AuthV1PageMode;
  readonly signals: AuthV1ClerkSignals;
}

function AuthLoadingFallback() {
  const { t } = useTranslation();
  return (
    <div
      className="flex w-full max-w-md items-center justify-center py-16 text-muted-foreground"
      data-testid="clerk-auth-loading"
      role="status"
    >
      <Loader2 className="animate-spin" size={20} aria-hidden="true" />
      <span className="sr-only">
        {t(($) => {
          return $.auth.loading;
        })}
      </span>
    </div>
  );
}

function AuthV1PageContent({ mode }: Pick<AuthV1PageProps, "mode">) {
  // Once this page commits, Clerk's public fallback owns form loading.
  const authPageMountRef = useSet(hideAppSkeletonOnContentReadyRef$);
  const activeRoute = useGet(activeRoute$);
  const theme = useGet(theme$);
  const authBrand = resolveAuthBrandContext();

  if (mode === "sign-in") {
    const redirectUrl = buildSignInRedirectUrl(
      location.search,
      undefined,
      location.hash,
    );
    const signInUrl = buildAuthModeSwitchUrl(
      "/sign-in",
      location.search,
      undefined,
      location.hash,
    );
    const signUpUrl = buildAuthModeSwitchUrl(
      "/sign-up",
      location.search,
      undefined,
      location.hash,
    );

    return (
      <>
        {activeRoute === "signIn" && (
          <GoogleOneTap
            signInForceRedirectUrl={redirectUrl}
            signUpForceRedirectUrl={redirectUrl}
          />
        )}
        <AuthV1Layout authBrand={authBrand}>
          <div
            className="relative z-10 flex w-[var(--okou-auth-card-page-width)] max-w-[var(--okou-auth-card-max-width)] shrink-0 flex-col gap-3"
            data-testid="app-sign-in"
            ref={authPageMountRef}
          >
            <SignIn
              appearance={getAuthV1ComponentAppearance(authBrand, theme)}
              fallback={<AuthLoadingFallback />}
              fallbackRedirectUrl={redirectUrl}
              forceRedirectUrl={redirectUrl}
              path="/sign-in"
              routing="path"
              signInUrl={signInUrl}
              signUpUrl={signUpUrl}
            />
          </div>
        </AuthV1Layout>
      </>
    );
  }

  const redirectUrl = buildSignupRedirectUrl(
    location.search,
    undefined,
    location.hash,
  );
  const signInUrl = buildAuthModeSwitchUrl(
    "/sign-in",
    location.search,
    undefined,
    location.hash,
  );

  return (
    <AuthV1Layout authBrand={authBrand}>
      <div
        className="relative z-10 flex w-[var(--okou-auth-card-page-width)] max-w-[var(--okou-auth-card-max-width)] shrink-0 flex-col gap-3"
        data-testid="app-sign-up"
        ref={authPageMountRef}
      >
        <SignUp
          appearance={getAuthV1ComponentAppearance(authBrand, theme)}
          fallback={<AuthLoadingFallback />}
          fallbackRedirectUrl={redirectUrl}
          forceRedirectUrl={redirectUrl}
          path="/sign-up"
          routing="path"
          signInUrl={signInUrl}
        />
      </div>
    </AuthV1Layout>
  );
}

/**
 * The app root owns the single Clerk provider, so this route only waits for the
 * runtime to report readiness before it mounts the hosted forms.
 */
function ClerkRuntimeBoundary({
  children,
  signals,
}: {
  readonly children: ReactNode;
  readonly signals: AuthV1ClerkSignals;
}) {
  const ready = useGet(signals.ready$);
  const attach = useSet(signals.attach$);

  return (
    <>
      <span hidden ref={attach} />
      {ready ? children : null}
    </>
  );
}

export function AuthV1Page({ mode, signals }: AuthV1PageProps) {
  return (
    <ClerkRuntimeBoundary signals={signals}>
      <AuthV1PageContent mode={mode} />
    </ClerkRuntimeBoundary>
  );
}
