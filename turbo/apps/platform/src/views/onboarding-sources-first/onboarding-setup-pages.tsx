import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { Button, RadioGroup, cn } from "@okouai/ui";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  OnboardingCompliance,
  OnboardingSecurityLink,
} from "./onboarding-industry-parts.tsx";
import {
  ONBOARDING_INDUSTRY_IDS,
  type OnboardingIndustry,
} from "@okouai/core/onboarding-industry";
import {
  captureSourceOnboardingExperienceAnswered$,
  captureSourceOnboardingIndustrySelected$,
} from "../../signals/bootstrap/source-onboarding-telemetry.ts";
import {
  nextSourcesFirstStep,
  updateSourcesFirstDraft$,
  type SubscriptionProvider,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";
import {
  onboardingSourceConnectors$,
  continueSourcesFirstIndustry$,
} from "../../signals/onboarding/onboarding-sources-first-catalog.ts";
import {
  connectOnboardingSubscription$,
  onboardingSubscriptionStatus$,
  onboardingSubscriptionStartOperation$,
  onboardingSubscriptionOperation$,
  type OnboardingSubscriptionStatus,
} from "../../signals/onboarding/onboarding-subscription-connect.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  OnboardingChoiceCard,
  OnboardingIllustration,
  OnboardingPosterCard,
  ProductMark,
} from "./onboarding-step-parts.tsx";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";

export function OnboardingIndustryPage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const catalog = useLastLoadable(onboardingSourceConnectors$);
  const pageSignal = useGet(pageSignal$);
  const [continueLoadable, continueToSources] = useLoadableSet(
    continueSourcesFirstIndustry$,
  );
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
      mobileTitle={t(($) => {
        return $.onboarding.sourcesFirst.mobile.industryTitle;
      })}
      mobileDescription={t(($) => {
        return $.onboarding.sourcesFirst.mobile.industryCopy;
      })}
      mobileFooter={<OnboardingSecurityLink />}
      supplement={<OnboardingCompliance />}
      primaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.continue;
      })}
      onPrimary={() => {
        detach(continueToSources(pageSignal), Reason.DomCallback);
      }}
      primaryDisabled={
        flow.draft.industry === null || catalog.state === "hasError"
      }
      primaryBusy={continueLoadable.state === "loading"}
      onBack={flow.goBack}
    >
      <RadioGroup
        value={flow.draft.industry ?? ""}
        onValueChange={(value) => {
          const industry = value as OnboardingIndustry;
          updateDraft({
            industry,
            startingPromptDraft: "",
            startingPromptKey: "",
            recommendationJobId: null,
            recommendationStartedAt: null,
          });
          captureIndustrySelected(industry);
        }}
        className="grid grid-cols-2 gap-2 sm:gap-3"
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
              mobileTitle={t(($) => {
                return $.onboarding.sourcesFirst.industries[id].mobileName;
              })}
              description={t(($) => {
                return $.onboarding.sourcesFirst.industries[id].summary;
              })}
            />
          );
        })}
      </RadioGroup>
      {catalog.state === "hasError" ? (
        <div
          role="alert"
          className="mt-4 flex items-center justify-between gap-3 text-sm text-muted-foreground"
        >
          <p>
            {t(($) => {
              return $.connectors.catalog.directory.builtinLoadFailed;
            })}
          </p>
        </div>
      ) : null}
    </OnboardingStepLayout>
  );
}

/** The name of the plan an answer names, for the copy that talks about it. */
function useProviderName(provider: SubscriptionProvider): string {
  const { t } = useTranslation();
  return provider === "codex"
    ? t(($) => {
        return $.onboarding.sourcesFirst.subscription.codex;
      })
    : t(($) => {
        return $.onboarding.sourcesFirst.subscription.claudeCode;
      });
}

/** The line under the connect, for a state that needs one. */
function ConnectNoteLine({ children }: { readonly children: string }) {
  return (
    <p className="text-xs leading-5 text-muted-foreground" role="status">
      {children}
    </p>
  );
}

/** What the step says about the account, once an attempt has settled. */
function SubscriptionConnectNote({
  status,
  providerName,
}: {
  readonly status: OnboardingSubscriptionStatus;
  readonly providerName: string;
}) {
  const { t } = useTranslation();
  if (status === "failed") {
    return (
      <ConnectNoteLine>
        {t(
          ($) => {
            return $.onboarding.sourcesFirst.subscription.failedNote;
          },
          { provider: providerName },
        )}
      </ConnectNoteLine>
    );
  }
  if (status === "unconfirmed") {
    return (
      <ConnectNoteLine>
        {t(
          ($) => {
            return $.onboarding.sourcesFirst.subscription.unconfirmedNote;
          },
          { provider: providerName },
        )}
      </ConnectNoteLine>
    );
  }
  return null;
}

/** What the connect itself offers, from the state the account is in. */
function SubscriptionConnectLabel({
  status,
  providerName,
}: {
  readonly status: OnboardingSubscriptionStatus;
  readonly providerName: string;
}) {
  const { t } = useTranslation();
  if (status === "connected") {
    return t(($) => {
      return $.onboarding.sourcesFirst.subscription.connected;
    });
  }
  if (status === "connecting") {
    return t(($) => {
      return $.onboarding.sourcesFirst.subscription.connecting;
    });
  }
  return t(
    ($) => {
      return $.onboarding.sourcesFirst.subscription.connect;
    },
    { provider: providerName },
  );
}

/**
 * The connect for the chosen plan. Connected is what `/api/me/3rd-party-subscriptions`
 * answers. Startup errors come from the actual operation, not an inferred
 * session outcome; the step remains passable either way.
 */
