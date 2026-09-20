import { Loader2, Plus } from "lucide-react";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { isOneClickConnectorGrantKind } from "@okouai/api-contracts/contracts/connector-catalog";
import { cn, ScrollBar, surfaceVariants } from "@okouai/ui";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import {
  builtinConnectFlowSlug$,
  builtinPollingOAuthAuthCodeSlug$,
  builtinPollingOAuthDeviceAuthSlug$,
  connectBuiltinConnectorOAuthAuthCode$,
  getBuiltinConnectorStatusDirectConnectMethod,
} from "../../signals/okou-page/settings/connectors.ts";
import { defaultBuiltinConnectorAccountOptions } from "../../signals/okou-page/settings/connector-account-dialogs.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { SCROLL_FADE_Y_END } from "./scroll-fade.ts";

/**
 * The connectors the Get started quest can actually deliver on.
 *
 * The reward pays for a connection that finishes in the browser, so a catalog
 * entry that asks the reader to paste a key from another site belongs to a
 * different errand and is left out of this list rather than shown and then
 * refused.
 */
function oneClickConnectors(
  items: readonly PlatformConnectorCatalogStatusItem[],
): PlatformConnectorCatalogStatusItem[] {
  return [...items]
    .filter((connector) => {
      return connector.authMethods.some((authMethod) => {
        return isOneClickConnectorGrantKind(authMethod.grantKind);
      });
    })
    .sort((left, right) => {
      // The catalog carries the curated business-user ranking; anything
      // unranked falls to the tail in label order so it is still findable.
      const rankDelta =
        (left.popularityRank ?? Number.MAX_SAFE_INTEGER) -
        (right.popularityRank ?? Number.MAX_SAFE_INTEGER);
      return rankDelta === 0
        ? left.label.localeCompare(right.label)
        : rankDelta;
    });
}

