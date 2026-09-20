import type { ReactNode } from "react";
import { useGet, type LoadableState } from "ccstate-react";
import { connectorConnectionPending$ } from "../../../../signals/connector-connection-progress.ts";
import { useTranslation } from "react-i18next";
import { ChevronRight, CircleCheck, Loader2, Plus } from "lucide-react";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { ConnectorAccountSummary } from "@okouai/api-contracts/contracts/connector-accounts";
import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import type { PlatformConnectorCatalogStatusItem } from "../../../../signals/connector-domain.ts";
import { Button, surfaceVariants, cn } from "@okouai/ui";
import { builtinConnectorCurrentConnectionStatus } from "../../../../signals/okou-page/settings/connectors.ts";
import { ConnectorPermissionRow } from "./connector-permission-row.tsx";
import {
  ConnectorEntryCard,
  ConnectorEntryStatus,
} from "./connector-entry-card.tsx";
import { ConnectorIcon } from "./connector-icons.tsx";
import {
  launchConnectorConnect,
  type ConnectorConnectHandlers,
} from "./launch-connector-connect.ts";
import { useConnectorAccountLabel } from "./use-connector-account-label.ts";
import { MercuryDisclosure } from "./mercury-disclosure.tsx";

type CatalogConnectorCardProps = {
  readonly variant: "catalog";
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly busy: boolean;
  readonly connect: ConnectorConnectHandlers;
};

export type ConnectorAccountSummaryStatus = "loading" | "unavailable" | "ready";

export function connectorAccountSummaryStatus(
  state: LoadableState,
): ConnectorAccountSummaryStatus {
  if (state === "hasData") {
    return "ready";
  }
  if (state === "hasError") {
    return "unavailable";
  }
  return "loading";
}

type AccountsConnectorCardProps = {
  readonly variant: "accounts";
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly summary: ConnectorAccountSummary | undefined;
  readonly summaryStatus: ConnectorAccountSummaryStatus;
  readonly busy: boolean;
  readonly connect: ConnectorConnectHandlers;
  readonly manageAccess?: ReactNode;
  readonly onManage: () => void;
};

type OnboardingConnectorCardProps = {
  readonly variant: "onboarding";
  readonly connectorSlug: ConnectorSlug;
  readonly connector: PlatformConnectorCatalogStatusItem | undefined;
  readonly connected: boolean;
  readonly busy: boolean;
  readonly loading: boolean;
  readonly layout: "workflow" | "prompt";
  readonly required: boolean;
  readonly connect: ConnectorConnectHandlers | undefined;
};

type ActionConnectorCardProps = {
  readonly variant: "action";
  readonly icon: ReactNode;
  readonly label: string;
  readonly description: string;
  readonly connected: boolean;
  readonly complete: boolean;
  readonly reconnectRequired: boolean;
  readonly busy: boolean;
  readonly className?: string;
  readonly onActivate: () => void;
};

type PermissionConnectorCardProps = {
  readonly variant: "permission";
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly enabled: boolean;
  readonly loading: boolean;
  readonly showManage: boolean;
  readonly isLast: boolean;
  readonly onManage: () => void;
  readonly onToggle: (checked: boolean) => void;
};

type DirectoryConnectorCardProps = {
  readonly variant: "directory";
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly busy: boolean;
  readonly connected: boolean;
  readonly accountCount?: number;
  readonly accountLabel?: string;
  readonly unavailable?: boolean;
  readonly active?: boolean;
  readonly connect: ConnectorConnectHandlers;
  readonly onOpenDetail?: () => void;
};

type ConnectorCardProps =
  | CatalogConnectorCardProps
  | DirectoryConnectorCardProps
  | AccountsConnectorCardProps
  | OnboardingConnectorCardProps
  | ActionConnectorCardProps
  | PermissionConnectorCardProps;

function runConnect(
  connector: PlatformConnectorCatalogStatusItem,
  connect: ConnectorConnectHandlers,
  busy: boolean,
): void {
  if (busy) {
    return;
  }
  launchConnectorConnect({ connector, ...connect });
}

