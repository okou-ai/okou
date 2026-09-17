import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Lock, Search } from "lucide-react";
import {
  Button,
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
import { OnboardingConnectorSetup } from "../onboarding/onboarding-connectors.tsx";
import {
  OnboardingFooter,
  OnboardingShell,
} from "../onboarding/onboarding-shell.tsx";
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
  const flow = useSourcesFirstFlow("sources", () => {
    // The first step always has a next step; finishing is handled downstream.
  });
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

  return (
    <OnboardingShell
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={t(($) => {
        return $.onboarding.sourcesFirst.sources.title;
      })}
      description={t(($) => {
        return $.onboarding.sourcesFirst.sources.copy;
      })}
      footer={
        <OnboardingFooter
          onPrimary={flow.goNext}
          primaryLabel={t(($) => {
            return $.onboarding.sourcesFirst.common.continue;
          })}
          // At least one connected source is the one hard requirement.
          primaryDisabled={connectedSlugs.length === 0}
        />
      }
    >
      <OnboardingConnectorSetup
        connectorSlugs={FEATURED_SOURCE_SLUGS}
        variant="prompt"
      >
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="justify-start gap-3"
          onClick={() => {
            updateUi({ searchOpen: true });
          }}
        >
          <Search size={18} aria-hidden="true" />
          {t(($) => {
            return $.onboarding.sourcesFirst.sources.searchAction;
          })}
        </Button>
      </OnboardingConnectorSetup>
      <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
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
    </OnboardingShell>
  );
}
