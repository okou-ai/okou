import { OAuthConsent, Show } from "@clerk/react";
import { Loader2 } from "lucide-react";
import { useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { hideAppSkeletonOnContentReadyRef$ } from "../../signals/app-skeleton.ts";

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
  return (
    <main className="flex min-h-full w-full items-center justify-center bg-background p-4">
      <Show when="signed-in">
        <OAuthConsent fallback={<OAuthConsentLoadingFallback />} />
      </Show>
      <span ref={contentReady} hidden />
    </main>
  );
}