function CatalogConnectorCard({
  connector,
  busy,
  connect,
}: CatalogConnectorCardProps) {
  const { t } = useTranslation();
  const handleConnect = () => {
    runConnect(connector, connect, busy);
  };

  return (
    <div
      role="button"
      tabIndex={busy ? -1 : 0}
      aria-label={t(
        ($) => {
          return $.connectors.card.connectAria;
        },
        { connector: connector.label },
      )}
      aria-disabled={busy}
      data-slot="connector-card"
      className={cn(
        surfaceVariants({ interactive: !busy }),
        "overflow-hidden text-left",
        busy && "cursor-default",
      )}
      onClick={handleConnect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleConnect();
        }
      }}
    >
      <div className="flex items-center gap-2.5 px-5 pb-1 pt-4">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <ConnectorIcon icon={connector.icon} size={20} />
        </span>
        <span
          data-testid="connector-card-label"
          className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
        >
          {connector.label}
        </span>
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground",
            !busy && "border border-border/60",
          )}
          aria-hidden="true"
        >
          {busy ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Plus size={14} />
          )}
        </span>
      </div>
      <div className="px-5 pb-4 pt-1">
        <div
          data-testid="connector-help-text"
          className="line-clamp-2 text-xs text-muted-foreground"
        >
          {connector.description}
        </div>
      </div>
    </div>
  );
}

/**
 * `okou-border` as utilities, plus the page-surface recipe inlined. The
 * directory renders through a dialog portal, so it keeps the neutral shadow
 * the way the other portalled surfaces already do; adopting `surfaceVariants`
 * here would newly pick up the gradient-theme elevation and change pixels.
 */
export const DIRECTORY_HAIRLINE = "border border-[hsl(var(--gray-400))]";
export const DIRECTORY_SURFACE = cn(
  "rounded-[1.25rem] bg-card transition-colors",
  DIRECTORY_HAIRLINE,
  "shadow-[0_2px_12px_hsl(30_6%_45%/0.05),0_0_0_0.5px_hsl(30_6%_45%/0.025)]",
);

/** Square container that gives every connector mark the same optical weight. */
export function ConnectorIconTile({
  icon,
  size = "md",
}: {
  readonly icon: PublicConnectorCatalogIcon | undefined;
  readonly size?: "md" | "lg";
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-gray-50",
        DIRECTORY_HAIRLINE,
        size === "lg" ? "h-13 w-13 rounded-[14px]" : "h-9 w-9",
      )}
    >
      <ConnectorIcon icon={icon} size={size === "lg" ? 32 : 22} />
    </span>
  );
}

function DirectoryConnectorStatusLine({
  connector,
  accountCount,
  accountLabel,
  unavailable,
}: {
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly accountCount: number;
  readonly accountLabel: string | undefined;
  readonly unavailable: boolean;
}) {
  const { t } = useTranslation();
  const connectionStatus = builtinConnectorCurrentConnectionStatus(connector);
  if (unavailable) {
    return (
      <>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gray-500" />
        <span className="truncate text-muted-foreground">
          {t(($) => {
            return $.chat.connectors.directory.askAdmin;
          })}
        </span>
      </>
    );
  }
  if (connectionStatus === "reconnect-required") {
    return (
      <>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
        <span className="truncate text-amber-600 dark:text-amber-400">
          {t(($) => {
            return $.connectors.card.connectionExpired;
          })}
        </span>
      </>
    );
  }
  if (connectionStatus === "scope-mismatch") {
    return (
      <>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
        <span className="truncate text-amber-600 dark:text-amber-400">
          {t(($) => {
            return $.connectors.card.updatePermissions;
          })}
        </span>
      </>
    );
  }
  return (
    <>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
      <span className="truncate text-muted-foreground">
        {accountLabel ??
          t(($) => {
            return $.connectors.card.connected;
          })}
      </span>
      {accountCount > 1 && (
        <span className="ml-auto shrink-0 rounded-full bg-state-selected px-2 py-0.5 text-[11px] text-muted-foreground">
          {t(
            ($) => {
              return $.chat.connectors.directory.moreAccounts;
            },
            { count: accountCount - 1 },
          )}
        </span>
      )}
    </>
  );
}

