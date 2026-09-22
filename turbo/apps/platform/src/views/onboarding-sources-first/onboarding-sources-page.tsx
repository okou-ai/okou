import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { OnboardingIndustry } from "@okouai/core/onboarding-industry";
import {
  captureSourceOnboardingConnected$,
  captureSourceOnboardingConnectStarted$,
} from "../../signals/bootstrap/source-onboarding-telemetry.ts";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import { justConnectedBuiltinSlugs$ } from "../../signals/okou-page/settings/connectors.ts";
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

export function OnboardingSourcesPage() {
  const { t } = useTranslation();
  const captureConnectStarted = useSet(captureSourceOnboardingConnectStarted$);
  const captureConnected = useSet(captureSourceOnboardingConnected$);
  const flow = useSourcesFirstFlow("sources");
  const catalogLoadable = useLastLoadable(connectorCatalogStatus$);
  const justConnected = useGet(justConnectedBuiltinSlugs$);
  const connectedSlugs: readonly ConnectorSlug[] =
    catalogLoadable.state === "hasData"
      ? catalogLoadable.data.connectors
          .filter((connector) => {
            return connector.connected || justConnected.has(connector.slug);
          })
          .map((connector) => {
            return connector.slug;
          })
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
      onPrimary={flow.goNext}
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