function SubscriptionConnect({
  provider,
}: {
  readonly provider: SubscriptionProvider;
}) {
  const pageSignal = useGet(pageSignal$);
  const connect = useSet(connectOnboardingSubscription$);
  const statusLoadable = useLoadable(onboardingSubscriptionStatus$);
  const startup = useLoadable(onboardingSubscriptionStartOperation$);
  const operation = useLoadable(onboardingSubscriptionOperation$);
  // A provider list that cannot be read leaves the account unknown, which is
  // its own answer: never the connected one.
  const accountStatus: OnboardingSubscriptionStatus =
    statusLoadable.state === "hasData"
      ? statusLoadable.data
      : statusLoadable.state === "hasError"
        ? "unconfirmed"
        : "idle";
  const status: OnboardingSubscriptionStatus =
    accountStatus === "connected"
      ? "connected"
      : startup.state === "loading"
        ? "connecting"
        : startup.state === "hasError" ||
            operation.state === "hasError" ||
            (startup.state === "hasData" && startup.data === false) ||
            (operation.state === "hasData" && operation.data === false)
          ? "failed"
          : accountStatus;
  const providerName = useProviderName(provider);
  const connected = status === "connected";
  const connecting = status === "connecting";

  return (
    // Spans the answer grid above it, so the action shares the cards' edges.
    <div className="flex w-full flex-col gap-2">
      <Button
        type="button"
        variant={connected ? "outline" : "default"}
        size="lg"
        className={cn(
          "w-full",
          !connected &&
            (provider === "claudeCode"
              ? "bg-[#c97d5d] text-[#fff] hover:bg-[#b57154] active:bg-[#a9694e]"
              : "bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed"),
        )}
        disabled={connected || connecting}
        aria-busy={connecting}
        onClick={() => {
          detach(connect(provider, pageSignal), Reason.DomCallback);
        }}
      >
        {connected ? (
          <Check size={16} aria-hidden="true" />
        ) : (
          <span
            className={cn(
              "invert",
              provider === "claudeCode" && "brightness-0",
            )}
          >
            <ProductMark
              name={provider === "codex" ? "openai" : "anthropic"}
              alt=""
              size="mark"
              invertInDarkMode={provider === "codex"}
            />
          </span>
        )}
        <SubscriptionConnectLabel status={status} providerName={providerName} />
      </Button>
      <SubscriptionConnectNote status={status} providerName={providerName} />
    </div>
  );
}

function SubscriptionPlanCard({
  provider,
  selected,
}: {
  readonly provider: SubscriptionProvider;
  readonly selected: boolean;
}) {
  const { t } = useTranslation();
  const providerName = useProviderName(provider);
  return (
    <OnboardingPosterCard
      value={provider}
      selected={selected}
      mark={
        <ProductMark
          name={provider === "codex" ? "openai" : "anthropic"}
          alt=""
          size="choice"
          invertInDarkMode={provider === "codex"}
        />
      }
      title={providerName}
      description={t(($) => {
        return $.onboarding.sourcesFirst.subscription.rowCopy;
      })}
      mobileTitle={t(
        ($) => {
          return $.onboarding.sourcesFirst.mobile.existingPlan;
        },
        { provider: providerName },
      )}
      mobileDescription={t(($) => {
        return $.onboarding.sourcesFirst.mobile.planCopy;
      })}
    />
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
    const next = nextSourcesFirstStep("experience", provider);
    if (next) {
      flow.goTo(next);
    }
  };

  return (
    <>
      <OnboardingStepLayout
        currentStep={flow.currentStep}
        totalSteps={flow.totalSteps}
        title={t(($) => {
          return $.onboarding.sourcesFirst.experience.title;
        })}
        description={t(($) => {
          return $.onboarding.sourcesFirst.experience.copy;
        })}
        mobileTitle={t(($) => {
          return $.onboarding.sourcesFirst.mobile.experienceTitle;
        })}
        mobileDescription=""
        trustPoints={[
          t(($) => {
            return $.onboarding.sourcesFirst.experience.trust;
          }),
        ]}
        primaryLabel={t(($) => {
          return $.onboarding.sourcesFirst.common.continue;
        })}
        // The connect is its own action: answering the question is what this
        // step asks for, so the way on never waits on the plan.
        onPrimary={goNext}
        primaryDisabled={experienced === null}
        onBack={flow.goBack}
      >
        <div className="flex flex-col gap-6 max-sm:gap-3">
          <RadioGroup
            value={experienced === false ? "no" : (provider ?? "")}
            onValueChange={(value) => {
              const answer =
                value === "no"
                  ? { experienced: false, provider: null }
                  : {
                      experienced: true,
                      provider:
                        value === "codex"
                          ? ("codex" as const)
                          : ("claudeCode" as const),
                    };
              updateDraft(answer);
              captureExperienceAnswered(answer.experienced, answer.provider);
            }}
            className="grid gap-3 sm:grid-cols-3 sm:gap-4"
          >
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
              mobileTitle={t(($) => {
                return $.onboarding.sourcesFirst.mobile.newTitle;
              })}
              mobileDescription={t(($) => {
                return $.onboarding.sourcesFirst.mobile.newCopy;
              })}
            />
            <SubscriptionPlanCard
              provider="codex"
              selected={experienced === true && provider === "codex"}
            />
            <SubscriptionPlanCard
              provider="claudeCode"
              selected={experienced === true && provider === "claudeCode"}
            />
          </RadioGroup>
          {provider === null ? null : (
            <SubscriptionConnect provider={provider} />
          )}
        </div>
      </OnboardingStepLayout>
      {/* OnboardingStepLayout owns the personal authorization dialogs shared
          with Settings. */}
    </>
  );
}
