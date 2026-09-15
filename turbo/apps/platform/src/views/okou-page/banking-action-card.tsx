import type {
  BankingAccessRequestStatusResponse,
  BankingConnectSessionRequest,
  BankingGrantDuration,
} from "@okouai/api-contracts/contracts/banking";
import {
  Button,
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@okouai/ui";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import {
  AlertCircle,
  Landmark,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { i18n } from "../../i18n/index.ts";
import { ChatCard } from "./components/chat-card.tsx";
import { ChatCardDetails } from "./components/chat-card-details.tsx";
import type {
  BankingCardUiState,
  BankingSignals,
} from "../../signals/chat-page/banking-action-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { Reason, detach, tapError } from "../../signals/utils.ts";

type BankingConnection = NonNullable<
  BankingAccessRequestStatusResponse["connection"]
>;
type BankingAccount = BankingConnection["accounts"][number];
type BankingGrant = NonNullable<BankingAccessRequestStatusResponse["grant"]>;
type UpdateBankingUi = (patch: Partial<BankingCardUiState>) => void;
type OpenBankingConnect = (
  mode: BankingConnectSessionRequest["mode"],
  institutionLoginId?: string,
) => void;
type SaveBankingGrant = (
  args: {
    readonly accountIds: readonly string[];
    readonly duration: BankingGrantDuration;
  },
  signal: AbortSignal,
) => Promise<BankingAccessRequestStatusResponse>;

const BANKING_GRANT_DURATIONS: readonly BankingGrantDuration[] = [
  "1h",
  "24h",
  "7d",
  "30d",
];

const BANKING_CARD_HEIGHT_CLASS = "h-[136px] @[900px]:h-[88px]";

interface BankingCardController {
  readonly status: BankingAccessRequestStatusResponse;
  readonly activeGrant: BankingGrant | null;
  readonly activeGrantAccountCount: number;
  readonly grantMatchesRequest: boolean;
  readonly selectedAccountIds: ReadonlySet<string>;
  readonly healthyAccounts: readonly BankingAccount[];
  readonly editing: boolean;
  readonly pending: boolean;
  readonly ui: BankingCardUiState;
  readonly pendingSessionPollerRef: (element: HTMLElement | null) => void;
  readonly updateUi: UpdateBankingUi;
  readonly openConnect: OpenBankingConnect;
  readonly save: () => void;
  readonly revoke: () => void;
  readonly runContinue: () => void;
  readonly updateAccountSelection: (
    accountId: string,
    selected: boolean,
  ) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : i18n.t(($) => {
        return $.chat.banking.actionFailed;
      });
}

function isBankingGrantDuration(value: string): value is BankingGrantDuration {
  return BANKING_GRANT_DURATIONS.some((duration) => {
    return duration === value;
  });
}

function openBankingConnect(
  {
    mode,
    institutionLoginId,
    popupBlockedMessage,
    startSession,
    updateUi,
  }: {
    readonly mode: BankingConnectSessionRequest["mode"];
    readonly institutionLoginId?: string;
    readonly popupBlockedMessage: string;
    readonly startSession: BankingCardControllerStartSession;
    readonly updateUi: UpdateBankingUi;
  },
  pageSignal: AbortSignal,
): void {
  const popup = window.open("about:blank", "_blank");
  if (!popup) {
    updateUi({ localError: popupBlockedMessage });
    return;
  }
  popup.opener = null;
  updateUi({ localError: null, busy: "connect" });
  detach(
    (async () => {
      const url = await tapError(
        startSession({ mode, institutionLoginId }, pageSignal),
        (error) => {
          popup.close();
          updateUi({ localError: errorMessage(error) });
        },
      );
      if (url) {
        popup.location.replace(url);
      }
      updateUi({ busy: null });
    })(),
    Reason.DomCallback,
    "start Mastercard Data Connect",
  );
}

type BankingCardControllerStartSession = (
  args: {
    readonly mode: BankingConnectSessionRequest["mode"];
    readonly institutionLoginId?: string;
  },
  signal: AbortSignal,
) => Promise<string>;

function saveBankingGrant(
  {
    accountIds,
    duration,
    saveGrant,
    updateUi,
  }: {
    readonly accountIds: ReadonlySet<string>;
    readonly duration: BankingCardUiState["duration"];
    readonly saveGrant: SaveBankingGrant;
    readonly updateUi: UpdateBankingUi;
  },
  pageSignal: AbortSignal,
): void {
  if (accountIds.size === 0) {
    return;
  }
  updateUi({ localError: null, busy: "save" });
  detach(
    (async () => {
      const saved = await tapError(
        saveGrant({ accountIds: [...accountIds], duration }, pageSignal),
        (error) => {
          updateUi({ localError: errorMessage(error) });
        },
      );
      updateUi({ busy: null, ...(saved ? { editing: false } : {}) });
    })(),
    Reason.DomCallback,
    "save banking grant",
  );
}

function revokeBankingGrant(
  {
    revokeGrant,
    updateUi,
  }: {
    readonly revokeGrant: (signal: AbortSignal) => Promise<unknown>;
    readonly updateUi: UpdateBankingUi;
  },
  pageSignal: AbortSignal,
): void {
  updateUi({ localError: null, busy: "revoke" });
  detach(
    (async () => {
      const revoked = await tapError(revokeGrant(pageSignal), (error) => {
        updateUi({ localError: errorMessage(error) });
      });
      updateUi({
        busy: null,
        ...(revoked
          ? {
              confirmingRevoke: false,
              editing: true,
              selectedAccountIds: [],
            }
          : {}),
      });
    })(),
    Reason.DomCallback,
    "revoke banking grant",
  );
}

function continueBankingChat(
  {
    continueChat,
    updateUi,
  }: {
    readonly continueChat: (signal: AbortSignal) => Promise<void>;
    readonly updateUi: UpdateBankingUi;
  },
  pageSignal: AbortSignal,
): void {
  updateUi({ localError: null, busy: "continue" });
  detach(
    (async () => {
      await tapError(continueChat(pageSignal), (error) => {
        updateUi({ localError: errorMessage(error) });
      });
      updateUi({ busy: null });
    })(),
    Reason.DomCallback,
    "continue banking chat callback",
  );
}

function useBankingCardController(
  signals: BankingSignals,
  status: BankingAccessRequestStatusResponse,
): BankingCardController {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const ui = useGet(signals.uiState$);
  const updateUi = useSet(signals.updateUiState$);
  const startSession = useSet(signals.startSession$);
  const saveGrant = useSet(signals.saveGrant$);
  const revokeGrant = useSet(signals.revokeGrant$);
  const continueChat = useSet(signals.continue$);
  const pendingSessionPollerRef = useSet(signals.pendingSessionPollerRef$);
  const activeGrant = status.grant?.status === "active" ? status.grant : null;
  const healthyAccounts =
    status.connection?.accounts.filter((account) => {
      return !account.repairRequired;
    }) ?? [];
  const healthyAccountIds = new Set(
    healthyAccounts.map((account) => {
      return account.id;
    }),
  );
  const activeGrantAccountIds =
    activeGrant?.accountIds.filter((accountId) => {
      return healthyAccountIds.has(accountId);
    }) ?? [];
  const selectedAccountIds = new Set(
    (ui.selectedAccountIds ?? activeGrantAccountIds).filter((accountId) => {
      return healthyAccountIds.has(accountId);
    }),
  );
  const popupBlockedMessage = t(($) => {
    return $.chat.banking.popupBlocked;
  });

  return {
    status,
    activeGrant,
    activeGrantAccountCount: activeGrantAccountIds.length,
    grantMatchesRequest: activeGrant?.purpose === signals.reason,
    selectedAccountIds,
    healthyAccounts,
    editing: ui.editing ?? activeGrant === null,
    pending: status.session?.status === "pending",
    ui,
    pendingSessionPollerRef,
    updateUi,
    openConnect: (mode, institutionLoginId) => {
      openBankingConnect(
        {
          mode,
          institutionLoginId,
          popupBlockedMessage,
          startSession,
          updateUi,
        },
        pageSignal,
      );
    },
    save: () => {
      saveBankingGrant(
        {
          accountIds: selectedAccountIds,
          duration: ui.duration,
          saveGrant,
          updateUi,
        },
        pageSignal,
      );
    },
    revoke: () => {
      revokeBankingGrant({ revokeGrant, updateUi }, pageSignal);
    },
    runContinue: () => {
      continueBankingChat({ continueChat, updateUi }, pageSignal);
    },
    updateAccountSelection: (accountId, selected) => {
      const next = new Set(selectedAccountIds);
      if (selected) {
        next.add(accountId);
      } else {
        next.delete(accountId);
      }
      updateUi({ selectedAccountIds: [...next] });
    },
  };
}

export function BankingActionCard({ signals }: { signals: BankingSignals }) {
  return (
    <ChatCard
      data-testid="banking-action-card-shell"
      className={cn("w-full", BANKING_CARD_HEIGHT_CLASS)}
    >
      <BankingActionCardState signals={signals} />
    </ChatCard>
  );
}

function BankingActionCardState({ signals }: { signals: BankingSignals }) {
  const loadable = useLoadable(signals.status$);
  const last = useLastLoadable(signals.status$);
  if (loadable.state === "loading" && last.state !== "hasData") {
    return <BankingActionCardLoading />;
  }
  if (loadable.state === "hasError" && last.state !== "hasData") {
    return <BankingActionCardError signals={signals} />;
  }
  const status =
    loadable.state === "hasData"
      ? loadable.data
      : last.state === "hasData"
        ? last.data
        : null;
  return status ? (
    <LoadedBankingActionCard signals={signals} status={status} />
  ) : (
    <BankingActionCardError signals={signals} />
  );
}

function BankingActionCardLoading() {
  return (
    <div
      data-testid="banking-action-card-loading"
      className={cn("flex h-full w-full items-center justify-center p-3")}
    >
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

function BankingActionCardError({ signals }: { signals: BankingSignals }) {
  const refresh = useSet(signals.refresh$);
  const { t } = useTranslation();
  return (
    <div
      data-testid="banking-action-card-error"
      className={cn("flex h-full w-full items-center gap-3 p-3")}
    >
      <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 line-clamp-3 text-sm leading-5 text-muted-foreground">
        {t(($) => {
          return $.chat.banking.loadFailed;
        })}
      </div>
      <Button size="sm" variant="outline" onClick={refresh}>
        {t(($) => {
          return $.chat.banking.retry;
        })}
      </Button>
    </div>
  );
}

function LoadedBankingActionCard({
  signals,
  status,
}: {
  readonly signals: BankingSignals;
  readonly status: BankingAccessRequestStatusResponse;
}) {
  const { t } = useTranslation();
  const controller = useBankingCardController(signals, status);
  const summary =
    controller.ui.localError ??
    (controller.pending
      ? t(($) => {
          return $.chat.banking.waiting;
        })
      : controller.activeGrant &&
          controller.grantMatchesRequest &&
          controller.activeGrantAccountCount > 0
        ? t(
            ($) => {
              return $.chat.banking.active;
            },
            {
              count: controller.activeGrantAccountCount,
            },
          )
        : signals.reason);
  return (
    <div
      data-testid="banking-action-card"
      className="flex h-full w-full flex-col justify-between gap-3 p-3 text-left @[900px]:flex-row @[900px]:items-center"
    >
      {controller.pending ? (
        <span ref={controller.pendingSessionPollerRef} hidden />
      ) : null}
      <BankingCardHeader
        agentName={status.agent.name}
        reason={summary}
        compact
      />
      <ChatCardDetails
        title={t(($) => {
          return $.chat.banking.title;
        })}
      >
        <BankingCardHeader
          agentName={status.agent.name}
          reason={signals.reason}
          compact={false}
        />
        <BankingCardErrorMessage message={controller.ui.localError} />
        <BankingCardContent controller={controller} compact={false} />
      </ChatCardDetails>
    </div>
  );
}

function BankingCardHeader({
  agentName,
  reason,
  compact,
}: {
  readonly agentName: string;
  readonly reason: string;
  readonly compact: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
        <Landmark className="h-5 w-5 text-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[0.9375rem] font-medium leading-5 text-foreground">
          {t(($) => {
            return $.chat.banking.title;
          })}
        </div>
        <div
          className={cn(
            "mt-0.5 text-sm leading-5 text-muted-foreground",
            compact && "truncate",
          )}
        >
          <span className="font-medium text-foreground/80">{agentName}</span>
          <span aria-hidden="true"> · </span>
          <span>{reason}</span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
          <span className={cn("min-w-0 flex-1", compact && "truncate")}>
            {t(($) => {
              return $.chat.banking.readOnly;
            })}
          </span>
        </div>
      </div>
    </div>
  );
}

function BankingCardErrorMessage({
  message,
}: {
  readonly message: string | null;
}) {
  return message ? (
    <div className="mt-3 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  ) : null;
}

function BankingCardContent({
  controller,
  compact,
}: {
  readonly controller: BankingCardController;
  readonly compact: boolean;
}) {
  if (controller.pending) {
    return <BankingPendingNotice controller={controller} compact={compact} />;
  }
  const connection = controller.status.connection;
  if (!connection) {
    return (
      <ConnectBankButton
        busy={controller.ui.busy !== null}
        connecting={controller.ui.busy === "connect"}
        openConnect={controller.openConnect}
        compact={compact}
      />
    );
  }
  return (
    <>
      <BankingRepairNotices
        connection={connection}
        busy={controller.ui.busy !== null}
        openConnect={controller.openConnect}
      />
      {controller.activeGrant &&
      controller.activeGrantAccountCount > 0 &&
      controller.grantMatchesRequest &&
      !controller.editing ? (
        <ActiveBankingGrant controller={controller} />
      ) : (
        <BankingGrantEditor controller={controller} connection={connection} />
      )}
    </>
  );
}

function BankingPendingNotice({
  controller,
  compact,
}: {
  readonly controller: BankingCardController;
  readonly compact: boolean;
}) {
  const { t } = useTranslation();
  const session = controller.status.session;
  return (
    <div
      className={cn(
        "flex w-full shrink-0 items-center gap-2 rounded-md bg-muted/50 px-3 text-sm text-muted-foreground @[900px]:w-auto",
        compact ? "h-9 @[900px]:h-auto @[900px]:py-2" : "mt-4 py-2",
      )}
    >
      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
      <span className="min-w-0 flex-1 truncate">
        {t(($) => {
          return $.chat.banking.waiting;
        })}
      </span>
      {session ? (
        <Button
          size="sm"
          variant="outline"
          className="h-9 shrink-0"
          disabled={controller.ui.busy !== null}
          onClick={() => {
            controller.openConnect(
              session.mode,
              session.institutionLoginId ?? undefined,
            );
          }}
        >
          {t(($) => {
            return $.chat.banking.retry;
          })}
        </Button>
      ) : null}
    </div>
  );
}

function ConnectBankButton({
  busy,
  connecting,
  openConnect,
  compact,
}: {
  readonly busy: boolean;
  readonly connecting: boolean;
  readonly openConnect: OpenBankingConnect;
  readonly compact: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex w-full shrink-0 justify-end @[900px]:w-auto",
        !compact && "mt-4",
      )}
    >
      <Button
        size="sm"
        variant="outline"
        className="h-9 w-full @[900px]:w-auto"
        disabled={busy}
        onClick={() => {
          openConnect("connect");
        }}
      >
        {connecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        {t(($) => {
          return $.chat.banking.connect;
        })}
      </Button>
    </div>
  );
}

function BankingRepairNotices({
  connection,
  busy,
  openConnect,
}: {
  readonly connection: BankingConnection;
  readonly busy: boolean;
  readonly openConnect: OpenBankingConnect;
}) {
  const { t } = useTranslation();
  return connection.repairInstitutions.map((institution) => {
    const name =
      institution.institutionName ??
      t(($) => {
        return $.chat.banking.institutionFallback;
      });
    return (
      <div
        key={institution.institutionLoginId}
        className="mt-3 flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2"
      >
        <div className="min-w-0 text-sm text-amber-800 dark:text-amber-300">
          {t(
            ($) => {
              return $.chat.banking.repairRequired;
            },
            { institution: name },
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            openConnect("fix", institution.institutionLoginId);
          }}
        >
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          {t(($) => {
            return $.chat.banking.repair;
          })}
        </Button>
      </div>
    );
  });
}

function ActiveBankingGrant({
  controller,
}: {
  readonly controller: BankingCardController;
}) {
  const { t } = useTranslation();
  const grant = controller.activeGrant;
  if (!grant) {
    return null;
  }
  return (
    <div className="mt-4 rounded-md border border-border/70 px-3 py-3">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ShieldCheck className="h-4 w-4 text-emerald-600" />
        {t(
          ($) => {
            return $.chat.banking.active;
          },
          { count: controller.activeGrantAccountCount },
        )}
      </div>
      {grant.expiresAt ? (
        <div className="mt-1 text-xs text-muted-foreground">
          {t(
            ($) => {
              return $.chat.banking.expiresAt;
            },
            {
              time: new Date(grant.expiresAt).toLocaleString(
                i18n.resolvedLanguage,
              ),
            },
          )}
        </div>
      ) : null}
      <div className="mt-1 text-xs text-muted-foreground">
        {t(($) => {
          return $.chat.banking.automationOff;
        })}
      </div>
      {controller.ui.confirmingRevoke ? (
        <BankingRevokeConfirmation controller={controller} />
      ) : (
        <ActiveBankingGrantActions controller={controller} />
      )}
    </div>
  );
}

function BankingRevokeConfirmation({
  controller,
}: {
  readonly controller: BankingCardController;
}) {
  const { t } = useTranslation();
  const busy = controller.ui.busy !== null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
      <span className="mr-auto text-xs text-muted-foreground">
        {t(($) => {
          return $.chat.banking.revokeConfirm;
        })}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => {
          controller.updateUi({ confirmingRevoke: false });
        }}
      >
        {t(($) => {
          return $.chat.banking.cancel;
        })}
      </Button>
      <Button
        size="sm"
        variant="destructive"
        disabled={busy}
        onClick={controller.revoke}
      >
        {t(($) => {
          return $.chat.banking.revoke;
        })}
      </Button>
    </div>
  );
}

function ActiveBankingGrantActions({
  controller,
}: {
  readonly controller: BankingCardController;
}) {
  const { t } = useTranslation();
  const busy = controller.ui.busy !== null;
  return (
    <div className="mt-3 flex flex-wrap justify-end gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          controller.updateUi({ confirmingRevoke: true });
        }}
      >
        {t(($) => {
          return $.chat.banking.revoke;
        })}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => {
          controller.updateUi({ editing: true });
        }}
      >
        {t(($) => {
          return $.chat.banking.change;
        })}
      </Button>
      <Button size="sm" disabled={busy} onClick={controller.runContinue}>
        {controller.ui.busy === "continue" ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : null}
        {t(($) => {
          return $.chat.banking.continue;
        })}
      </Button>
    </div>
  );
}

