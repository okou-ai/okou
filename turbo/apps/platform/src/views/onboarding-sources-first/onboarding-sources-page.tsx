import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Lock, Search } from "lucide-react";
import {
  CommandDialog,
  CommandInput,
  CommandItem,
  CommandList,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { OnboardingIndustry } from "@okouai/core/onboarding-industry";
import {
  captureSourceOnboardingCatalogSearchOpened$,
  captureSourceOnboardingCatalogSearchResultSelected$,
  captureSourceOnboardingConnected$,
  captureSourceOnboardingConnectStarted$,
} from "../../signals/bootstrap/source-onboarding-telemetry.ts";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import {
  justConnectedBuiltinSlugs$,
  setSelectedBuiltinConnectorSlug$,
} from "../../signals/okou-page/settings/connectors.ts";
import {
  sourcesFirstUi$,
  updateSourcesFirstUi$,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";
import { ConnectorEntryCard } from "../okou-page/components/settings/connector-entry-card.tsx";
import { ConnectorIcon } from "../okou-page/components/settings/connector-icons.tsx";
import { OnboardingConnectorSetup } from "../onboarding/onboarding-connectors.tsx";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import {
  FEATURED_SOURCE_SLUGS,
  INDUSTRY_SOURCE_SLUGS,
} from "./onboarding-sources-first-data.ts";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";

/**
 * The field answered on the step before decides the grid: it shows that
 * field's own sources rather than the whole featured list. The catalog search
 * beside them still reaches everything else.
 */
function featuredSlugsFor(
  industry: OnboardingIndustry | null,
): readonly ConnectorSlug[] {
  return industry === null
    ? FEATURED_SOURCE_SLUGS
    : INDUSTRY_SOURCE_SLUGS[industry];
}

/**
 * The catalog is thousands of sources long, so the list is what the typed
 * words match, capped at a screenful. Filtering is ours: the shared command
 * list only filters the items it was handed as data, and this one renders its
 * rows itself.
 */
const SEARCH_RESULT_LIMIT = 40;

/**
 * A name match beats a mention in a description, so "calendar" leads with
 * Google Calendar rather than with everything whose blurb says "calendars".
 */
function searchRank(label: string, query: string): number {
  if (label.startsWith(query)) {
    return 0;
  }
  return label.includes(query) ? 1 : 2;
}

function matchingConnectors(
  connectors: readonly PlatformConnectorCatalogStatusItem[],
  query: string,
): readonly PlatformConnectorCatalogStatusItem[] {
  const matches = connectors
    .map((connector) => {
      return {
        connector,
        rank: searchRank(connector.label.toLowerCase(), query),
      };
    })
    .filter((match) => {
      return (
        match.rank < 2 ||
        match.connector.description.toLowerCase().includes(query)
      );
    });
  // A stable sort, so sources of the same rank keep the catalog's own order.
  matches.sort((left, right) => {
    return left.rank - right.rank;
  });
  return matches.slice(0, SEARCH_RESULT_LIMIT).map((match) => {
    return match.connector;
  });
}

/** Search offers the rest of the catalog; the grid already carries the field's. */
function SourceSearchDialog({
  open,
  query,
  onQueryChange,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const catalogLoadable = useLastLoadable(connectorCatalogStatus$);
  const selectConnector = useSet(setSelectedBuiltinConnectorSlug$);
  const captureResultSelected = useSet(
    captureSourceOnboardingCatalogSearchResultSelected$,
  );
  const captureConnectStarted = useSet(captureSourceOnboardingConnectStarted$);
  const connectors =
    catalogLoadable.state === "hasData"
      ? catalogLoadable.data.connectors.filter((connector) => {
          return connector.authMethods.length > 0;
        })
      : [];
  const trimmedQuery = query.trim().toLowerCase();
  const matches =
    trimmedQuery === "" ? [] : matchingConnectors(connectors, trimmedQuery);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      contentClassName="gap-0"
      commandClassName="gap-0"
      commandProps={{
        mode: "none",
        autoHighlight: true,
        loopFocus: true,
        value: query,
        onValueChange: (value, eventDetails) => {
          if (eventDetails.reason === "item-press") {
            eventDetails.cancel();
            return;
          }
          onQueryChange(value);
        },
      }}
    >
      <DialogHeader className="px-5 pb-3 pt-5">
        <DialogTitle className="text-base font-semibold">
          {t(($) => {
            return $.onboarding.sourcesFirst.sources.searchTitle;
          })}
        </DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          {t(($) => {
            return $.onboarding.sourcesFirst.sources.searchCopy;
          })}
        </DialogDescription>
      </DialogHeader>
      <div className="px-5 pb-3">
        <CommandInput
          placeholder={t(($) => {
            return $.onboarding.sourcesFirst.sources.searchPlaceholder;
          })}
        />
      </div>
      <CommandList className="px-3 pb-4">
        {trimmedQuery !== "" && matches.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            {t(($) => {
              return $.onboarding.sourcesFirst.sources.searchEmpty;
            })}
          </p>
        ) : null}
        {matches.map((connector) => {
          return (
            <CommandItem
              key={connector.slug}
              value={connector.slug}
              className="gap-3 px-2 py-2"
              onClick={() => {
                onOpenChange(false);
                // What the search produced, never the words that produced it.
                captureResultSelected(connector.slug, matches.length);
                captureConnectStarted(connector.slug, "search");
                selectConnector(connector.slug);
              }}
            >
              <ConnectorIcon icon={connector.icon} size={20} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-foreground">
                  {connector.label}
                </span>
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
  const captureSearchOpened = useSet(
    captureSourceOnboardingCatalogSearchOpened$,
  );
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
  // A source connected through search belongs in the grid too, so an enabled
  // Continue always has something visibly connected behind it.
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
      // At least one connected source is the one hard requirement.
      primaryDisabled={connectedSlugs.length === 0}
      onBack={flow.goBack}
    >
      <OnboardingConnectorSetup
        connectorSlugs={[...featuredSlugs, ...extraConnectedSlugs]}
        variant="sources"
        onConnectStart={(connectorSlug) => {
          captureConnectStarted(connectorSlug, "grid");
        }}
        onConnected={(connectorSlug) => {
          captureConnected(connectorSlug);
        }}
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
                captureSearchOpened();
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
        query={ui.searchQuery}
        onQueryChange={(query) => {
          updateUi({ searchQuery: query });
        }}
        onOpenChange={(open) => {
          // Closing clears the query, so the next search starts on the hint
          // rather than on the words someone typed a step ago.
          updateUi({ searchOpen: open, searchQuery: "" });
        }}
      />
    </OnboardingStepLayout>
  );
}
