import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { onboardingRecommendationLocaleSchema } from "@okouai/api-contracts/contracts/onboarding";
import type { OnboardingIndustry } from "@okouai/core/onboarding-industry";
import {
  captureSourceOnboardingConnected$,
  captureSourceOnboardingConnectStarted$,
} from "../../signals/bootstrap/source-onboarding-telemetry.ts";
import type { PlatformConnectorCatalogConnectItem } from "../../signals/connector-domain.ts";
import { onboardingSourceConnectors$ } from "../../signals/onboarding/onboarding-sources-first-catalog.ts";
import { justConnectedBuiltinSlugs$ } from "../../signals/okou-page/settings/connectors.ts";
import { startOnboardingRecommendation$ } from "../../signals/onboarding/onboarding-recommendation.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { OnboardingConnectorSetup } from "../onboarding/onboarding-connectors.tsx";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import {
  FEATURED_SOURCE_SLUGS,
  INDUSTRY_SOURCE_SLUGS,
} from "./onboarding-sources-first-data.ts";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";

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
  justConnected: ReadonlySet<ConnectorSlug>,
): readonly ConnectorSlug[] {
  return connectors.flatMap((connector) => {
    return isOnboardingSourceSlug(connector.slug) &&
      (connector.connected || justConnected.has(connector.slug))
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
  const justConnected = useGet(justConnectedBuiltinSlugs$);
  const connectedSlugs =
    catalogLoadable.state === "hasData"
      ? connectedOnboardingSlugs(catalogLoadable.data, justConnected)
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
      onBack={flow.goBack}
    >
      <OnboardingConnectorSetup
        connectorSlugs={[...featuredSlugs, ...extraConnectedSlugs]}
        variant="sources"
        onConnectStart={captureConnectStarted}
        onConnected={captureConnected}
      />
      <p className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
        <Lock size={14} aria-hidden="true" />
        {t(($) => {
          return $.onboarding.sourcesFirst.sources.note;
        })}
      </p>
    </OnboardingStepLayout>
  );
}
