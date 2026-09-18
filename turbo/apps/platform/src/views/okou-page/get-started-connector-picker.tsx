import { CircleCheck } from "lucide-react";
import { useLastLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { isOneClickConnectorGrantKind } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
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
  onPick,
}: {
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly onPick: (connector: PlatformConnectorCatalogStatusItem) => void;
}) {
  return (
    <button
      type="button"
      data-testid={`quest-connector-${connector.slug}`}
      onClick={() => {
        onPick(connector);
      }}
      className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-brand hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ConnectorIcon icon={connector.icon} size={22} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
        {connector.label}
      </span>
      {connector.connected ? (
        <CircleCheck size={15} aria-hidden="true" className="text-brand-text" />
      ) : null}
    </button>
  );
}

/**
 * Every one-click connector, inside the dialog that explains why to connect
 * one. The catalog page is still the place to browse four thousand services;
 * this is the short list the quest is actually about, so picking one here goes
 * straight into its connect flow instead of leaving the reader on a page to
 * search for it again.
 */
export function QuestConnectorPicker({
  onPick,
}: {
  readonly onPick: (connector: PlatformConnectorCatalogStatusItem) => void;
}) {
  const { t } = useTranslation();
  const catalogLoadable = useLastLoadable(connectorCatalogStatus$);
  const connectors =
    catalogLoadable.state === "hasData"
      ? oneClickConnectors(catalogLoadable.data.connectors)
      : [];

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
            onPick={onPick}
          />
        );
      })}
    </div>
  );
}
