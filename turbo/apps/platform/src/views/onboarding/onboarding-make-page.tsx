import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Textarea, cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { completeOnboarding$ } from "../../signals/onboarding/onboarding-actions.ts";
import {
  ONBOARDING_CHECKOUT_STATE_PARAM,
  onboardingDraft$,
  updateOnboardingDraft$,
  type OnboardingChoice,
} from "../../signals/onboarding/onboarding-state.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { searchParams$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import type { TemplatePickerEntryCategory } from "../../signals/okou-page/template-picker-entry.ts";
import { platformStaticAssetUrl } from "../../lib/static-assets.ts";
import { OnboardingConnectorSetup } from "./onboarding-connectors.tsx";
import { onboardingMakeOptions } from "./onboarding-data.ts";
import { useOnboardingNavigation } from "./onboarding-navigation.ts";
import {
  ONBOARDING_TEXTAREA_CLASS,
  OnboardingFooter,
  OnboardingShell,
} from "./onboarding-shell.tsx";

const BRANCH_STATE_PARAMS = [
  "category",
  "workflow",
  "template",
  "onboarding_billing",
  "onboarding_billing_session_id",
  "onboarding_note",
  "onboarding_template",
  ONBOARDING_CHECKOUT_STATE_PARAM,
] as const;

const SLACK_ICON_URL = platformStaticAssetUrl(
  "views/zero-page/components/settings/icons/slack-198390069136.svg?v=568fa471",
);

function choicePath(choice: OnboardingChoice) {
  switch (choice) {
    case "slack": {
      return ROUTES.works;
    }
    case "workflow": {
      return ROUTES.onboardingWorkflowPicker;
    }
    case "presentation": {
      return ROUTES.home;
    }
    case "images": {
      return ROUTES.home;
    }
    case "website": {
      return ROUTES.home;
    }
    case "explore": {
      return ROUTES.home;
    }
  }
}

function choiceTemplatePickerCategory(
  choice: OnboardingChoice,
): TemplatePickerEntryCategory | null {
  switch (choice) {
    case "presentation": {
      return "slides";
    }
    case "images": {
      return "illustration";
    }
    case "website": {
      return "website";
    }
    case "slack":
    case "workflow":
    case "explore": {
      return null;
    }
  }
}

function PromptOnboarding() {
  const { t } = useTranslation();
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

  const handleRun = (): void => {
    const redeemCode = searchParams.get("redeemCode")?.trim() || null;
    const completeAndRun = async (): Promise<void> => {
      await complete(redeemCode, pageSignal);
      runPrompt(draft.prompt, template);
    };
    detach(completeAndRun(), Reason.DomCallback);
  };

  return (
    <OnboardingShell
      currentStep={1}
      totalSteps={1}
      title={t(($) => {
        return $.onboarding.make.promptTitle;
      })}
      description={t(($) => {
        return $.onboarding.make.promptDescription;
      })}
      footer={
        <OnboardingFooter
          onPrimary={handleRun}
          primaryLabel={t(($) => {
            return $.onboarding.common.next;
          })}
          primaryDisabled={!draft.prompt.trim()}
          busy={completeLoadable.state === "loading"}
        />
      }
    >
      <OnboardingConnectorSetup
        connectorSlugs={connectorSlugs}
        variant="prompt"
      />
      <Textarea
        id="onboarding-prompt"
        aria-label={t(($) => {
          return $.onboarding.make.promptLabel;
        })}
        value={draft.prompt}
        onChange={(event) => {
          setDraft({ prompt: event.target.value });
        }}
        className={cn(
          ONBOARDING_TEXTAREA_CLASS,
          "mt-6 min-h-28 resize-none px-4 py-3 leading-[1.625]",
        )}
      />
    </OnboardingShell>
  );
}

