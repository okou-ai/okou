import { useTranslation } from "react-i18next";
import { ChevronLeft, SlidersHorizontal } from "lucide-react";
import type { ConnectorAccountSummary } from "@okouai/api-contracts/contracts/connector-accounts";
import { Button } from "@okouai/ui";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import { connectorCurrentConnectionStatus } from "../../signals/okou-page/settings/connectors.ts";
import {
  ConnectorIconTile,
  ConnectorAccountSummaryText,
  connectorAccountSummaryStatus,
} from "./components/settings/connector-card.tsx";
import {
  launchConnectorConnect,
  type ConnectorConnectHandlers,
} from "./components/settings/launch-connector-connect.ts";

function DetailRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-t border-border/50 px-4 py-2.5 first:border-t-0">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {children}
      </span>
    </div>
  );
}

function ConnectorDetailHeader({
  connector,
  busy,
  connect,
  onBack,
}: {
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly busy: boolean;
  readonly connect: ConnectorConnectHandlers;
  readonly onBack: () => void;
}) {
  const { t } = useTranslation();
  const status = connectorCurrentConnectionStatus(connector);
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-6 pt-6">
        <Button
          type="button"
          variant="quiet"
          size="xs"
          className="-ml-2 gap-1.5"
          onClick={onBack}
        >
          <ChevronLeft size={15} aria-hidden="true" />
          {t(($) => {
            return $.chat.connectors.back;
          })}
        </Button>
      </div>
      <div className="flex shrink-0 items-start gap-3.5 px-6 pb-4 pt-4">
        <ConnectorIconTile icon={connector.icon} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-foreground">
            {connector.label}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {connector.description}
          </p>
        </div>
        {status !== "connected" && status !== "scope-mismatch" && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              launchConnectorConnect({ connector, ...connect });
            }}
          >
            {status === "not-connected"
              ? t(($) => {
                  return $.connectors.actions.connect;
                })
              : t(($) => {
                  return $.connectors.actions.reconnect;
                })}
          </Button>
        )}
      </div>
    </>
  );
}

/**
 * One place for what a connector is, which accounts are attached, and what it
 * is allowed to do. The same facts are split across the permission dialog, the
 * account switcher and the settings card menu today.
 */
export function ConnectorDetailPanel({
  connector,
  accountSummary,
  categoryLabel,
  busy,
  connect,
  onConfigurePermissions,
  onBack,
}: {
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly accountSummary: ConnectorAccountSummary | undefined;
  readonly categoryLabel: string | undefined;
  readonly busy: boolean;
  readonly connect: ConnectorConnectHandlers;
  readonly onConfigurePermissions: () => void;
  readonly onBack: () => void;
}) {
  const { t } = useTranslation();
  const authMethodLabel = connector.authMethods[0]?.label;

  return (
    <>
      <ConnectorDetailHeader
        connector={connector}
        busy={busy}
        connect={connect}
        onBack={onBack}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          {t(($) => {
            return $.chat.connectors.directory.detailAccounts;
          })}
        </h3>
        <div className="mb-5 rounded-xl border border-[hsl(var(--gray-400))]">
          <div className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <ConnectorAccountSummaryText
              summary={accountSummary}
              status={connectorAccountSummaryStatus(
                accountSummary ? "hasData" : "loading",
              )}
              className="min-w-0 flex-1 truncate text-muted-foreground"
            />
          </div>
        </div>

        {connector.mcp === undefined && (
          <>
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">
              {t(($) => {
                return $.chat.connectors.directory.detailPermissions;
              })}
            </h3>
            <div className="mb-5 rounded-xl border border-[hsl(var(--gray-400))]">
              <div className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {t(
                    ($) => {
                      return $.chat.connectors.directory.permissionCount;
                    },
                    { count: connector.permissionSummary.permissionCount },
                  )}
                </span>
                {connector.permissionSummary.hasPermissions && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="gap-1.5"
                    onClick={onConfigurePermissions}
                  >
                    <SlidersHorizontal size={14} aria-hidden="true" />
                    {t(($) => {
                      return $.chat.connectors.directory.configure;
                    })}
                  </Button>
                )}
              </div>
            </div>
          </>
        )}

        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          {t(($) => {
            return $.chat.connectors.directory.detailConnection;
          })}
        </h3>
        <div className="rounded-xl border border-[hsl(var(--gray-400))]">
          {authMethodLabel && (
            <DetailRow
              label={t(($) => {
                return $.chat.connectors.directory.detailMethod;
              })}
            >
              {authMethodLabel}
            </DetailRow>
          )}
          {categoryLabel && (
            <DetailRow
              label={t(($) => {
                return $.chat.connectors.directory.detailCategory;
              })}
            >
              {categoryLabel}
            </DetailRow>
          )}
        </div>
      </div>
    </>
  );
}
