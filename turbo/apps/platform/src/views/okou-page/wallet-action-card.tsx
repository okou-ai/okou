import { buttonVariants, cn } from "@okouai/ui";
import { ArrowUpRight, Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { WalletActionDescriptor } from "../../signals/chat-page/wallet-action-block.ts";
import { ChatCard } from "./components/chat-card.tsx";

export function WalletActionCard({
  descriptor,
}: {
  descriptor: WalletActionDescriptor;
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
  }[descriptor.action];

  return (
    <ChatCard
      data-markdown-ui
      className="flex w-full max-w-xl items-center gap-2.5 p-3"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-muted-foreground">
        <Wallet size={18} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-sm font-medium text-foreground"
          title={labels.title}
        >
          {labels.title}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {descriptor.hostname}
        </div>
      </div>
      <a
        href={descriptor.originalUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={labels.title}
        className={cn(
          buttonVariants({ size: "sm" }),
          "shrink-0 gap-1 bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed",
        )}
      >
        {labels.button}
        <ArrowUpRight size={14} aria-hidden="true" />
      </a>
    </ChatCard>
  );
}
