import { LoadingSkeleton } from "../components/loading-skeleton.tsx";
import type { ReactNode } from "react";
import type { ChatConnectorAccess } from "@okouai/api-contracts/contracts/chat-connector-access";
import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorAccountExternalIdentity } from "@okouai/api-contracts/validators/connector-accounts";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { ChevronRight, SlidersHorizontal, Users } from "lucide-react";
import {
  Button,
  Input,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  Switch,
} from "@okouai/ui";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type {
  ChatConnectorOverview,
  ChatConnectorMenuTarget,
} from "../../signals/okou-page/chat-connector-access.ts";
import { connectorAccountTargetKey } from "../../signals/okou-page/connector-accounts.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { useConnectorAccountLabel } from "./components/settings/use-connector-account-label.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { CustomConnectorIcon } from "./components/settings/custom-connector-icon.tsx";
import { ComposerConnectorMenuShell } from "./composer-connector-menu-shell.tsx";

function ChatAccountChoiceRow({
  account,
  access,
  busy,
  onChange,
}: {
  readonly account: ConnectorAccountConnection;
  readonly access: ChatConnectorAccess["accounts"][number];
  readonly busy: boolean;
  readonly onChange: (enabled: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const name = useConnectorAccountLabel()(account);
  const identity = connectorAccountExternalIdentity(account);
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-state-hover">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
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
      </div>
      <Switch
        size="compact"
        aria-label={t(
          ($) => {
            return $.connectorChatAccess.accountAccess;
          },
          { account: name },
        )}
        checked={access.enabled}
        readOnly={busy}
        aria-busy={busy || undefined}
        className="aria-readonly:opacity-50"
        onCheckedChange={(enabled) => {
          detach(onChange(enabled), Reason.DomCallback);
        }}
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
  const current = useLoadable(accounts.current$);
  const previous = useLastResolved(accounts.list.accounts$);
  const search = useGet(accounts.list.search$);
  const setSearch = useSet(accounts.list.setSearch$);
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
    current.state === "hasData" &&
    current.data &&
    !rows.some((row) => {
      return row.id === current.data?.id;
    })
      ? [current.data, ...rows]
      : rows;
  const busy = saving.state === "loading";
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
      <div className="px-1">
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
      </div>
      {list.state === "loading" && !page && (
        <LoadingSkeleton
          label={t(($) => {
            return $.connectors.accounts.loading;
          })}
          variant="rows"
          className="px-3 py-2"
        />
      )}
      {(list.state === "hasError" || current.state === "hasError") && (
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
    </>
  );
}

function ConnectorOverviewRow({
  signals,
  entry,
}: {
  readonly signals: ComposerSignals;
  readonly entry: ChatConnectorOverview;
}) {
  const { t } = useTranslation();
  const target = useGet(signals.connector.chatAccess.target$);
  const openTarget = useSet(signals.connector.chatAccess.openTarget$);
  const closeTarget = useSet(signals.connector.chatAccess.closeTarget$);
  const restoreFocus = useSet(
    signals.connector.chatAccess.navigation.restoreFocus$,
  );
  const permissions = useGet(signals.connector.chatAccess.permissions$);
  const accountManagerOpen = useGet(
    signals.connector.chatAccess.accountManager.managerOpen$,
  );
  const signal = useGet(pageSignal$);
  const open =
    target !== null &&
    connectorAccountTargetKey(target.target) ===
      connectorAccountTargetKey(entry.target);
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          openTarget(entry, signal);
        } else if (open) {
          closeTarget();
        }
      }}
    >
      <PopoverTrigger
        data-connector-target={connectorAccountTargetKey(entry.target)}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-state-hover data-popup-open:bg-gray-50"
      >
        {entry.target.kind === "builtin" ? (
          <ConnectorIcon icon={entry.icon ?? undefined} size={20} />
        ) : (
          <CustomConnectorIcon
            id={entry.target.customConnectorId}
            displayName={entry.label}
            size={20}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-sm">{entry.label}</span>
        {entry.access.accounts.length > 1 && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {t(
              ($) => {
                return $.connectorChatAccess.totalAccounts;
              },
              { value: entry.access.accounts.length },
            )}
          </span>
        )}
        <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        collisionAvoidance={{ fallbackAxisSide: "end" }}
        finalFocus={() => {
          return permissions !== null || accountManagerOpen
            ? false
            : restoreFocus(entry.target);
        }}
        aria-label={entry.label}
        className="flex max-h-[min(25rem,var(--available-height))] w-88 max-w-[var(--available-width)] flex-col overflow-hidden p-0"
      >
        {open && <ChatConnectorAccountPanel signals={signals} entry={entry} />}
      </PopoverContent>
    </Popover>
  );
}

