import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Lock, Search } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  DialogDescription,
  DialogTitle,
} from "@okouai/ui";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import {
  justConnectedSlugs$,
  setSelectedConnectorSlug$,
} from "../../signals/okou-page/settings/connectors.ts";
import {
  sourcesFirstUi$,
  updateSourcesFirstUi$,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";
import { ConnectorEntryCard } from "../okou-page/components/settings/connector-entry-card.tsx";
import { OnboardingConnectorSetup } from "../onboarding/onboarding-connectors.tsx";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { FEATURED_SOURCE_SLUGS } from "./onboarding-sources-first-data.ts";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";

/** Search offers the rest of the catalog; the grid already carries the ten. */
function SourceSearchDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const catalogLoadable = useLastLoadable(connectorCatalogStatus$);
  const selectConnector = useSet(setSelectedConnectorSlug$);
  const connectors =
    catalogLoadable.state === "hasData"
      ? catalogLoadable.data.connectors.filter((connector) => {
          return connector.authMethods.length > 0;
        })
      : [];

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <DialogTitle className="sr-only">
        {t(($) => {
          return $.onboarding.sourcesFirst.sources.searchTitle;
        })}
      </DialogTitle>
      <DialogDescription className="sr-only">
        {t(($) => {
          return $.onboarding.sourcesFirst.sources.searchCopy;
        })}
      </DialogDescription>
      <CommandInput
        placeholder={t(($) => {
          return $.onboarding.sourcesFirst.sources.searchPlaceholder;
        })}
      />
      <CommandList>
        <CommandEmpty>
          {t(($) => {
            return $.onboarding.sourcesFirst.sources.searchEmpty;
          })}
        </CommandEmpty>
        {connectors.map((connector) => {
          return (
            <CommandItem
              key={connector.slug}
              value={`${connector.label} ${connector.description}`}
              onSelect={() => {
                onOpenChange(false);
                selectConnector(connector.slug);
              }}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{connector.label}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {connector.description}
                </span>
              </span>
            </CommandItem>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}

export function OnboardingSourcesPage() {
  const { t } = useTranslation();
  const ui = useGet(sourcesFirstUi$);
  const updateUi = useSet(updateSourcesFirstUi$);
  const flow = useSourcesFirstFlow("sources");
  const catalogLoadable = useLastLoadable(connectorCatalogStatus$);
  const justConnected = useGet(justConnectedSlugs$);
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
  // A source connected through search belongs in the grid too, so an enabled
  // Continue always has something visibly connected behind it.
  const extraConnectedSlugs = connectedSlugs.filter((slug) => {
    return !FEATURED_SOURCE_SLUGS.some((featured) => {
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
      // At least one connected source is the one hard requirement.
      primaryDisabled={connectedSlugs.length === 0}
    >
      <OnboardingConnectorSetup
        connectorSlugs={[...FEATURED_SOURCE_SLUGS, ...extraConnectedSlugs]}
        variant="sources"
      >
        {/* The catalog entry closes the grid, as the last cell of its last row. */}
        <ConnectorEntryCard
          icon={<Search size={18} aria-hidden="true" />}
          label={t(($) => {
            return $.onboarding.sourcesFirst.sources.searchAction;
          })}
          description={t(($) => {
            return $.onboarding.sourcesFirst.sources.searchCopy;
          })}
          showDescription
          interactive
          indicator={
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground"
              aria-hidden="true"
            >
              <ArrowRight size={14} />
            </span>
          }
          action={
            <button
              type="button"
              className="absolute inset-0 z-10 rounded-[inherit] border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              onClick={() => {
                updateUi({ searchOpen: true });
              }}
            >
              <span className="sr-only">
                {t(($) => {
                  return $.onboarding.sourcesFirst.sources.searchTitle;
                })}
              </span>
            </button>
          }
        />
      </OnboardingConnectorSetup>
      <p className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
        <Lock size={14} aria-hidden="true" />
        {t(($) => {
          return $.onboarding.sourcesFirst.sources.note;
        })}
      </p>
      <SourceSearchDialog
        open={ui.searchOpen}
        onOpenChange={(open) => {
          updateUi({ searchOpen: open });
        }}
      />
    </OnboardingStepLayout>
  );
}
