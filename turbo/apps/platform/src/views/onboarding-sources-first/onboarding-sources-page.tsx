import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { onboardingRecommendationLocaleSchema } from "@okouai/api-contracts/contracts/onboarding";
import type { OnboardingIndustry } from "@okouai/core/onboarding-industry";
import {
  captureSourceOnboardingConnected$,
  captureSourceOnboardingConnectStarted$,
} from "../../signals/bootstrap/source-onboarding-telemetry.ts";
import type { PlatformConnectorCatalogConnectItem } from "../../signals/connector-domain.ts";
import { onboardingSourceConnectors$ } from "../../signals/onboarding/onboarding-sources-first-catalog.ts";
import { startOnboardingRecommendation$ } from "../../signals/onboarding/onboarding-recommendation.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { OnboardingConnectorSetup } from "../onboarding/onboarding-connectors.tsx";
import { securityPageUrl } from "./onboarding-security.ts";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import {
  FEATURED_SOURCE_SLUGS,
  INDUSTRY_SOURCE_SLUGS,
} from "./onboarding-sources-first-data.ts";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";
import { OnboardingSecurityLink } from "./onboarding-industry-parts.tsx";

/** The field answered on the step before decides which sources appear. */
function featuredSlugsFor(
  industry: OnboardingIndustry | null,
): readonly ConnectorSlug[] {
  return industry === null
    ? FEATURED_SOURCE_SLUGS
    : INDUSTRY_SOURCE_SLUGS[industry];
}

function isOnboardingSourceSlug(slug: string): boolean {
  return FEATURED_SOURCE_SLUGS.some((featuredSlug) => {
    return featuredSlug === slug;
  });
}

function connectedOnboardingSlugs(
  connectors: readonly PlatformConnectorCatalogConnectItem[],
): readonly ConnectorSlug[] {
  return connectors.flatMap((connector) => {
    return isOnboardingSourceSlug(connector.slug) && connector.connected
      ? [connector.slug]
      : [];
  });
}

export function OnboardingSourcesPage() {
  const { t, i18n } = useTranslation();
  const captureConnectStarted = useSet(captureSourceOnboardingConnectStarted$);
  const captureConnected = useSet(captureSourceOnboardingConnected$);
  const flow = useSourcesFirstFlow("sources");
  const rootSignal = useGet(rootSignal$);
  const startRecommendation = useSet(startOnboardingRecommendation$);
  const catalogLoadable = useLastLoadable(onboardingSourceConnectors$);
  const connectedSlugs =
    catalogLoadable.state === "hasData"
      ? connectedOnboardingSlugs(catalogLoadable.data)
      : [];
  // Keep previously connected sources visible even when they are not featured
  // for the selected field, so Continue reflects a source shown on this step.
  const featuredSlugs = featuredSlugsFor(flow.draft.industry);
  const extraConnectedSlugs = connectedSlugs.filter((slug) => {
    return !featuredSlugs.some((featured) => {
      return featured === slug;
    });
  });

  return (
    <OnboardingStepLayout
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={t(($) => {
        return $.onboarding.sourcesFirst.sources.title;
      })}
      description={t(($) => {
        return $.onboarding.sourcesFirst.sources.copy;
      })}
      mobileDescription={t(($) => {
        return $.onboarding.sourcesFirst.mobile.sourcesCopy;
      })}
      mobileFooter={
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer rounded-lg py-3 hover:text-foreground">
            {t(($) => {
              return $.onboarding.sourcesFirst.mobile.permissionsLabel;
            })}
          </summary>
          <p className="mt-1 leading-6">
            {t(($) => {
              return $.onboarding.sourcesFirst.sources.permissions;
            })}
          </p>
          <OnboardingSecurityLink />
        </details>
      }
      trustPoints={[
        t(($) => {
          return $.onboarding.sourcesFirst.sources.permissions;
        }),
      ]}
      footnote={
        <a
          className="text-brand-text hover:text-brand-text-hover"
          href={securityPageUrl(i18n.resolvedLanguage ?? i18n.language)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t(($) => {
            return $.onboarding.sourcesFirst.sources.securityLink;
          })}
        </a>
      }
      primaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.continue;
      })}
      onPrimary={() => {
        const industry = flow.draft.industry;
        if (industry) {
          const generation = startRecommendation(
            {
              industry,
              locale: onboardingRecommendationLocaleSchema.parse(
                i18n.resolvedLanguage || i18n.language || "en-US",
              ),
            },
            rootSignal,
          );
          detach(
            generation,
            Reason.DomCallback,
            "onboarding context recommendation",
          );
        }
        flow.goNext();
      }}
      primaryDisabled={connectedSlugs.length === 0}
      secondaryLabel={t(($) => {
        return $.onboarding.common.skip;
      })}
      onSecondary={flow.goSkip}
      onBack={flow.goBack}
    >
      <OnboardingConnectorSetup
        connectorSlugs={[...featuredSlugs, ...extraConnectedSlugs]}
        variant="sources"
        onConnectStart={captureConnectStarted}
        onConnected={captureConnected}
      />
    </OnboardingStepLayout>
  );
}