function ChatConnectorOverviewList({
  signals,
  entries,
}: {
  readonly signals: ComposerSignals;
  readonly entries: readonly ChatConnectorOverview[];
}) {
  return (
    <div className="p-1">
      {entries.map((entry) => {
        return (
          <div role="listitem" key={connectorAccountTargetKey(entry.target)}>
            <ConnectorOverviewRow signals={signals} entry={entry} />
          </div>
        );
      })}
    </div>
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
  const [openingAccountManager, openAccountManager] = useLoadableSet(
    signals.connector.openAccountManager$,
  );
  const signal = useGet(pageSignal$);
  const setPopoverOpen = useSet(signals.connector.setPopoverOpen$);
  const permissionTarget =
    target.target.kind === "builtin" && target.hasPermissions
      ? { target: target.target, label: target.label }
      : null;
  return (
    <div className="flex shrink-0 flex-col border-t border-border/50 p-1">
      {permissionTarget && (
        <PopoverClose
          render={
            <Button
              variant="quiet"
              className="w-full justify-start px-2 font-normal text-foreground"
              disabled={!savedAccounts}
              onClick={() => {
                permissions(permissionTarget);
                setPopoverOpen(false);
              }}
            >
              <SlidersHorizontal
                size={16}
                aria-hidden="true"
                className="text-muted-foreground"
              />
              {t(($) => {
                return $.connectorChatAccess.permissions;
              })}
            </Button>
          }
        />
      )}
      <Button
        variant="quiet"
        className="w-full justify-start px-2 font-normal text-foreground"
        pending={openingAccountManager.state === "loading"}
        onClick={() => {
          detach(openAccountManager(target.target, signal), Reason.DomCallback);
        }}
      >
        <Users size={16} aria-hidden="true" className="text-muted-foreground" />
        {t(($) => {
          return $.connectorChatAccess.manageAccounts;
        })}
      </Button>
    </div>
  );
}

function ChatConnectorOverviewRetry({
  signals,
  failed,
}: {
  readonly signals: ComposerSignals;
  readonly failed: boolean;
}) {
  const { t } = useTranslation();
  const retry = useSet(signals.connector.chatAccess.retry$);
  if (!failed) {
    return null;
  }
  return (
    <div role="listitem">
      <Button
        variant="quiet"
        onClick={() => {
          retry();
        }}
      >
        {t(($) => {
          return $.chat.errors.recovery.tryAgain;
        })}
      </Button>
    </div>
  );
}

function ChatConnectorAccountPanel({
  signals,
  entry,
}: {
  readonly signals: ComposerSignals;
  readonly entry: ChatConnectorOverview;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="shrink-0 border-b border-border/50 px-3 py-3">
        <p className="truncate text-sm font-medium">{entry.label}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(($) => {
            return $.connectorChatAccess.accountsInChat;
          })}
        </p>
      </div>
      <div
        role="group"
        aria-label={entry.label}
        className="min-h-0 flex-1 overflow-y-auto py-2"
      >
        <ChatAccountChoices signals={signals} entry={entry} />
      </div>
      <AccountPanelFooter
        signals={signals}
        target={entry}
        savedAccounts={entry.access.accounts.length > 0}
      />
    </>
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
  const notifications = useLoadable(accounts.notifications$);
  const failed =
    overview.state === "hasError" || notifications.state === "hasError";
  const previous = useLastResolved(accounts.overview$);
  const setViewport = useSet(accounts.navigation.setViewport$);
  const ui = useGet(signals.connector.connectorUiState$);
  const searchConnectors = useSet(signals.connector.searchConnectors$);
  const entries =
    overview.state === "hasData" ? overview.data : (previous ?? []);
  const showSearch = entries.length > 20;
  const filtered =
    showSearch && ui.popoverSearch.trim()
      ? entries.filter((entry) => {
          return entry.label
            .toLowerCase()
            .includes(ui.popoverSearch.toLowerCase());
        })
      : entries;
  return (
    <ComposerConnectorMenuShell
      loading={overview.state === "loading" && !previous}
      hasContent={entries.length > 0 || failed}
      error={
        failed
          ? t(($) => {
              return $.connectors.accounts.accountsUnavailable;
            })
          : undefined
      }
      showSearch={showSearch}
      search={ui.popoverSearch}
      onSearchChange={searchConnectors}
      onOpenAddDialog={onOpenAddDialog}
      footer={footer}
      contentKey={`overview:${ui.popoverSearch}`}
      contentRef={setViewport}
    >
      <ChatConnectorOverviewRetry signals={signals} failed={failed} />
      <ChatConnectorOverviewList signals={signals} entries={filtered} />
    </ComposerConnectorMenuShell>
  );
}