function SlackChoiceIllustration() {
  return (
    <span
      data-testid="onboarding-slack-illustration"
      aria-hidden="true"
      className="relative block h-10 w-10 shrink-0"
    >
      <svg viewBox="0 0 40 40" className="absolute inset-0 size-full">
        <path
          fill="#3EB7B8"
          d="M5.3 10.7C6.7 5.4 12.1 3.4 18 4.2c5.8.8 13.7 1.8 16.2 6.8 2.7 5.4.5 14.7-3 19.5-3.7 5-12.6 5.6-18.3 2.8-5.6-2.8-10.1-7.9-9.3-13.5.4-3.3.9-6.2 1.7-9.1Z"
        />
        <path
          fill="white"
          stroke="#758087"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.2"
          d="M10.4 9.3c4.4-3.4 12.4-3.1 17 .1 5 3.4 6.2 10.5 3.2 15.3-3 4.8-9.8 7.2-15.2 5.5l-6.8 3.9 1.6-6.1c-5.1-4-4.9-14.8.2-18.7Z"
        />
      </svg>
      <img
        data-testid="onboarding-slack-icon"
        src={SLACK_ICON_URL}
        alt=""
        className="absolute inset-0 size-full object-contain"
      />
    </span>
  );
}

export function OnboardingMakePage() {
  const { t } = useTranslation();
  const draft = useGet(onboardingDraft$);
  const setDraft = useSet(updateOnboardingDraft$);
  const [completeLoadable, complete] = useLoadableSet(completeOnboarding$);
  const searchParams = useGet(searchParams$);
  const pageSignal = useGet(pageSignal$);
  const { navigateTo } = useOnboardingNavigation();

  if (searchParams.has("prompt")) {
    return <PromptOnboarding />;
  }

  const handleChoice = (choice: OnboardingChoice): void => {
    setDraft({ choice });
    const templatePickerCategory = choiceTemplatePickerCategory(choice);
    if (
      choice === "slack" ||
      templatePickerCategory !== null ||
      choice === "explore"
    ) {
      const redeemCode = searchParams.get("redeemCode")?.trim() || null;
      const completeAndOpenDestination = async (): Promise<void> => {
        await complete(redeemCode, pageSignal);
        navigateTo(choicePath(choice), {
          preserve: false,
          replace: true,
          updates:
            templatePickerCategory === null
              ? undefined
              : { templatePicker: templatePickerCategory },
        });
      };
      detach(completeAndOpenDestination(), Reason.DomCallback);
      return;
    }
    navigateTo(choicePath(choice), {
      remove: BRANCH_STATE_PARAMS,
      updates: { choice },
    });
  };

  return (
    <OnboardingShell
      currentStep={1}
      totalSteps={3}
      title={t(($) => {
        return $.onboarding.make.title;
      })}
      description={t(($) => {
        return $.onboarding.make.description;
      })}
    >
      <div
        className="grid grid-cols-1 gap-3 pb-12 sm:grid-cols-2 sm:pb-0"
        role="group"
        aria-label={t(($) => {
          return $.onboarding.make.projectTypeLabel;
        })}
      >
        {onboardingMakeOptions(t).map((option) => {
          const selected = draft.choice === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                handleChoice(option.id);
              }}
              disabled={completeLoadable.state === "loading"}
              aria-busy={selected && completeLoadable.state === "loading"}
              className={cn(
                "flex min-h-[72px] items-center gap-3 rounded-xl border bg-background px-4 py-3.5 text-left shadow-[var(--okou-card-shadow)] transition-colors sm:px-6 sm:py-[15px]",
                "hover:border-primary/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                selected ? "border-primary" : "border-border",
                option.id === "explore" && "sm:col-span-2",
              )}
            >
              {option.imageUrl ? (
                <img
                  src={option.imageUrl}
                  alt=""
                  width={48}
                  height={48}
                  className="h-10 w-10 shrink-0 object-contain"
                />
              ) : (
                <SlackChoiceIllustration />
              )}
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {option.title}
                </span>
                <span className="mt-0.5 block text-sm leading-5 text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </OnboardingShell>
  );
}
