import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import { Button, Input, RadioGroup } from "@okouai/ui";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  sendSourcesFirstInvite$,
  sourcesFirstInviteSendable,
} from "../../signals/onboarding/onboarding-sources-first-invite.ts";
import {
  ONBOARDING_INDUSTRY_IDS,
  type OnboardingIndustry,
} from "@okouai/core/onboarding-industry";
import {
  captureSourceOnboardingExperienceAnswered$,
  captureSourceOnboardingIndustrySelected$,
  captureSourceOnboardingInviteAdded$,
} from "../../signals/bootstrap/source-onboarding-telemetry.ts";
import {
  nextSourcesFirstStep,
  sourcesFirstUi$,
  updateSourcesFirstDraft$,
  updateSourcesFirstUi$,
  type SourcesFirstInvite,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";
import { detach, Reason } from "../../signals/utils.ts";
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
  const captureIndustrySelected = useSet(
    captureSourceOnboardingIndustrySelected$,
  );
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
          const industry = value as OnboardingIndustry;
          updateDraft({ industry });
          captureIndustrySelected(industry);
        }}
        className="grid gap-3 sm:grid-cols-2"
      >
        {ONBOARDING_INDUSTRY_IDS.map((id) => {
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

/** What the API last answered for one address, in its own row. */
function InviteOutcome({ invite }: { readonly invite: SourcesFirstInvite }) {
  const { t } = useTranslation();

  if (invite.status === "pending") {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        {t(($) => {
          return $.onboarding.sourcesFirst.team.sending;
        })}
      </span>
    );
  }
  if (invite.status === "invited") {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Check size={14} aria-hidden="true" />
        {t(($) => {
          return $.onboarding.sourcesFirst.team.invited;
        })}
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-destructive">
      <TriangleAlert size={14} aria-hidden="true" />
      {t(($) => {
        return $.onboarding.sourcesFirst.team.notSent;
      })}
    </span>
  );
}

/** The addresses this run tried, under the form that sent them. */
function InviteList({
  invites,
}: {
  readonly invites: readonly SourcesFirstInvite[];
}) {
  return (
    <div className="border-t border-border/60">
      {invites.map((invite) => {
        return (
          <div
            key={invite.email}
            className="flex items-start gap-3 border-t border-border/60 px-5 py-3.5 first:border-t-0"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">
              {invite.email.slice(0, 1).toUpperCase()}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-foreground">
                {invite.email}
              </span>
              {/* The reason belongs to the address, so it stays with it. */}
              {invite.failure === null ? null : (
                <span
                  role="alert"
                  className="mt-0.5 text-xs leading-5 text-destructive"
                >
                  {invite.failure}
                </span>
              )}
            </span>
            <InviteOutcome invite={invite} />
          </div>
        );
      })}
    </div>
  );
}

export function OnboardingTeamPage() {
  const { t } = useTranslation();
  const captureInviteAdded = useSet(captureSourceOnboardingInviteAdded$);
  const flow = useSourcesFirstFlow("team");
  const ui = useGet(sourcesFirstUi$);
  const updateUi = useSet(updateSourcesFirstUi$);
  const sendInvite = useSet(sendSourcesFirstInvite$);
  const pageSignal = useGet(pageSignal$);
  const address = ui.inviteEmail.trim();
  const sendable = sourcesFirstInviteSendable(flow.draft.invites, address);

  const invite = (): void => {
    if (!sendable) {
      return;
    }
    // A refused address is sent again under its own entry, so only a new one
    // makes the list longer.
    const known = flow.draft.invites.some((entry) => {
      return entry.email === address;
    });
    // The address moves into the list, so the field is free for the next one
    // while the API is still answering for this one.
    updateUi({ inviteEmail: "" });
    detach(sendInvite(address, pageSignal), Reason.DomCallback);
    // The funnel counts invitees; the addresses themselves stay in the draft.
    captureInviteAdded(
      known ? flow.draft.invites.length : flow.draft.invites.length + 1,
    );
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
      onSecondary={flow.goSkip}
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
            <Button type="button" onClick={invite} disabled={!sendable}>
              {t(($) => {
                return $.onboarding.sourcesFirst.team.invite;
              })}
            </Button>
          </div>
        </div>
        {flow.draft.invites.length > 0 ? (
          <InviteList invites={flow.draft.invites} />
        ) : (
          <TeamPoints />
        )}
      </OnboardingPanel>
    </OnboardingStepLayout>
  );
}

/**
 * One question for both halves of the same decision: an answer names the plan
 * the work should run on, and whether this person has skills to bring over.
 */
export function OnboardingExperiencePage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const captureExperienceAnswered = useSet(
    captureSourceOnboardingExperienceAnswered$,
  );
  const flow = useSourcesFirstFlow("experience");
  const { experienced, provider } = flow.draft;

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
      onPrimary={() => {
        if (provider !== null) {
          // Frontend pass: the personal model-provider connect flow is wired
          // in the follow-up that adds the onboarding endpoints.
          updateDraft({ providerConnected: true });
        }
        goNext();
      }}
      primaryDisabled={experienced === null}
      onBack={flow.goBack}
    >
      <RadioGroup
        value={experienced === false ? "no" : (provider ?? "")}
        onValueChange={(value) => {
          const answer =
            value === "no"
              ? { experienced: false, provider: null, providerConnected: false }
              : {
                  experienced: true,
                  provider:
                    value === "codex"
                      ? ("codex" as const)
                      : ("claudeCode" as const),
                  providerConnected: false,
                };
          updateDraft(answer);
          captureExperienceAnswered(answer.experienced, answer.provider);
        }}
        className="grid gap-4 sm:grid-cols-3"
      >
        <OnboardingPosterCard
          value="codex"
          selected={experienced === true && provider === "codex"}
          mark={
            <ProductMark name="openai" alt="" size="choice" invertInDarkMode />
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
          selected={experienced === true && provider === "claudeCode"}
          mark={<ProductMark name="anthropic" alt="" size="choice" />}
          title={t(($) => {
            return $.onboarding.sourcesFirst.subscription.claudeCode;
          })}
          description={t(($) => {
            return $.onboarding.sourcesFirst.subscription.rowCopy;
          })}
        />
        <OnboardingPosterCard
          value="no"
          selected={experienced === false}
          mark={<OnboardingIllustration name="new" alt="" size="choice" />}
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
