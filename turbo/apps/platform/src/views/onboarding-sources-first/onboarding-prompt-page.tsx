import { Textarea, cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { OnboardingConnectorSetup } from "../onboarding/onboarding-connectors.tsx";
import { usePromptOnboarding } from "../onboarding/onboarding-make-page.tsx";
import { ONBOARDING_TEXTAREA_CLASS } from "../onboarding/onboarding-shell.tsx";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";

/**
 * The prompt handoff in the source-first flow's look. A visitor who brings a
 * prompt skips that flow's questions, so this is their whole onboarding: one
 * step, the prompt they brought on the sheet, and the tools its link names
 * above it.
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
        return $.onboarding.make.promptDescription;
      })}
      primaryLabel={t(($) => {
        return $.onboarding.common.next;
      })}
      onPrimary={run}
      primaryDisabled={!prompt.trim()}
      primaryBusy={busy}
    >
      <div className="mx-auto flex w-full max-w-[520px] flex-col gap-3">
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
