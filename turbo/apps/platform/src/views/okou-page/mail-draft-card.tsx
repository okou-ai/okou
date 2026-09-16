import { AlertCircle, ChevronRight, Loader2 } from "lucide-react";
import type {
  MailDraft,
  MailDraftStatus,
} from "@okouai/api-contracts/contracts/mail";
import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import { Button, cn } from "@okouai/ui";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";

import { i18n } from "../../i18n/index.ts";
import type { MailDraftSignals } from "../../signals/chat-page/mail-draft.ts";
import {
  activeSidebarMailDraftId$,
  openThreadMailDraft$,
} from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { useGmailReconnect } from "./use-gmail-reconnect.ts";

interface MailDraftCardProps {
  readonly signals: MailDraftSignals;
}

const MAIL_DRAFT_CARD_HEIGHT_CLASS = "h-[76px]";

function MailDraftCardShell({ children }: { readonly children: ReactNode }) {
  return (
    <div
      data-testid="mail-draft-card-shell"
      className={cn("w-full max-w-xl", MAIL_DRAFT_CARD_HEIGHT_CLASS)}
    >
      {children}
    </div>
  );
}

function statusLabel(status: MailDraftStatus): string {
  switch (status) {
    case "draft": {
      return i18n.t(($) => {
        return $.chat.mail.status.draft;
      });
    }
    case "sent": {
      return i18n.t(($) => {
        return $.chat.mail.status.sent;
      });
    }
    case "deleted": {
      return i18n.t(($) => {
        return $.chat.mail.status.deleted;
      });
    }
  }
}

function MailDraftCardSkeleton() {
  return (
    <div
      data-testid="mail-draft-card-loading"
      className="flex h-full w-full items-center gap-3 rounded-[var(--okou-card-radius)] border border-border/70 bg-card px-4 py-3"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/60">
        <Loader2 className="animate-spin text-muted-foreground" size={16} />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-4 w-2/3 rounded bg-muted/70" />
        <div className="h-3 w-1/3 rounded bg-muted/60" />
      </div>
    </div>
  );
}

function mailDraftRecipients(draft: MailDraft): string {
  const firstRecipient = draft.to[0];
  if (!firstRecipient) {
    return i18n.t(($) => {
      return $.chat.mail.noRecipient;
    });
  }
  return draft.to.length === 1
    ? firstRecipient
    : `${firstRecipient} +${draft.to.length - 1}`;
}

function MailDraftCardContent({
  draft,
  gmailIcon,
  reconnecting,
}: {
  readonly draft: MailDraft;
  readonly gmailIcon: PublicConnectorCatalogIcon | undefined;
  readonly reconnecting: boolean;
}) {
  const { t } = useTranslation();
  const deleted = draft.status === "deleted";
  const reconnect = draft.accessStatus === "reconnect";
  return (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background">
        <ConnectorIcon icon={gmailIcon} size={23} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-5 text-foreground">
          {draft.subject ||
            t(($) => {
              return $.chat.mail.noSubject;
            })}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {t(
            ($) => {
              return $.chat.mail.toRecipients;
            },
            {
              recipients: mailDraftRecipients(draft),
            },
          )}
        </span>
      </span>
      <span className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1.5 self-center">
        <span
          className={cn(
            "truncate rounded-full px-2 py-1 text-[11px] font-medium",
            draft.status === "sent" &&
              "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            draft.status === "draft" &&
              !reconnect &&
              "bg-amber-500/10 text-amber-700 dark:text-amber-300",
            reconnect && "bg-destructive/10 text-destructive dark:text-red-300",
            deleted && "bg-muted text-muted-foreground",
          )}
        >
          {reconnecting
            ? t(($) => {
                return $.chat.mail.reconnecting;
              })
            : reconnect
              ? t(($) => {
                  return $.chat.mail.needReconnect;
                })
              : statusLabel(draft.status)}
        </span>
        {!deleted ? <ChevronRight size={16} className="" /> : null}
      </span>
    </>
  );
}

