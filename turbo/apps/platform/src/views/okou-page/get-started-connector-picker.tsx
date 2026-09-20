import { CircleCheck, Loader2 } from "lucide-react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { isOneClickConnectorGrantKind } from "@okouai/api-contracts/contracts/connector-catalog";
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
      className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
    >
      <ConnectorIcon icon={connector.icon} size={22} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
        {connector.label}
      </span>
      {busy ? (
        <Loader2
          size={15}
          aria-hidden="true"
          className="animate-spin text-muted-foreground"
        />
      ) : connector.connected ? (
        <CircleCheck size={15} aria-hidden="true" className="text-brand-text" />
      ) : null}
    </button>
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
    <div
      // Every one-click connector is here, so the list scrolls rather than
      // growing the dialog past the window.
      className="grid max-h-[278px] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3"
      data-testid="quest-connector-picker"
    >
      {connectors.map((connector) => {
        return (
          <ConnectorTile
            key={connector.slug}
            connector={connector}
            busy={
              connectFlowSlug === connector.slug ||
              pollingAuthCodeSlug === connector.slug ||
              pollingDeviceAuthSlug === connector.slug
            }
            onSelect={select}
          />
        );
      })}
    </div>
  );
}
