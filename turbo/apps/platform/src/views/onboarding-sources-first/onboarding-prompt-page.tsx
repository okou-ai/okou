import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Textarea, cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { runPromptOnboarding$ } from "../../signals/onboarding/onboarding-actions.ts";
import { onboardingMakeConnectorSlugs$ } from "../../signals/onboarding/onboarding-connector-items.ts";
import {
  editOnboardingPrompt$,
  onboardingDraft$,
  selectOnboardingPromptOutput$,
} from "../../signals/onboarding/onboarding-state.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { OnboardingConnectorSetup } from "../onboarding/onboarding-connectors.tsx";
import { ONBOARDING_TEXTAREA_CLASS } from "../onboarding/onboarding-shell.tsx";
import {
  OnboardingCompliance,
  OnboardingSecurityLink,
} from "./onboarding-industry-parts.tsx";
import { useMobileOnboarding } from "../onboarding/use-mobile-onboarding.ts";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { OnboardingOutputFormats } from "./onboarding-output-formats.tsx";
import { LandingFilePreview } from "../prompt-page/landing-file-list.tsx";

/**
 * What the prompt handoff does: the prompt the visitor brought stays editable,
 * recommended tools and those its link names can be connected, and running it
 * completes onboarding before the first request.
 */
function usePromptOnboarding() {
  const draft = useGet(onboardingDraft$);
  const setPrompt = useSet(editOnboardingPrompt$);
  const selectOutput = useSet(selectOnboardingPromptOutput$);
  const [runLoadable, runPrompt] = useLoadableSet(runPromptOnboarding$);
  const pageSignal = useGet(pageSignal$);
  const connectorSlugs = useGet(onboardingMakeConnectorSlugs$);

  const run = (): void => {
    detach(runPrompt(pageSignal), Reason.DomCallback);
  };

  return {
    prompt: draft.prompt,
    output: draft.output,
    setPrompt,
    selectOutput,
    connectorSlugs,
    run,
    busy: runLoadable.state === "loading",
  };
}

/**
 * The prompt handoff in the source-first flow's look. A visitor who brings a
 * prompt skips that flow's questions, so this is their whole onboarding: one
 * step that explains how to tailor the task, connect relevant tools, and
 * choose an output format beside the editable prompt and its controls.
 */
export function OnboardingSourcesFirstPromptPage() {
  const { t } = useTranslation();
  const mobile = useMobileOnboarding();
  const { prompt, output, setPrompt, selectOutput, connectorSlugs, run, busy } =
    usePromptOnboarding();

  const promptInput = (
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
        "min-h-40 resize-none px-4 py-3 leading-[1.625] max-sm:min-h-48 max-sm:text-base",
      )}
    />
  );

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
      mobileTitle={t(($) => {
        return $.onboarding.sourcesFirst.mobile.promptTitle;
      })}
      mobileDescription=""
      mobileFooter={<OnboardingSecurityLink />}
      supplement={<OnboardingCompliance />}
      primaryLabel={t(($) => {
        return mobile
          ? $.onboarding.sourcesFirst.mobile.startTask
          : $.onboarding.common.next;
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
        {promptInput}
        <LandingFilePreview />
        <section
          aria-labelledby="onboarding-prompt-connectors-title"
          className="mt-3 space-y-3"
        >
          <div className="space-y-1">
            <h2
              id="onboarding-prompt-connectors-title"
              className="text-sm font-medium"
            >
              {t(($) => {
                return $.onboarding.sourcesFirst.prompt.connectorsTitle;
              })}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t(($) => {
                return $.onboarding.sourcesFirst.prompt.connectorsDescription;
              })}
            </p>
          </div>
          <OnboardingConnectorSetup
            connectorSlugs={connectorSlugs}
            variant="sheet"
          />
        </section>
        <OnboardingOutputFormats
          output={output}
          onSelect={selectOutput}
          disabled={busy}
        />
      </div>
    </OnboardingStepLayout>
  );
}
