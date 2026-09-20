import { OAuthConsent, Show } from "@clerk/react";
import { Loader2 } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { hideAppSkeletonOnContentReadyRef$ } from "../../signals/app-skeleton.ts";
import { resolveAuthBrandContext } from "../../signals/auth.ts";
import { theme$ } from "../../signals/theme.ts";
import { AuthShell } from "../auth/auth-shell.tsx";
import { getClerkOAuthConsentAppearance } from "../auth-v1/clerk-auth-appearance.ts";

function OAuthConsentLoadingFallback() {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center justify-center py-16 text-muted-foreground"
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

export function OAuthConsentPage() {
  const contentReady = useSet(hideAppSkeletonOnContentReadyRef$);
  const theme = useGet(theme$);
  const authBrand = resolveAuthBrandContext();

  return (
    <AuthShell authBrand={authBrand}>
      <Show when="signed-in">
        <div
          className="relative z-10 flex w-[var(--okou-auth-card-page-width)] max-w-[var(--okou-auth-card-max-width)] shrink-0 flex-col gap-3"
          data-testid="app-oauth-consent"
          ref={contentReady}
        >
          <OAuthConsent
            appearance={getClerkOAuthConsentAppearance(
              authBrand.homeUrl,
              theme,
            )}
            fallback={<OAuthConsentLoadingFallback />}
          />
        </div>
      </Show>
    </AuthShell>
  );
}