function DeletedMailDraftCard({
  draft,
  gmailIcon,
  subject,
}: {
  readonly draft: MailDraft;
  readonly gmailIcon: PublicConnectorCatalogIcon | undefined;
  readonly subject: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      aria-disabled="true"
      aria-label={t(
        ($) => {
          return $.chat.mail.deletedEmail;
        },
        {
          subject,
        },
      )}
      data-mail-draft-card
      data-mail-draft-status="deleted"
      className="flex h-full w-full cursor-default items-center gap-3 rounded-[var(--okou-card-radius)] border border-border/60 bg-card px-4 py-3 opacity-70"
    >
      <MailDraftCardContent
        draft={draft}
        gmailIcon={gmailIcon}
        reconnecting={false}
      />
    </div>
  );
}

function MailDraftCardState({ signals }: MailDraftCardProps) {
  const { t } = useTranslation();
  const draftLoadable = useLastLoadable(signals.draft$);
  const selectedMailDraftId = useGet(activeSidebarMailDraftId$);
  const openSidebar = useSet(openThreadMailDraft$);
  const reloadDraft = useSet(signals.reloadDraft$);
  const reconnectConnectionId =
    draftLoadable.state === "hasData"
      ? draftLoadable.data?.reconnectConnectionId
      : undefined;
  const { connectorIcon, reconnect, reconnectDisabled, reconnecting } =
    useGmailReconnect(reconnectConnectionId, reloadDraft);

  if (draftLoadable.state === "loading") {
    return <MailDraftCardSkeleton />;
  }
  if (draftLoadable.state === "hasError" || draftLoadable.data === null) {
    return (
      <div
        data-mail-draft-status="unavailable"
        className="flex h-full items-center gap-3 rounded-[var(--okou-card-radius)] border border-border/70 bg-card px-4 py-3"
      >
        <AlertCircle size={20} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 line-clamp-2 text-sm text-muted-foreground">
          {t(($) => {
            return $.chat.mail.unavailable;
          })}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={reloadDraft}>
          {t(($) => {
            return $.billing.common.retry;
          })}
        </Button>
      </div>
    );
  }

  const draft = draftLoadable.data;
  const deleted = draft.status === "deleted";
  const needsReconnect = draft.accessStatus === "reconnect";
  const selected = selectedMailDraftId === signals.mailDraftId;
  const subject =
    draft.subject ||
    t(($) => {
      return $.chat.mail.noSubjectPlain;
    });
  const openDraft = () => {
    openSidebar(signals);
  };
  const content = (
    <MailDraftCardContent
      draft={draft}
      gmailIcon={connectorIcon}
      reconnecting={needsReconnect && reconnecting}
    />
  );

  if (deleted) {
    return (
      <DeletedMailDraftCard
        draft={draft}
        gmailIcon={connectorIcon}
        subject={subject}
      />
    );
  }

  if (needsReconnect) {
    return (
      <button
        type="button"
        disabled={reconnectDisabled}
        onClick={reconnect}
        aria-label={t(
          ($) => {
            return $.chat.mail.reconnectToAccess;
          },
          {
            subject,
          },
        )}
        data-mail-draft-card
        data-mail-draft-status={draft.status}
        className="flex h-full w-full items-center gap-3 rounded-[var(--okou-card-radius)] border border-border/70 bg-card px-4 py-3 text-left transition-colors hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-70"
      >
        {content}
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-label={t(
        ($) => {
          return $.chat.mail.openEmail;
        },
        {
          status: statusLabel(draft.status).toLocaleLowerCase(
            i18n.resolvedLanguage,
          ),
          subject,
        },
      )}
      data-mail-draft-card
      data-mail-draft-status={draft.status}
      onClick={openDraft}
      className={cn(
        "flex h-full w-full items-center gap-3 rounded-[var(--okou-card-radius)] border bg-card px-4 py-3 text-left transition-colors hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        selected ? "border-ring/60 bg-muted/20" : "border-border/70",
      )}
    >
      {content}
    </button>
  );
}

export function MailDraftCard({ signals }: MailDraftCardProps) {
  return (
    <MailDraftCardShell>
      <MailDraftCardState signals={signals} />
    </MailDraftCardShell>
  );
}
