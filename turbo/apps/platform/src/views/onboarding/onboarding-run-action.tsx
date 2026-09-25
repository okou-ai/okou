import { useGet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { billingStatusAsync$ } from "../../signals/okou-page/billing.ts";
import {
  completeOnboarding$,
  prepareOnboardingVideoRun$,
} from "../../signals/onboarding/onboarding-actions.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { OnboardingFooter } from "./onboarding-shell.tsx";
import { useOnboardingNavigation } from "./onboarding-navigation.ts";

export function OnboardingRunAction({
  prompt,
  template,
  templateSlug,
  requiresPaidPlan = false,
  disabled = false,
  runLabel,
  onBack,
}: {
  readonly prompt: string;
  readonly template?: string;
  readonly templateSlug?: string;
  readonly requiresPaidPlan?: boolean;
  readonly disabled?: boolean;
  readonly runLabel?: string;
  readonly onBack: () => void;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const searchParams = useGet(searchParams$);
  const billingLoadable = useLastLoadable(billingStatusAsync$);
  const [completeLoadable, complete] = useLoadableSet(completeOnboarding$);
  const [videoLoadable, prepareVideo] = useLoadableSet(
    prepareOnboardingVideoRun$,
  );
  const { runPrompt } = useOnboardingNavigation();
  const redeemCode = searchParams.get("redeemCode")?.trim() || null;
  const paidPlan =
    billingLoadable.state === "hasData" &&
    (billingLoadable.data.tier === "pro" ||
      billingLoadable.data.tier === "team");
  const busy =
    completeLoadable.state === "loading" || videoLoadable.state === "loading";
  const label = requiresPaidPlan
    ? billingLoadable.state === "loading"
      ? t(($) => {
          return $.onboarding.runAction.checkingPlan;
        })
      : paidPlan || redeemCode
        ? t(($) => {
            return $.onboarding.runAction.runNow;
          })
        : t(($) => {
            return $.onboarding.runAction.upgradePro;
          })
    : (runLabel ??
      t(($) => {
        return $.onboarding.runAction.runNow;
      }));

  const completeAndRun = async (): Promise<void> => {
    await complete(redeemCode, pageSignal);
    runPrompt(prompt, template);
  };

  const prepareVideoAndRun = async (): Promise<void> => {
    const result = await prepareVideo(
      {
        templateId: template ?? "",
        templateSlug: templateSlug ?? "",
      },
      pageSignal,
    );
    if (result === "run") {
      await completeAndRun();
    }
  };

  const handleRun = (): void => {
    if (!requiresPaidPlan || redeemCode) {
      detach(completeAndRun(), Reason.DomCallback);
      return;
    }

    detach(prepareVideoAndRun(), Reason.DomCallback);
  };

  return (
    <OnboardingFooter
      onBack={onBack}
      onPrimary={handleRun}
      primaryLabel={label}
      primaryDisabled={disabled || !prompt.trim()}
      busy={busy}
    />
  );
}
