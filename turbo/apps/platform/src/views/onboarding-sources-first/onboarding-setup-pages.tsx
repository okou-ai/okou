import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { Button, Input, RadioGroup } from "@okouai/ui";
import {
  nextSourcesFirstStep,
  sourcesFirstUi$,
  updateSourcesFirstDraft$,
  updateSourcesFirstUi$,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";
import {
  INDUSTRY_IDS,
  type IndustryId,
} from "./onboarding-sources-first-data.ts";
import {
  OnboardingChoiceCard,
  OnboardingIllustration,
  OnboardingPanel,
  OnboardingPosterCard,
  ProductMark,
} from "./onboarding-step-parts.tsx";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";

export function OnboardingIndustryPage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const flow = useSourcesFirstFlow("industry");

  return (
    <OnboardingStepLayout
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={t(($) => {
        return $.onboarding.sourcesFirst.industry.title;
      })}
      description={t(($) => {
        return $.onboarding.sourcesFirst.industry.copy;
      })}
      primaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.continue;
      })}
      onPrimary={flow.goNext}
      primaryDisabled={flow.draft.industry === null}
      onBack={flow.goBack}
    >
      <RadioGroup
        value={flow.draft.industry ?? ""}
        onValueChange={(value) => {
          updateDraft({ industry: value as IndustryId });
        }}
        className="grid gap-3 sm:grid-cols-2"
      >
        {INDUSTRY_IDS.map((id) => {
          return (
            <OnboardingChoiceCard
              key={id}
              value={id}
              selected={flow.draft.industry === id}
              title={t(($) => {
                return $.onboarding.sourcesFirst.industries[id].name;
              })}
              description={t(($) => {
                return $.onboarding.sourcesFirst.industries[id].summary;
              })}
            />
          );
        })}
      </RadioGroup>
    </OnboardingStepLayout>
  );
}

const TEAM_POINT_IDS = ["workspace", "accounts", "workflows"] as const;