function DirectoryConnectorCard({
  connector,
  busy,
  connected,
  accountCount = 0,
  accountLabel,
  unavailable = false,
  active = false,
  connect,
  onOpenDetail,
}: DirectoryConnectorCardProps) {
  const { t } = useTranslation();
  const interactive = !busy && !unavailable;
  const activate = () => {
    if (!interactive) {
      return;
    }
    if (connected) {
      onOpenDetail?.();
      return;
    }
    runConnect(connector, connect, busy);
  };

  return (
    <div
      role="button"
      tabIndex={interactive ? 0 : -1}
      data-connector-slug={connector.slug}
      data-active={active ? "true" : undefined}
      aria-label={
        connected
          ? t(
              ($) => {
                return $.chat.connectors.directory.openDetailAria;
              },
              { connector: connector.label },
            )
          : t(
              ($) => {
                return $.connectors.card.connectAria;
              },
              { connector: connector.label },
            )
      }
      aria-disabled={!interactive}
      className={cn(
        DIRECTORY_SURFACE,
        "flex flex-col overflow-hidden text-left",
        interactive ? "cursor-pointer hover:bg-card-hover" : "cursor-default",
        unavailable && "opacity-60",
        active && "bg-state-selected",
      )}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      }}
    >
      <div className="flex items-center gap-3 px-4 pb-2 pt-3.5">
        <ConnectorIconTile icon={connector.icon} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            data-testid="connector-card-label"
            className="min-w-0 truncate text-sm font-medium text-foreground"
          >
            {connector.label}
          </span>
        </span>
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground",
            !busy && !connected && !unavailable && "border border-border/60",
          )}
          aria-hidden="true"
        >
          {busy ? (
            <Loader2 size={16} className="animate-spin" />
          ) : connected ? (
            <ChevronRight size={16} />
          ) : (
            <Plus size={14} />
          )}
        </span>
      </div>
      {connected || unavailable ? (
        <div className="flex h-10 items-center gap-2 border-t border-border/50 px-4 text-xs">
          <DirectoryConnectorStatusLine
            connector={connector}
            accountCount={accountCount}
            accountLabel={accountLabel}
            unavailable={unavailable}
          />
        </div>
      ) : (
        <div className="px-4 pb-3.5">
          <div
            data-testid="connector-help-text"
            className="line-clamp-2 text-xs text-muted-foreground"
          >
            {connector.description}
          </div>
        </div>
      )}
    </div>
  );
}

export function ConnectorAccountSummaryText({
  summary,
  status,
  className,
}: {
  readonly summary: ConnectorAccountSummary | undefined;
  readonly status: ConnectorAccountSummaryStatus;
  readonly className?: string;
}) {
  const { t } = useTranslation();
  const accountLabel = useConnectorAccountLabel();
  if (status === "loading") {
    return (
      <span className={className}>
        {t(($) => {
          return $.connectors.accounts.loading;
        })}
      </span>
    );
  }
  if (status === "unavailable") {
    return (
      <ConnectorEntryStatus
        className={className}
        tone="warning"
        label={t(($) => {
          return $.connectors.accounts.accountsUnavailable;
        })}
      />
    );
  }
  const accountCount = summary?.accountCount ?? 0;
  let summaryText = (() => {
    if (accountCount === 0) {
      return t(($) => {
        return $.connectors.accounts.noAccounts;
      });
    }
    if (accountCount === 1) {
      if (summary?.defaultConnection) {
        return accountLabel(summary.defaultConnection);
      }
      return t(
        ($) => {
          return $.connectors.accounts.summaryOne;
        },
        { value: accountCount },
      );
    }
    return t(
      ($) => {
        return $.connectors.accounts.summaryMany;
      },
      { value: accountCount },
    );
  })();
  if (summary && summary.attentionCount > 0) {
    summaryText = t(
      ($) => {
        return $.connectors.accounts.summaryWithAttention;
      },
      { total: accountCount, value: summary.attentionCount },
    );
  }
  return (
    <ConnectorEntryStatus
      className={className}
      label={summaryText}
      tone={
        accountCount === 0
          ? "neutral"
          : summary?.attentionCount === 0
            ? "success"
            : "warning"
      }
    />
  );
}

