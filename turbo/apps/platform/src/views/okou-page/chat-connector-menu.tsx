import type { ReactNode } from "react";
import type { ChatConnectorAccess } from "@okouai/api-contracts/contracts/chat-connector-access";
import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";
import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorAccountExternalIdentity } from "@okouai/api-contracts/validators/connector-accounts";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  ChevronRight,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import { Button, Input, Radio, RadioGroup, PopoverClose } from "@okouai/ui";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type {
  ChatConnectorOverview,
  ChatConnectorMenuTarget,
} from "../../signals/okou-page/chat-connector-access.ts";
import { connectorAccountTargetKey } from "../../signals/okou-page/connector-accounts.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { chatThreadMetaMap$ } from "../../signals/chat-page/chat-thread-event-sourcing.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { AccessChoiceSelect } from "./remote-access-controls.tsx";
import { useConnectorAccountLabel } from "./components/settings/use-connector-account-label.ts";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { CustomConnectorIcon } from "./components/settings/custom-connector-icon.tsx";
import { Link } from "../router/link.tsx";

function ChatAccountChoiceRow({
  account,
  access,
  busy,
  onChange,
}: {
  readonly account: ConnectorAccountConnection;
  readonly access: ChatConnectorAccess["accounts"][number];
  readonly busy: boolean;
  readonly onChange: (enabled: boolean | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const name = useConnectorAccountLabel()(account);
  const identity = connectorAccountExternalIdentity(account);
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-state-hover">
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
        <Radio
          value={account.id}
          disabled={!access.enabled || account.connectionStatus !== "connected"}
          aria-label={name}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{name}</span>
          {identity && identity !== name && (
            <span className="block truncate text-xs text-muted-foreground">
              {identity}
            </span>
          )}
          {account.connectionStatus !== "connected" && (
            <span className="block truncate text-xs text-muted-foreground">
              {t(($) => {
                return $.connectors.accounts.reconnectRequired;
              })}
            </span>
          )}
        </span>
      </label>
      <AccessChoiceSelect
        ariaLabel={t(
          ($) => {
            return $.connectorChatAccess.accountAccess;
          },
          { account: name },
        )}
        defaultEnabled={access.defaultEnabled}
        value={
          access.overrideEnabled === null
            ? "default"
            : access.overrideEnabled
              ? "on"
              : "off"
        }
        readOnly={busy}
        onChange={onChange}
      />
    </div>
  );
}

function ChatAccountChoices({
  signals,
  entry,
}: {
  readonly signals: ComposerSignals;
  readonly entry: ChatConnectorOverview;
}) {
  const { t } = useTranslation();
  const accounts = signals.connector.chatAccess;
  const list = useLoadable(accounts.list.accounts$);
  const previous = useLastResolved(accounts.list.accounts$);
  const search = useGet(accounts.list.search$);
  const setSearch = useSet(accounts.list.setSearch$);
  const [selecting, select] = useLoadableSet(accounts.select$);
  const [saving, override] = useLoadableSet(accounts.setOverride$);
  const [loadingMore, loadMore] = useLoadableSet(accounts.list.loadMore$);
  const signal = useGet(pageSignal$);
  const page =
    list.state === "hasData"
      ? list.data
      : list.state === "loading"
        ? previous
        : undefined;
  const rows = page?.connections ?? [];
  const displayed =
    !search &&
    entry.current &&
    !rows.some((row) => {
      return row.id === entry.current?.id;
    })
      ? [entry.current, ...rows]
      : rows;
  const busy = selecting.state === "loading" || saving.state === "loading";
  return (
    <>
      {(entry.access.accounts.length > 6 || search) && (
        <div className="px-3 pb-2">
          <Input
            value={search}
            aria-label={t(($) => {
              return $.connectors.accounts.find;
            })}
            placeholder={t(($) => {
              return $.connectors.accounts.find;
            })}
            onChange={(event) => {
              setSearch(event.currentTarget.value, signal);
            }}
          />
        </div>
      )}
      <RadioGroup
        value={entry.access.currentConnectionId}
        disabled={busy}
        onValueChange={(connectionId: string) => {
          detach(select(connectionId, signal), Reason.DomCallback);
        }}
        className="min-h-0 overflow-y-auto px-1"
      >
        {displayed.map((account) => {
          const access = entry.access.accounts.find((candidate) => {
            return candidate.connectionId === account.id;
          });
          return access ? (
            <ChatAccountChoiceRow
              key={account.id}
              account={account}
              access={access}
              busy={busy}
              onChange={(enabled) => {
                return override(account.id, enabled, signal);
              }}
            />
          ) : null;
        })}
      </RadioGroup>
      {list.state === "loading" && !page && (
        <p className="px-3 py-2 text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.accounts.loading;
          })}
        </p>
      )}
      {list.state === "hasError" && (
        <p className="px-3 py-2 text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.accounts.accountsUnavailable;
          })}
        </p>
      )}
      {page?.nextCursor && (
        <Button
          variant="ghost"
          disabled={loadingMore.state === "loading"}
          onClick={() => {
            detach(loadMore(signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.connectors.accounts.loadMore;
          })}
        </Button>
      )}
      {!entry.access.currentConnectionId && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t(($) => {
            return $.connectorChatAccess.noEnabledAccount;
          })}
        </p>
      )}
    </>
  );
}