/** What joining actually gives a teammate, until there is an invite to show. */
function TeamPoints() {
  const { t } = useTranslation();

  return (
    <ul className="flex flex-1 flex-col justify-center gap-3 border-t border-border/60 px-5 py-4">
      {TEAM_POINT_IDS.map((id) => {
        return (
          <li key={id} className="flex items-start gap-2.5">
            <Check
              size={16}
              className="mt-0.5 shrink-0 text-emerald-600"
              aria-hidden="true"
            />
            <span className="text-sm leading-5 text-muted-foreground">
              {t(($) => {
                return $.onboarding.sourcesFirst.team.points[id];
              })}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The invitees already sent, under the form that sent them. */
function InvitedList({ invites }: { readonly invites: readonly string[] }) {
  const { t } = useTranslation();

  return (
    <div className="border-t border-border/60">
      {invites.map((invitee) => {
        return (
          <div
            key={invitee}
            className="flex items-center gap-3 border-t border-border/60 px-5 py-3.5 first:border-t-0"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">
              {invitee.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {invitee}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Check size={14} aria-hidden="true" />
              {t(($) => {
                return $.onboarding.sourcesFirst.team.invited;
              })}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function OnboardingTeamPage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const flow = useSourcesFirstFlow("team");
  const ui = useGet(sourcesFirstUi$);
  const updateUi = useSet(updateSourcesFirstUi$);

  const invite = (): void => {
    const value = ui.inviteEmail.trim();
    if (!value || flow.draft.invites.includes(value)) {
      return;
    }
    updateDraft({ invites: [...flow.draft.invites, value] });
    updateUi({ inviteEmail: "" });
  };

  return (
    <OnboardingStepLayout
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={t(($) => {
        return $.onboarding.sourcesFirst.team.title;
      })}
      description={t(($) => {
        return $.onboarding.sourcesFirst.team.copy;
      })}
      primaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.continue;
      })}
      onPrimary={flow.goNext}
      secondaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.notNow;
      })}
      onSecondary={flow.goNext}
      onBack={flow.goBack}
    >
      <OnboardingPanel
        title={t(($) => {
          return $.onboarding.sourcesFirst.team.panelTitle;
        })}
        description={t(($) => {
          return $.onboarding.sourcesFirst.team.note;
        })}
      >
        <div className="px-5 py-4">
          <label
            htmlFor="onboarding-invite-email"
            className="block text-sm font-medium text-foreground"
          >
            {t(($) => {
              return $.onboarding.sourcesFirst.team.label;
            })}
          </label>
          <div className="mt-2 flex gap-2">
            <Input
              id="onboarding-invite-email"
              type="email"
              autoComplete="off"
              value={ui.inviteEmail}
              placeholder={t(($) => {
                return $.onboarding.sourcesFirst.team.placeholder;
              })}
              onChange={(event) => {
                updateUi({ inviteEmail: event.target.value });
              }}
            />
            <Button type="button" onClick={invite}>
              {t(($) => {
                return $.onboarding.sourcesFirst.team.invite;
              })}
            </Button>
          </div>
        </div>
        {flow.draft.invites.length > 0 ? (
          <InvitedList invites={flow.draft.invites} />
        ) : (
          <TeamPoints />
        )}
      </OnboardingPanel>
    </OnboardingStepLayout>
  );
}

export function OnboardingExperiencePage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const flow = useSourcesFirstFlow("experience");
  const experienced = flow.draft.experienced;

  // The answer decides the branch, so the next step is resolved from the
  // answer itself instead of the one this render was built from.
  const goNext = (): void => {
    const next = nextSourcesFirstStep("experience", flow.flow, experienced);
    if (next) {
      flow.goTo(next);
    }
  };

  return (
    <OnboardingStepLayout
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={t(($) => {
        return $.onboarding.sourcesFirst.experience.title;
      })}
      description={t(($) => {
        return $.onboarding.sourcesFirst.experience.copy;
      })}
      primaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.continue;
      })}
      onPrimary={goNext}
      primaryDisabled={experienced === null}
      onBack={flow.goBack}
    >
      <RadioGroup
        value={experienced === null ? "" : experienced ? "yes" : "no"}
        onValueChange={(value) => {
          updateDraft({ experienced: value === "yes" });
        }}
        className="grid gap-5 sm:grid-cols-2"
      >
        <OnboardingPosterCard
          value="yes"
          selected={experienced === true}
          mark={
            <OnboardingIllustration name="experienced" alt="" size="poster" />
          }
          title={t(($) => {
            return $.onboarding.sourcesFirst.experience.yes;
          })}
          description={t(($) => {
            return $.onboarding.sourcesFirst.experience.yesCopy;
          })}
        />
        <OnboardingPosterCard
          value="no"
          selected={experienced === false}
          mark={<OnboardingIllustration name="new" alt="" size="poster" />}
          title={t(($) => {
            return $.onboarding.sourcesFirst.experience.no;
          })}
          description={t(($) => {
            return $.onboarding.sourcesFirst.experience.noCopy;
          })}
        />
      </RadioGroup>
    </OnboardingStepLayout>
  );
}

export function OnboardingSubscriptionPage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const flow = useSourcesFirstFlow("subscription");
  const provider = flow.draft.provider;

  const connectAndContinue = (): void => {
    // Frontend pass: the personal model-provider connect flow is wired in the
    // follow-up that adds the onboarding endpoints.
    updateDraft({ providerConnected: true });
    flow.goNext();
  };

  return (
    <OnboardingStepLayout
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={t(($) => {
        return $.onboarding.sourcesFirst.subscription.title;
      })}
      description={t(($) => {
        return $.onboarding.sourcesFirst.subscription.copy;
      })}
      primaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.continue;
      })}
      onPrimary={connectAndContinue}
      primaryDisabled={provider === null}
      secondaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.skip;
      })}
      onSecondary={flow.goNext}
      onBack={flow.goBack}
    >
      <RadioGroup
        value={provider ?? ""}
        onValueChange={(value) => {
          updateDraft({
            provider: value === "codex" ? "codex" : "claudeCode",
            providerConnected: false,
          });
        }}
        className="grid gap-5 sm:grid-cols-2"
      >
        <OnboardingPosterCard
          value="codex"
          selected={provider === "codex"}
          mark={
            <ProductMark name="openai" alt="" size="poster" invertInDarkMode />
          }
          title={t(($) => {
            return $.onboarding.sourcesFirst.subscription.codex;
          })}
          description={t(($) => {
            return $.onboarding.sourcesFirst.subscription.rowCopy;
          })}
        />
        <OnboardingPosterCard
          value="claudeCode"
          selected={provider === "claudeCode"}
          mark={<ProductMark name="anthropic" alt="" size="poster" />}
          title={t(($) => {
            return $.onboarding.sourcesFirst.subscription.claudeCode;
          })}
          description={t(($) => {
            return $.onboarding.sourcesFirst.subscription.rowCopy;
          })}
        />
      </RadioGroup>
    </OnboardingStepLayout>
  );
}