function AccountConnectionIndicator({ busy }: { readonly busy: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground",
        !busy && "border border-border/60",
      )}
      role={busy ? "status" : undefined}
      aria-label={
        busy
          ? t(($) => {
              return $.connectors.actions.connecting;
            })
          : undefined
      }
      aria-hidden={busy ? undefined : true}
    >
      {busy ? (
        <Loader2 size={16} className="animate-spin" />
      ) : (
        <Plus size={14} />
      )}
    </span>
  );
}

function AccountsConnectorCard({
  connector,
  summary,
  summaryStatus,
  busy,
  connect,
  manageAccess,
  onManage,
}: AccountsConnectorCardProps) {
  const { t } = useTranslation();
  const pending = useGet(connectorConnectionPending$);
  const blocked = busy || pending;
  const accountCount = summary?.accountCount ?? 0;
  const showDescription = summaryStatus === "ready" && accountCount === 0;
  const canManage = summaryStatus === "ready" && accountCount > 0;
  const canConnect = summaryStatus === "ready" && accountCount === 0;
  const canActivate = !blocked && summaryStatus === "ready";
  const activate = () => {
    if (!canActivate) {
      return;
    }
    if (canManage) {
      onManage();
      return;
    }
    if (canConnect) {
      runConnect(connector, connect, busy);
    }
  };
  return (
    <ConnectorEntryCard
      icon={<ConnectorIcon icon={connector.icon} size={20} />}
      label={connector.label}
      description={connector.description}
      showDescription={showDescription}
      interactive={canActivate}
      action={
        canManage || canConnect ? (
          <button
            type="button"
            aria-label={
              canManage
                ? t(
                    ($) => {
                      return $.connectors.accounts.managerTitle;
                    },
                    { connector: connector.label },
                  )
                : t(
                    ($) => {
                      return $.connectors.card.connectAria;
                    },
                    { connector: connector.label },
                  )
            }
            className={cn(
              "absolute inset-0 z-10 rounded-[inherit] border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              blocked ? "cursor-default" : "cursor-pointer",
            )}
            disabled={blocked}
            onClick={activate}
          />
        ) : null
      }
      indicator={
        busy || (accountCount === 0 && summaryStatus === "ready") ? (
          <AccountConnectionIndicator busy={busy} />
        ) : null
      }
      status={
        <ConnectorAccountSummaryText
          summary={summary}
          status={summaryStatus}
          className="min-w-0 flex-1 text-xs text-muted-foreground"
        />
      }
      trailingAction={
        <div className="relative z-20 min-w-0 max-w-full">{manageAccess}</div>
      }
      footer={connector.slug === "mercury" ? <MercuryDisclosure /> : undefined}
    />
  );
}

function onboardingHelpText(
  helpText: string | undefined,
  fallback: string,
): string {
  return (helpText ?? fallback)
    .replace(/^Connect your \w+ account to /u, "")
    .replace(/^Connect your Google account to /u, "")
    .replace(/^Connect /u, "");
}