function BankingGrantEditor({
  controller,
  connection,
}: {
  readonly controller: BankingCardController;
  readonly connection: BankingConnection;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-4">
      <div className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.chat.banking.selectAccounts;
        })}
      </div>
      <div className="mt-2 space-y-2">
        {controller.healthyAccounts.map((account) => {
          return (
            <BankingAccountOption
              key={account.id}
              account={account}
              checked={controller.selectedAccountIds.has(account.id)}
              busy={controller.ui.busy !== null}
              onCheckedChange={(checked) => {
                controller.updateAccountSelection(account.id, checked);
              }}
            />
          );
        })}
        {controller.healthyAccounts.length === 0 ? (
          <NoHealthyBankingAccounts
            canReconnect={connection.repairInstitutions.length === 0}
            busy={controller.ui.busy !== null}
            openConnect={controller.openConnect}
          />
        ) : null}
      </div>
      <BankingGrantControls controller={controller} />
      <div className="mt-2 text-right text-xs text-muted-foreground">
        {t(($) => {
          return $.chat.banking.automationOff;
        })}
      </div>
    </div>
  );
}

function BankingAccountOption({
  account,
  checked,
  busy,
  onCheckedChange,
}: {
  readonly account: BankingAccount;
  readonly checked: boolean;
  readonly busy: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  const name =
    account.name ??
    account.institutionName ??
    t(($) => {
      return $.chat.banking.accountFallback;
    });
  const detail = [account.institutionName, account.type, account.last4]
    .filter(Boolean)
    .join(" · ");
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border/70 px-3 py-2">
      <Checkbox
        checked={checked}
        disabled={busy}
        onCheckedChange={(next) => {
          onCheckedChange(next === true);
        }}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {detail}
        </span>
      </span>
    </label>
  );
}

