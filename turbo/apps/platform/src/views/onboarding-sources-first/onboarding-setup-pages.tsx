import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import { Button, Input, RadioGroup } from "@okouai/ui";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  connectorCatalogStatus$,
  reloadBuiltinConnectors$,
} from "../../signals/external/connectors.ts";
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
  type SubscriptionProvider,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";
import { waitForSourcesFirstCatalog$ } from "../../signals/onboarding/onboarding-sources-first-catalog.ts";
import {
  connectOnboardingSubscription$,
  onboardingSubscriptionStatus$,
  type OnboardingSubscriptionStatus,
} from "../../signals/onboarding/onboarding-subscription-connect.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { PersonalClaudeCodeDeviceAuthDialog } from "../okou-page/components/settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "../okou-page/components/settings/codex-device-auth-dialog.tsx";
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
  const catalog = useLastLoadable(connectorCatalogStatus$);
  const pageSignal = useGet(pageSignal$);
  const [catalogWait, waitForCatalog] = useLoadableSet(
    waitForSourcesFirstCatalog$,
  );
  const retryCatalog = useSet(reloadBuiltinConnectors$);
  const captureIndustrySelected = useSet(
    captureSourceOnboardingIndustrySelected$,
  );
  const flow = useSourcesFirstFlow("industry");
  const continueToSources = async (): Promise<void> => {
    await waitForCatalog(pageSignal);
    flow.goNext();
  };

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
      onPrimary={() => {
        detach(continueToSources(), Reason.DomCallback);
      }}
      primaryDisabled={
        flow.draft.industry === null || catalog.state === "hasError"
      }
      primaryBusy={catalogWait.state === "loading"}
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
            recommendationStatus: "idle",
            recommendation: null,
          });
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={retryCatalog}
          >
            {t(($) => {
              return $.connectors.catalog.directory.retry;
            })}
          </Button>
        </div>
      ) : null}
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
  if (status === "cancelled") {
    return (
      <ConnectNoteLine>
        {t(
          ($) => {
            return $.onboarding.sourcesFirst.subscription.cancelledNote;
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
  if (status === "idle") {
    return t(
      ($) => {
        return $.onboarding.sourcesFirst.subscription.connect;
      },
      { provider: providerName },
    );
  }
  return t(($) => {
    return $.onboarding.sourcesFirst.subscription.retry;
  });
}

/**
 * The connect for the chosen plan. Connected is what `/api/me/model-providers`
 * answers, so an attempt that failed or was called off says so and leaves the
 * step passable either way.
 */
function SubscriptionConnect({
  provider,
}: {
  readonly provider: SubscriptionProvider;
}) {
  const pageSignal = useGet(pageSignal$);
  const connect = useSet(connectOnboardingSubscription$);
  const statusLoadable = useLastLoadable(onboardingSubscriptionStatus$);
  // A provider list that cannot be read leaves the account unknown, which is
  // its own answer: never the connected one.
  const status: OnboardingSubscriptionStatus =
    statusLoadable.state === "hasData"
      ? statusLoadable.data
      : statusLoadable.state === "hasError"
        ? "unconfirmed"
        : "idle";
  const providerName = useProviderName(provider);
  const connected = status === "connected";
  const connecting = status === "connecting";

  return (
    <div className="mx-auto flex w-full max-w-[600px] flex-col gap-2">
      <Button
        type="button"
        variant={connected ? "outline" : "neutral"}
        className="w-full gap-2"
        disabled={connected || connecting}
        aria-busy={connecting}
        onClick={() => {
          detach(connect(provider, pageSignal), Reason.DomCallback);
        }}
      >
        {connected ? (
          <Check size={16} aria-hidden="true" />
        ) : (
          <ProductMark
            name={provider === "codex" ? "openai" : "anthropic"}
            alt=""
            size="mark"
            invertInDarkMode={provider === "codex"}
          />
        )}
        <SubscriptionConnectLabel status={status} providerName={providerName} />
      </Button>
      <SubscriptionConnectNote status={status} providerName={providerName} />
    </div>
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
    const next = nextSourcesFirstStep("experience", flow.flow, provider);
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
        primaryLabel={t(($) => {
          return $.onboarding.sourcesFirst.common.continue;
        })}
        // The connect is its own action: answering the question is what this
        // step asks for, so the way on never waits on the plan.
        onPrimary={goNext}
        primaryDisabled={experienced === null}
        onBack={flow.goBack}
      >
        <div className="flex flex-col gap-6">
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
            className="grid gap-4 sm:grid-cols-3"
          >
            <OnboardingPosterCard
              value="codex"
              selected={experienced === true && provider === "codex"}
              mark={
                <ProductMark
                  name="openai"
                  alt=""
                  size="choice"
                  invertInDarkMode
                />
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
          {provider === null ? null : (
            <SubscriptionConnect provider={provider} />
          )}
        </div>
      </OnboardingStepLayout>
      {/* The same device-auth dialogs Settings uses, so the step connects the
          account rather than keeping an answer of its own. */}
      <PersonalCodexDeviceAuthDialog />
      <PersonalClaudeCodeDeviceAuthDialog />
    </>
  );
}
