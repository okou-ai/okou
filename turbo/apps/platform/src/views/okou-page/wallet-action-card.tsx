import { useLoadableSet } from "ccstate-react/experimental";
import { Button, buttonVariants, cn } from "@okouai/ui";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { ArrowUpRight, Check, Loader2, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type {
  WalletActionDescriptor,
  WalletActionSignals,
  WalletConnectSignals,
  WalletApprovalSignals,
} from "../../signals/chat-page/wallet-action-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatCard } from "./components/chat-card.tsx";

function WalletCard({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <ChatCard
      data-markdown-ui
      className="flex h-[136px] w-full flex-col justify-between gap-3 px-4 py-3 text-left @[640px]:h-[88px] @[640px]:flex-row @[640px]:items-center"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-gray-50 text-muted-foreground">
          <Wallet size={22} aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[0.9375rem] font-medium leading-5 text-foreground">
            {title}
          </div>
          <div className="mt-0.5 truncate text-sm leading-5 text-muted-foreground">
            {description}
          </div>
        </div>
      </div>
      {children}
    </ChatCard>
  );
}

function WalletActionLink({
  descriptor,
  title,
  label,
  waiting = false,
  onClick,
}: {
  readonly descriptor: WalletActionDescriptor;
  readonly title: string;
  readonly label: string;
  readonly waiting?: boolean;
  readonly onClick?: () => void;
}) {
  return (
    <a
      href={descriptor.originalUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={title}
      onClick={onClick}
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        "h-9 w-full shrink-0 gap-1.5 @[640px]:w-auto",
      )}
    >
      {waiting ? (
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
      ) : null}
      {label}
      <ArrowUpRight size={14} aria-hidden="true" />
    </a>
  );
}

function WalletConnectCard({
  descriptor,
  connect,
}: {
  readonly descriptor: WalletActionDescriptor;
  readonly connect: WalletConnectSignals;
}) {
  const { t } = useTranslation();
  const current = useLoadable(connect.status$);
  const last = useLastLoadable(connect.status$);
  const status =
    current.state === "hasData"
      ? current.data
      : last.state === "hasData"
        ? last.data
        : null;
  const continued = useGet(connect.continued$);
  const pageSignal = useGet(pageSignal$);
  const [continuation, start] = useLoadableSet(connect.start$);
  const busy = continuation.state === "loading";
  const title = t(($) => {
    return $.chat.walletAction.connectTitle;
  });
  const statusLabels = {
    authorized: t(($) => {
      return $.chat.walletAction.authorized;
    }),
    pending: t(($) => {
      return $.chat.walletAction.waiting;
    }),
    expired: t(($) => {
      return $.chat.walletAction.expired;
    }),
    failed: t(($) => {
      return $.chat.walletAction.failed;
    }),
    unavailable: t(($) => {
      return $.chat.walletAction.unavailable;
    }),
  };
  const description =
    continuation.state === "hasError" && status?.status === "authorized"
      ? t(($) => {
          return $.chat.walletAction.callbackFailed;
        })
      : current.state === "hasError" || continuation.state === "hasError"
        ? t(($) => {
            return $.chat.walletAction.checkFailed;
          })
        : status && (status.status !== "pending" || busy)
          ? statusLabels[status.status]
          : descriptor.hostname;
  const activate = () => {
    if (busy || continued) {
      return;
    }
    detach(
      start(pageSignal),
      Reason.DomCallback,
      "continue after Link wallet authorization",
    );
  };
  return (
    <WalletCard title={title} description={description}>
      {status?.status === "authorized" ? (
        <Button
          variant="outline"
          size="sm"
          className="h-9 w-full shrink-0 gap-1.5 @[640px]:w-auto"
          disabled={busy || continued}
          onClick={activate}
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Check size={14} />
          )}
          {continued
            ? statusLabels.authorized
            : t(($) => {
                return $.chat.walletAction.continueButton;
              })}
        </Button>
      ) : status && status.status !== "pending" ? (
        <Button
          variant="outline"
          size="sm"
          className="h-9 w-full shrink-0 @[640px]:w-auto"
          disabled
        >
          {statusLabels[status.status]}
        </Button>
      ) : (
        <WalletActionLink
          descriptor={descriptor}
          title={title}
          label={t(($) => {
            return $.chat.walletAction.connectButton;
          })}
          waiting={busy}
          onClick={activate}
        />
      )}
    </WalletCard>
  );
}

function WalletApprovalCard({
  descriptor,
  approval,
}: {
  readonly descriptor: WalletActionDescriptor;
  readonly approval: WalletApprovalSignals;
}) {
  const { t } = useTranslation();
  const current = useLastLoadable(approval.status$);
  const status =
    current.state === "hasData" ? current.data.status : "unavailable";
  const mounted = useSet(approval.mounted$);
  const title = t(($) => {
    return $.chat.walletAction.approveTitle;
  });
  const descriptions = {
    pending: t(($) => {
      return $.chat.walletAction.approvalWaiting;
    }),
    approved: t(($) => {
      return $.chat.walletAction.approvalApproved;
    }),
    continued: t(($) => {
      return $.chat.walletAction.approvalContinued;
    }),
    stopped: t(($) => {
      return $.chat.walletAction.approvalStopped;
    }),
    unavailable: descriptor.hostname,
  };
  return (
    <div ref={mounted}>
      <WalletCard title={title} description={descriptions[status]}>
        {status === "pending" ||
        status === "unavailable" ||
        status === "stopped" ? (
          <WalletActionLink
            descriptor={descriptor}
            title={title}
            label={t(($) => {
              return $.chat.walletAction.approveButton;
            })}
          />
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-9 w-full shrink-0 gap-1.5 @[640px]:w-auto"
            disabled
          >
            {status === "approved" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Check size={14} />
            )}
            {t(($) => {
              return $.chat.walletAction.approvalRecorded;
            })}
          </Button>
        )}
      </WalletCard>
    </div>
  );
}

export function WalletActionCard({
  signals,
}: {
  readonly signals: WalletActionSignals;
}) {
  const { t } = useTranslation();
  const labels = {
    connect: {
      title: t(($) => {
        return $.chat.walletAction.connectTitle;
      }),
      button: t(($) => {
        return $.chat.walletAction.connectButton;
      }),
    },
    approve: {
      title: t(($) => {
        return $.chat.walletAction.approveTitle;
      }),
      button: t(($) => {
        return $.chat.walletAction.approveButton;
      }),
    },
    continue: {
      title: t(($) => {
        return $.chat.walletAction.continueTitle;
      }),
      button: t(($) => {
        return $.chat.walletAction.continueButton;
      }),
    },
  }[signals.action];

  if (signals.connect) {
    return <WalletConnectCard descriptor={signals} connect={signals.connect} />;
  }
  if (signals.approval) {
    return (
      <WalletApprovalCard descriptor={signals} approval={signals.approval} />
    );
  }

  return (
    <WalletCard title={labels.title} description={signals.hostname}>
      <WalletActionLink
        descriptor={signals}
        title={labels.title}
        label={labels.button}
      />
    </WalletCard>
  );
}
