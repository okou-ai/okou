import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { sourcesFirstSkillImportSignals$ } from "../../signals/onboarding/onboarding-skill-import.ts";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";
import {
  SkillImportResults,
  SkillImportPanel,
  SkillImportCopyButton,
} from "../skill-import/skill-import-panel.tsx";
import { useMobileOnboarding } from "../onboarding/use-mobile-onboarding.ts";
import {
  sourcesFirstUi$,
  updateSourcesFirstUi$,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";

export function OnboardingSkillsPage() {
  const { t } = useTranslation();
  const mobile = useMobileOnboarding();
  const ui = useGet(sourcesFirstUi$);
  const updateUi = useSet(updateSourcesFirstUi$);
  const flow = useSourcesFirstFlow("skills");
  const signals = useGet(sourcesFirstSkillImportSignals$);
  const results = useLoadable(signals.imported$);
  const session = useLoadable(signals.session$);
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
      mobileTitle={
        imported
          ? t(($) => {
              return $.onboarding.sourcesFirst.skills.importedTitle;
            })
          : t(($) => {
              return $.onboarding.sourcesFirst.mobile.skillsTitle;
            })
      }
      mobileDescription={
        imported
          ? ""
          : t(
              ($) => {
                return $.onboarding.sourcesFirst.mobile.skillsCopy;
              },
              {
                provider: providerName,
              },
            )
      }
      primaryAction={
        mobile && !imported ? (
          <SkillImportCopyButton
            key={session.state === "hasData" ? session.data.id : "preparing"}
            copyPrompt$={signals.copyPrompt$}
            disabled={session.state !== "hasData"}
            primary
            label={t(($) => {
              return $.onboarding.sourcesFirst.mobile.copyImportPrompt;
            })}
            className="h-auto min-h-12 w-full whitespace-normal bg-foreground py-3 text-base text-background hover:bg-foreground-hover active:bg-foreground-pressed"
          />
        ) : undefined
      }
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
          compact={mobile}
          promptToggle={
            mobile
              ? {
                  shown: ui.importPromptShown,
                  setShown: (shown) => {
                    updateUi({ importPromptShown: shown });
                  },
                }
              : undefined
          }
        />
        <SkillImportResults signals={signals} />
      </div>
    </OnboardingStepLayout>
  );
}