function OnboardingConnectorCard({
  connectorSlug,
  connector,
  connected,
  busy,
  loading,
  layout,
  required,
  connect,
}: OnboardingConnectorCardProps) {
  const { t } = useTranslation();
  const label = connector?.label ?? connectorSlug;
  return (
    <div
      data-slot="connector-card"
      className={cn(
        "flex min-w-0 items-center gap-3",
        layout === "workflow"
          ? "border-b border-border/40 py-[18px] last:border-b-0"
          : "rounded-xl border border-border px-4 py-3.5 sm:px-5 sm:py-4",
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/40">
        <ConnectorIcon icon={connector?.icon} size={22} />
      </span>
      <div className="min-w-0 flex-1">
        <p
          data-testid="connector-card-label"
          className="truncate text-sm font-medium"
        >
          {label}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {layout === "workflow" ? (
            <span className="text-muted-foreground/70">
              {required
                ? t(($) => {
                    return $.connectors.card.required;
                  })
                : t(($) => {
                    return $.connectors.card.optional;
                  })}{" "}
              ·{" "}
            </span>
          ) : null}
          {onboardingHelpText(
            connector?.description,
            t(($) => {
              return $.connectors.card.connectToContinue;
            }),
          )}
        </p>
      </div>
      {connected ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-brand-text">
          <CircleCheck size={16} aria-hidden="true" />
          {t(($) => {
            return $.connectors.card.connected;
          })}
        </span>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 shrink-0 rounded-[10px] px-4 text-sm"
          disabled={loading || !connector || !connect || busy}
          onClick={() => {
            if (connector && connect) {
              runConnect(connector, connect, busy);
            }
          }}
        >
          {busy ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : null}
          {t(($) => {
            return $.connectors.actions.connect;
          })}
        </Button>
      )}
    </div>
  );
}

function ActionConnectorCard({
  icon,
  label,
  description,
  connected,
  complete,
  reconnectRequired,
  busy,
  className,
  onActivate,
}: ActionConnectorCardProps) {
  const { t } = useTranslation();
  const actionLabel = complete
    ? t(($) => {
        return $.connectors.card.authorized;
      })
    : reconnectRequired
      ? t(($) => {
          return $.connectors.actions.reconnect;
        })
      : connected
        ? t(($) => {
            return $.connectors.actions.authorize;
          })
        : t(($) => {
            return $.connectors.actions.connect;
          });

  return (
    <div
      data-slot="connector-card"
      data-testid="connector-action-card"
      className={cn(
        surfaceVariants(),
        "flex min-h-[88px] w-full flex-col gap-3 p-3 text-left @[640px]:flex-row @[640px]:items-center @[640px]:justify-between",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3 @[640px]:flex-1">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
          {icon}
        </div>
        <div className="min-w-0">
          <div
            data-testid="connector-card-label"
            className="truncate text-[0.9375rem] font-medium text-foreground"
          >
            {label}
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
            {description}
          </div>
        </div>
      </div>
      <button
        type="button"
        disabled={complete || busy}
        onClick={onActivate}
        className="inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-[0.9375rem] font-medium text-foreground transition-colors hover:bg-state-hover disabled:cursor-not-allowed disabled:opacity-60 @[640px]:w-auto"
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : null}
        {actionLabel}
      </button>
    </div>
  );
}

function permissionDescription(description: string): string {
  return description
    .replace(/^Connect your \w+ account to /iu, "")
    .replace(/^access /iu, "")
    .replace(/^./u, (character) => {
      return character.toUpperCase();
    });
}

function PermissionConnectorCard({
  connector,
  enabled,
  loading,
  showManage,
  isLast,
  onManage,
  onToggle,
}: PermissionConnectorCardProps) {
  return (
    <ConnectorPermissionRow
      icon={<ConnectorIcon icon={connector.icon} size={20} />}
      label={connector.label}
      labelSuffix={
        connector.connection?.externalUsername ? (
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            title={`@${connector.connection.externalUsername}`}
          >
            @{connector.connection.externalUsername}
          </span>
        ) : undefined
      }
      description={
        connector.description
          ? permissionDescription(connector.description)
          : undefined
      }
      enabled={enabled}
      loading={loading}
      showManage={showManage}
      isLast={isLast}
      onManage={onManage}
      onToggle={onToggle}
    />
  );
}

export function ConnectorCard(props: ConnectorCardProps) {
  if (props.variant === "catalog") {
    return <CatalogConnectorCard {...props} />;
  }
  if (props.variant === "directory") {
    return <DirectoryConnectorCard {...props} />;
  }
  if (props.variant === "accounts") {
    return <AccountsConnectorCard {...props} />;
  }
  if (props.variant === "onboarding") {
    return <OnboardingConnectorCard {...props} />;
  }
  if (props.variant === "action") {
    return <ActionConnectorCard {...props} />;
  }
  return <PermissionConnectorCard {...props} />;
}
