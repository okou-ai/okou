import {
  onboardingRecommendationLocaleSchema,
  type OnboardingUserProfile,
} from "@okouai/api-contracts/contracts/onboarding";
import { Button, Skeleton } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import { startOnboardingRecommendation$ } from "../../signals/onboarding/onboarding-recommendation.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";

function ProfileSkeleton() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto w-full max-w-[600px] py-4" role="status">
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.onboarding.sourcesFirst.profile.loading;
        })}
      </p>
      <Skeleton className="mt-7 h-8 w-2/5" aria-hidden="true" />
      <Skeleton className="mt-4 h-4 w-full" aria-hidden="true" />
      <Skeleton className="mt-2 h-4 w-4/5" aria-hidden="true" />
      {[0, 1, 2].map((section) => {
        return (
          <div className="mt-10" key={section} aria-hidden="true">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="mt-4 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-3/4" />
          </div>
        );
      })}
    </div>
  );
}

function ProfileSection({
  title,
  points,
}: {
  readonly title: string;
  readonly points: readonly string[];
}) {
  if (points.length === 0) {
    return null;
  }
  return (
    <section className="border-t border-border/60 pt-7">
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
        {points.map((point) => {
          return <li key={point}>{point}</li>;
        })}
      </ul>
    </section>
  );
}

function ProfileResult({
  profile,
}: {
  readonly profile: OnboardingUserProfile;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto w-full max-w-[600px] space-y-7 py-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
          {t(($) => {
            return $.onboarding.sourcesFirst.profile.heading;
          })}
        </h2>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">
          {profile.overview}
        </p>
      </div>
      <ProfileSection
        title={t(($) => {
          return $.onboarding.sourcesFirst.profile.professionalIdentity;
        })}
        points={profile.professionalIdentity}
      />
      <ProfileSection
        title={t(($) => {
          return $.onboarding.sourcesFirst.profile.communicationStyle;
        })}
        points={profile.communicationStyle}
      />
      <ProfileSection
        title={t(($) => {
          return $.onboarding.sourcesFirst.profile.priorities;
        })}
        points={profile.priorities}
      />
    </div>
  );
}

/** The profile and first task are two views of the same background result. */
export function OnboardingProfilePage() {
  const { t, i18n } = useTranslation();
  const flow = useSourcesFirstFlow("profile");
  const startRecommendation = useSet(startOnboardingRecommendation$);
  const rootSignal = useGet(rootSignal$);
  const { recommendationStatus: status, recommendation } = flow.draft;
  const industry = flow.draft.industry;
  if (industry === null) {
    throw new Error("Onboarding profile requires a selected positioning");
  }
  const profile = status === "completed" ? recommendation?.profile : null;
  const isGenerating =
    status === "starting" ||
    status === "pending" ||
    status === "running" ||
    status === "timed-out";

  return (
    <OnboardingStepLayout
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={t(($) => {
        return $.onboarding.sourcesFirst.profile.title;
      })}
      description={t(($) => {
        return $.onboarding.sourcesFirst.profile.copy;
      })}
      contentAlign="start"
      primaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.continue;
      })}
      onPrimary={flow.goNext}
      primaryDisabled={isGenerating}
      secondaryLabel={
        isGenerating
          ? t(($) => {
              return $.onboarding.sourcesFirst.common.skip;
            })
          : undefined
      }
      onSecondary={isGenerating ? flow.goSkip : undefined}
      onBack={flow.goBack}
    >
      {profile ? (
        <ProfileResult profile={profile} />
      ) : isGenerating ? (
        <ProfileSkeleton />
      ) : (
        <div className="mx-auto w-full max-w-[600px] py-4">
          <p role="alert" className="text-sm leading-6 text-muted-foreground">
            {t(($) => {
              return $.onboarding.sourcesFirst.profile.failed;
            })}
          </p>
          <Button
            className="mt-5"
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              detach(
                startRecommendation(
                  {
                    industry,
                    locale: onboardingRecommendationLocaleSchema.parse(
                      i18n.resolvedLanguage || i18n.language || "en-US",
                    ),
                  },
                  rootSignal,
                ),
                Reason.DomCallback,
                "retry onboarding profile",
              );
            }}
          >
            {t(($) => {
              return $.onboarding.sourcesFirst.profile.retry;
            })}
          </Button>
        </div>
      )}
    </OnboardingStepLayout>
  );
}