function NoHealthyBankingAccounts({
  canReconnect,
  busy,
  openConnect,
}: {
  readonly canReconnect: boolean;
  readonly busy: boolean;
  readonly openConnect: OpenBankingConnect;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
      <span>
        {t(($) => {
          return $.chat.banking.noAccounts;
        })}
      </span>
      {canReconnect ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            openConnect("connect");
          }}
        >
          {t(($) => {
            return $.chat.banking.retry;
          })}
        </Button>
      ) : null}
    </div>
  );
}

function BankingGrantControls({
  controller,
}: {
  readonly controller: BankingCardController;
}) {
  const { t } = useTranslation();
  const busy = controller.ui.busy !== null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
      {controller.activeGrant &&
      controller.activeGrantAccountCount > 0 &&
      controller.grantMatchesRequest ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            controller.updateUi({ editing: false, selectedAccountIds: null });
          }}
        >
          {t(($) => {
            return $.chat.banking.cancel;
          })}
        </Button>
      ) : null}
      <BankingDurationSelect controller={controller} disabled={busy} />
      <Button
        size="sm"
        disabled={controller.selectedAccountIds.size === 0 || busy}
        onClick={controller.save}
      >
        {controller.ui.busy === "save" ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : null}
        {t(($) => {
          return $.chat.banking.grant;
        })}
      </Button>
    </div>
  );
}

function BankingDurationSelect({
  controller,
  disabled,
}: {
  readonly controller: BankingCardController;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Select
      value={controller.ui.duration}
      disabled={disabled}
      onValueChange={(value) => {
        if (isBankingGrantDuration(value)) {
          controller.updateUi({ duration: value });
        }
      }}
    >
      <SelectTrigger
        aria-label={t(($) => {
          return $.chat.banking.duration;
        })}
        className="h-9 w-[112px]"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="1h">
          {t(($) => {
            return $.chat.banking.oneHour;
          })}
        </SelectItem>
        <SelectItem value="24h">
          {t(($) => {
            return $.chat.banking.oneDay;
          })}
        </SelectItem>
        <SelectItem value="7d">
          {t(($) => {
            return $.chat.banking.sevenDays;
          })}
        </SelectItem>
        <SelectItem value="30d">
          {t(($) => {
            return $.chat.banking.thirtyDays;
          })}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
