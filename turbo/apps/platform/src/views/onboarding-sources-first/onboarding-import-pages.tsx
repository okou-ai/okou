import { useGet, useLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { sourcesFirstSkillImportSignals$ } from "../../signals/onboarding/onboarding-skill-import.ts";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";
import {
  SkillImportResults,
  SkillImportPanel,
} from "../skill-import/skill-import-panel.tsx";

export function OnboardingSkillsPage() {
  const { t } = useTranslation();
  const flow = useSourcesFirstFlow("skills");
  const signals = useGet(sourcesFirstSkillImportSignals$);
  const results = useLoadable(signals.imported$);
  const provider = flow.draft.provider;
  const providerName =
    provider === "codex"
      ? t(($) => {
          return $.onboarding.sourcesFirst.subscription.codex;
        })
      : provider === "claudeCode"
        ? t(($) => {
            return $.onboarding.sourcesFirst.subscription.claudeCode;
          })
        : null;

  if (provider === null || providerName === null) {
    return null;
  }
  const imported = results.state === "hasData" && results.data.length > 0;

  return (
    <OnboardingStepLayout
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={
        imported
          ? t(($) => {
              return $.onboarding.sourcesFirst.skills.importedTitle;
            })
          : t(($) => {
              return $.onboarding.sourcesFirst.skills.title;
            })
      }
      description={t(
        ($) => {
          return $.onboarding.sourcesFirst.skills.copy;
        },
        { provider: providerName },
      )}
      primaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.continue;
      })}
      // Continue waits for an imported skill; Not now leaves without one.
      onPrimary={flow.goNext}
      primaryDisabled={!imported}
      secondaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.notNow;
      })}
      onSecondary={flow.goSkip}
      onBack={flow.goBack}
    >
      <div className="mx-auto flex w-full max-w-[600px] flex-col gap-6">
        <SkillImportPanel
          signals={signals}
          provider={provider}
          providerName={providerName}
        />
        <SkillImportResults signals={signals} />
      </div>
    </OnboardingStepLayout>
  );
}
