import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Textarea, cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { completeOnboarding$ } from "../../signals/onboarding/onboarding-actions.ts";
import {
  onboardingDraft$,
  updateOnboardingDraft$,
} from "../../signals/onboarding/onboarding-state.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { OnboardingConnectorSetup } from "../onboarding/onboarding-connectors.tsx";
import { useOnboardingNavigation } from "../onboarding/onboarding-navigation.ts";
import { ONBOARDING_TEXTAREA_CLASS } from "../onboarding/onboarding-shell.tsx";
import { OnboardingCompliance } from "./onboarding-industry-parts.tsx";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";

/**
 * What the prompt handoff does: the prompt the visitor brought stays editable,
 * the tools its link names can be connected, and running it completes
 * onboarding before the first request.
 */
function usePromptOnboarding() {
  const draft = useGet(onboardingDraft$);
  const setDraft = useSet(updateOnboardingDraft$);
  const [completeLoadable, complete] = useLoadableSet(completeOnboarding$);
  const searchParams = useGet(searchParams$);
  const pageSignal = useGet(pageSignal$);
  const { runPrompt } = useOnboardingNavigation();
  const template = searchParams.get("template")?.trim() || undefined;
  const connectorSlugs = (searchParams.get("connector") ?? "")
    .split(",")
    .map((value) => {
      return value.trim();
    })
    .filter(Boolean);

  const run = (): void => {
    const redeemCode = searchParams.get("redeemCode")?.trim() || null;
    const completeAndRun = async (): Promise<void> => {
      await complete(redeemCode, pageSignal);
      runPrompt(draft.prompt, template);
    };
    detach(completeAndRun(), Reason.DomCallback);
  };

  return {
    prompt: draft.prompt,
    setPrompt: (prompt: string) => {
      setDraft({ prompt });
    },
    connectorSlugs,
    run,
    busy: completeLoadable.state === "loading",
  };
}

/**
 * The prompt handoff in the source-first flow's look. A visitor who brings a
 * prompt skips that flow's questions, so this is their whole onboarding: one
 * step that introduces Okou as the first question does, the prompt they
 * brought on the sheet, and the tools its link names above it.
 */
export function OnboardingSourcesFirstPromptPage() {
  const { t } = useTranslation();
  const { prompt, setPrompt, connectorSlugs, run, busy } =
    usePromptOnboarding();

  return (
    <OnboardingStepLayout
      currentStep={1}
      totalSteps={1}
      title={t(($) => {
        return $.onboarding.make.promptTitle;
      })}
      description={t(($) => {
        return $.onboarding.sourcesFirst.prompt.intro;
      })}
      trustPoints={[
        t(($) => {
          return $.onboarding.make.promptDescription;
        }),
      ]}
      supplement={<OnboardingCompliance />}
      primaryLabel={t(($) => {
        return $.onboarding.common.next;
      })}
      onPrimary={run}
      primaryDisabled={!prompt.trim()}
      primaryBusy={busy}
    >
      <div className="mx-auto flex w-full max-w-[520px] flex-col gap-3">
        {/* A phone stacks the introduction above the sheet already, so the
            mark would push the prompt further down the first screen. */}
        <div className="flex justify-center pb-6 max-sm:hidden">
          <ProductBrandMark decorative size="hero" />
        </div>
        <OnboardingConnectorSetup
          connectorSlugs={connectorSlugs}
          variant="sheet"
        />
        <Textarea
          id="onboarding-prompt"
          aria-label={t(($) => {
            return $.onboarding.make.promptLabel;
          })}
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
          }}
          className={cn(
            ONBOARDING_TEXTAREA_CLASS,
            "min-h-40 resize-none px-4 py-3 leading-[1.625]",
          )}
        />
      </div>
    </OnboardingStepLayout>
  );
}
