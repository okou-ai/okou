import { Button, buttonVariants } from "@okouai/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  automaticOnboarding$,
  retryAutomaticOnboarding$,
} from "../../signals/onboarding/onboarding-actions.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { searchParams$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { BrandedErrorPage } from "../components/branded-error-page.tsx";
import { LoadingSkeleton } from "../components/loading-skeleton.tsx";
import { Link } from "../router/link.tsx";

export function OnboardingAutomaticPage() {
  const { t } = useTranslation();
  const operation = useLoadable(automaticOnboarding$);
  const retry = useSet(retryAutomaticOnboarding$);
  const signal = useGet(pageSignal$);
  const params = new URLSearchParams(useGet(searchParams$));
  params.delete("skipOnboarding");
  if (operation.state === "hasError") {
    const title = t(($) => {
      return $.shared.errorBoundary.title;
    });
    return (
      <BrandedErrorPage
        title={title}
        description={
          operation.error instanceof Error ? operation.error.message : title
        }
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant="neutral"
            onClick={() => {
              detach(retry(signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.artifacts.actions.retry;
            })}
          </Button>
          <Link
            pathname={ROUTES.onboarding}
            options={{ searchParams: params }}
            className={buttonVariants({ variant: "quiet" })}
          >
            {t(($) => {
              return $.onboarding.autoComplete.continueManually;
            })}
          </Link>
        </div>
      </BrandedErrorPage>
    );
  }
  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-md">
        <LoadingSkeleton
          label={t(($) => {
            return $.onboarding.autoComplete.title;
          })}
        />
      </div>
    </main>
  );
}