function ConnectorTile({
  connector,
  busy,
  onSelect,
}: {
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly busy: boolean;
  readonly onSelect: (connector: PlatformConnectorCatalogStatusItem) => void;
}) {
  return (
    <button
      type="button"
      data-testid={`quest-connector-${connector.slug}`}
      disabled={busy}
      onClick={() => {
        onSelect(connector);
      }}
      className={cn(
        // The catalog's own connector card, at the compact radius: this list
        // holds the whole one-click catalog, so it takes the card's treatment
        // rather than a second one invented for the dialog.
        surfaceVariants({ radius: "compact", interactive: !busy }),
        "flex h-11 min-w-0 items-center gap-2.5 px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        <ConnectorIcon icon={connector.icon} size={20} />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {connector.label}
      </span>
      {busy ? (
        <Loader2
          size={16}
          aria-hidden="true"
          className="shrink-0 animate-spin text-muted-foreground"
        />
      ) : connector.connected ? (
        // The status dot the connector cards already use. Its meaning is
        // carried by the group heading above it, so it stays decorative here.
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground"
        >
          <Plus size={14} />
        </span>
      )}
    </button>
  );
}

/** One heading and the tiles under it, as its own labelled region. */
function ConnectorGroup({
  heading,
  connectors,
  isBusy,
  onSelect,
}: {
  readonly heading: string;
  readonly connectors: readonly PlatformConnectorCatalogStatusItem[];
  readonly isBusy: (connector: PlatformConnectorCatalogStatusItem) => boolean;
  readonly onSelect: (connector: PlatformConnectorCatalogStatusItem) => void;
}) {
  if (connectors.length === 0) {
    return null;
  }
  return (
    <section aria-label={heading}>
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">
        {heading}
      </h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {connectors.map((connector) => {
          return (
            <ConnectorTile
              key={connector.slug}
              connector={connector}
              busy={isBusy(connector)}
              onSelect={onSelect}
            />
          );
        })}
      </div>
    </section>
  );
}

/**
 * Every one-click connector, inside the dialog that explains why to connect
 * one.
 *
 * Pressing one starts its authorization here rather than opening a second
 * dialog that would repeat the connector's name and hold a single Connect
 * button; the few connectors that genuinely need a choice fall back to that
 * dialog through `onNeedsChoice`.
 *
 * The ones this workspace has not connected lead, because they are the only
 * ones the step can still be completed with. Sorting by popularity alone left
 * a reader who had already connected most of the catalog hunting for the few
 * tiles the dialog was actually asking them to press.
 */
export function QuestConnectorPicker({
  onNeedsChoice,
}: {
  readonly onNeedsChoice: (
    connector: PlatformConnectorCatalogStatusItem,
  ) => void;
}) {
  const { t } = useTranslation();
  const catalogLoadable = useLastLoadable(connectorCatalogStatus$);
  const pageSignal = useGet(pageSignal$);
  const connect = useSet(connectBuiltinConnectorOAuthAuthCode$);
  const connectFlowSlug = useGet(builtinConnectFlowSlug$);
  const pollingAuthCodeSlug = useGet(builtinPollingOAuthAuthCodeSlug$);
  const pollingDeviceAuthSlug = useGet(builtinPollingOAuthDeviceAuthSlug$);
  const connectors =
    catalogLoadable.state === "hasData"
      ? oneClickConnectors(catalogLoadable.data.connectors)
      : [];

  const isBusy = (connector: PlatformConnectorCatalogStatusItem) => {
    return (
      connectFlowSlug === connector.slug ||
      pollingAuthCodeSlug === connector.slug ||
      pollingDeviceAuthSlug === connector.slug
    );
  };

  const select = (connector: PlatformConnectorCatalogStatusItem) => {
    const direct = getBuiltinConnectorStatusDirectConnectMethod(connector);
    const accountOptions = defaultBuiltinConnectorAccountOptions(connector);
    if (direct?.kind !== "browser-auth" || !accountOptions) {
      onNeedsChoice(connector);
      return;
    }
    detach(
      connect(
        connector.slug,
        direct.authMethod,
        {
          connectorLabel: connector.label,
          connectorIcon: connector.icon,
          // The quest is about giving the assistant something to work on, so
          // the agents this workspace can already see get the new connector.
          authorizeVisibleAgents: true,
          ...accountOptions,
        },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  if (connectors.length === 0) {
    return (
      <p className="rounded-xl bg-state-hover px-4 py-6 text-center text-[13px] text-muted-foreground">
        {catalogLoadable.state === "hasError"
          ? t(($) => {
              return $.chat.agentPage.getStarted.intro.connector.pickerFailed;
            })
          : t(($) => {
              return $.chat.agentPage.getStarted.intro.connector.pickerLoading;
            })}
      </p>
    );
  }

  return (
    <ScrollArea.Root className="relative" data-testid="quest-connector-picker">
      <ScrollArea.Viewport
        data-slot="scroll-area-viewport"
        // Every one-click connector is here, so the list scrolls rather than
        // growing the dialog past the window.
        className={cn(
          "max-h-[288px] pr-3 focus:outline-none",
          SCROLL_FADE_Y_END,
        )}
      >
        <ScrollArea.Content className="flex flex-col gap-3.5">
          <ConnectorGroup
            heading={t(($) => {
              return $.chat.agentPage.getStarted.intro.connector.notConnected;
            })}
            connectors={connectors.filter((connector) => {
              return !connector.connected;
            })}
            isBusy={isBusy}
            onSelect={select}
          />
          <ConnectorGroup
            heading={t(($) => {
              return $.chat.agentPage.getStarted.intro.connector.connected;
            })}
            connectors={connectors.filter((connector) => {
              return connector.connected;
            })}
            isBusy={isBusy}
            onSelect={select}
          />
        </ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollBar data-testid="quest-connector-scrollbar" />
    </ScrollArea.Root>
  );
}