function ConnectorOverviewRow({
  entry,
  icon,
  onOpen,
}: {
  readonly entry: ChatConnectorOverview;
  readonly icon: PublicConnectorCatalogIcon | undefined;
  readonly onOpen: () => void;
}) {
  const { t } = useTranslation();
  const accountLabel = useConnectorAccountLabel();
  const currentName = entry.current
    ? accountLabel(entry.current)
    : t(($) => {
        return $.connectorChatAccess.noAccount;
      });
  const identity = entry.current
    ? connectorAccountExternalIdentity(entry.current)
    : null;
  const currentLabel =
    identity && identity !== currentName
      ? `${currentName} · ${identity}`
      : currentName;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-state-hover"
    >
      {entry.target.kind === "builtin" ? (
        <ConnectorIcon icon={icon} size={20} />
      ) : (
        <CustomConnectorIcon
          id={entry.target.customConnectorId}
          displayName={entry.label}
          size={20}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{entry.label}</span>
        <span
          title={currentLabel}
          className="block truncate text-xs text-muted-foreground"
        >
          {currentLabel}
        </span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {t(
          ($) => {
            return $.connectorChatAccess.enabledAccounts;
          },
          {
            value: entry.access.accounts.filter((account) => {
              return account.enabled;
            }).length,
          },
        )}
      </span>
      <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
    </button>
  );
}

function ChatConnectorOverviewList({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const accounts = signals.connector.chatAccess;
  const overview = useLoadable(accounts.overview$);
  const previous = useLastResolved(accounts.overview$);
  const connected = useLoadable(signals.connector.resources.connected$);
  const ui = useGet(signals.connector.connectorUiState$);
  const updateUi = useSet(signals.connector.updateConnectorUiState$);
  const open = useSet(accounts.openTarget$);
  const signal = useGet(pageSignal$);
  const entries =
    overview.state === "hasData"
      ? overview.data
      : overview.state === "loading"
        ? (previous ?? [])
        : [];
  const filtered = entries.filter((entry) => {
    return entry.label.toLowerCase().includes(ui.popoverSearch.toLowerCase());
  });
  return (
    <>
      {entries.length > 20 && (
        <div className="px-3 pb-2">
          <Input
            value={ui.popoverSearch}
            aria-label={t(($) => {
              return $.chat.connectors.find;
            })}
            placeholder={t(($) => {
              return $.chat.connectors.find;
            })}
            onChange={(event) => {
              updateUi({ popoverSearch: event.currentTarget.value });
            }}
          />
        </div>
      )}
      <div className="min-h-0 overflow-y-auto p-1">
        {filtered.map((entry) => {
          const icon =
            connected.state === "hasData"
              ? connected.data.builtinConnectors.find((connector) => {
                  return (
                    entry.target.kind === "builtin" &&
                    connector.slug === entry.target.connectorSlug
                  );
                })?.icon
              : undefined;
          return (
            <ConnectorOverviewRow
              key={connectorAccountTargetKey(entry.target)}
              entry={entry}
              icon={icon}
              onOpen={() => {
                open(entry, signal);
              }}
            />
          );
        })}
        {overview.state === "loading" && !previous && (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            {t(($) => {
              return $.connectors.accounts.loading;
            })}
          </p>
        )}
        {overview.state === "hasError" && (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            {t(($) => {
              return $.connectors.accounts.accountsUnavailable;
            })}
          </p>
        )}
      </div>
    </>
  );
}

function AccountPanelFooter({
  signals,
  target,
  savedAccounts,
}: {
  readonly signals: ComposerSignals;
  readonly target: ChatConnectorMenuTarget;
  readonly savedAccounts: boolean;
}) {
  const { t } = useTranslation();
  const permissions = useSet(signals.connector.chatAccess.setPermissions$);
  const permissionTarget =
    target.target.kind === "builtin" && target.hasPermissions
      ? { target: target.target, label: target.label }
      : null;
  return (
    <div className="mt-1 flex shrink-0 items-center justify-between border-t border-border/50 p-1">
      <div>
        {permissionTarget && (
          <PopoverClose
            render={
              <Button
                variant="ghost"
                size="sm"
                disabled={!savedAccounts}
                onClick={() => {
                  permissions(permissionTarget);
                }}
              >
                <SlidersHorizontal size={15} />
                {t(($) => {
                  return $.connectorChatAccess.permissions;
                })}
              </Button>
            }
          />
        )}
      </div>
      <Link
        pathname="/connectors"
        options={{
          searchParams: new URLSearchParams({ keywords: target.label }),
        }}
        aria-label={t(($) => {
          return $.connectorChatAccess.manageAccounts;
        })}
        className="rounded-md p-2 text-muted-foreground hover:bg-state-hover"
      >
        <Settings2 size={15} />
      </Link>
    </div>
  );
}

export function ChatConnectorMenu({
  signals,
  footer,
  onOpenAddDialog,
}: {
  readonly signals: ComposerSignals;
  readonly footer: ReactNode;
  readonly onOpenAddDialog: () => void;
}) {
  const { t } = useTranslation();
  const accounts = signals.connector.chatAccess;
  const overview = useLoadable(accounts.overview$);
  const previous = useLastResolved(accounts.overview$);
  const target = useGet(accounts.target$);
  const back = useSet(accounts.closeTarget$);
  const threads = useGet(chatThreadMetaMap$);
  const title =
    (signals.threadId ? threads.get(signals.threadId)?.title : null) ||
    t(($) => {
      return $.connectorChatAccess.thisChat;
    });
  const entries =
    overview.state === "hasData"
      ? overview.data
      : overview.state === "loading"
        ? (previous ?? [])
        : [];
  const active = target
    ? entries.find((entry) => {
        return (
          connectorAccountTargetKey(entry.target) ===
          connectorAccountTargetKey(target.target)
        );
      })
    : null;
  return (
    <div className="flex min-h-0 max-h-[min(32rem,70vh)] w-full flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
        {target && (
          <IconTooltipButton
            aria-label={t(($) => {
              return $.chat.connectors.back;
            })}
            className="rounded-md p-1 text-muted-foreground hover:bg-state-hover"
            onClick={() => {
              back();
            }}
          >
            <ChevronLeft size={16} />
          </IconTooltipButton>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {target?.label ??
              t(($) => {
                return $.chat.connectors.title;
              })}
          </p>
          <p className="truncate text-xs text-muted-foreground">{title}</p>
        </div>
      </div>
      {target ? (
        <>
          {active ? (
            <ChatAccountChoices signals={signals} entry={active} />
          ) : (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              {overview.state === "hasError"
                ? t(($) => {
                    return $.connectors.accounts.accountsUnavailable;
                  })
                : t(($) => {
                    return $.connectors.accounts.loading;
                  })}
            </p>
          )}
          <AccountPanelFooter
            signals={signals}
            target={target}
            savedAccounts={Boolean(active?.access.accounts.length)}
          />
        </>
      ) : (
        <>
          <ChatConnectorOverviewList signals={signals} />
          <div className="shrink-0 border-t border-border/50 p-1">
            <PopoverClose
              render={
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => {
                    onOpenAddDialog();
                  }}
                >
                  {t(($) => {
                    return $.chat.connectors.addConnectors;
                  })}
                </Button>
              }
            />
          </div>
          {footer}
        </>
      )}
    </div>
  );
}
