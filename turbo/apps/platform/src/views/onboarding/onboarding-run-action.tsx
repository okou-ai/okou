import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { completeOnboarding$ } from "../../signals/onboarding/onboarding-actions.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { OnboardingFooter } from "./onboarding-shell.tsx";
import { useOnboardingNavigation } from "./onboarding-navigation.ts";

export function OnboardingRunAction({
  prompt,
  template,
  disabled = false,
  runLabel,
  onBack,
}: {
  readonly prompt: string;
  readonly template?: string;
  readonly disabled?: boolean;
  readonly runLabel?: string;
  readonly onBack: () => void;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const searchParams = useGet(searchParams$);
  const [completeLoadable, complete] = useLoadableSet(completeOnboarding$);
  const { runPrompt } = useOnboardingNavigation();
  const redeemCode = searchParams.get("redeemCode")?.trim() || null;
  const completeAndRun = async (): Promise<void> => {
    await complete(redeemCode, pageSignal);
    runPrompt(prompt, template);
  };

  return (
    <OnboardingFooter
      onBack={onBack}
      onPrimary={() => {
        detach(completeAndRun(), Reason.DomCallback);
      }}
      primaryLabel={
        runLabel ??
        t(($) => {
          return $.onboarding.runAction.runNow;
        })
      }
      primaryDisabled={disabled || !prompt.trim()}
      busy={completeLoadable.state === "loading"}
    />
  );
}
