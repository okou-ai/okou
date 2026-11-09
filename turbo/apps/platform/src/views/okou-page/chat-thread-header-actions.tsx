import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  Clock,
  Ellipsis,
  Globe,
  Mail,
  Check,
  Pencil,
  Pin,
  PinOff,
} from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@okouai/ui";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { openRenameChatThreadDialogForThreadId$ } from "../../signals/chat-page/chat-thread-rename.ts";
import {
  openThreadAutomations$,
  openThreadBrowserSession$,
  openThreadMailList$,
} from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import { useChatHeaderTransitioning } from "./chat-header-actions.ts";
import { ChatHeaderIconButton } from "./chat-header-icon-button.tsx";
import { setChatThreadArchivedWithFeedback$ } from "../../signals/chat-page/chat-thread-archive.ts";
import { setChatThreadMutedWithFeedback$ } from "../../signals/chat-page/chat-thread-mute.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ThreadMailButton } from "./thread-mail.tsx";
import { rootSignal$ } from "../../signals/root-signal.ts";

// Keep muted status visible without opening the menu.
export function ChatThreadMutedButton({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const muted = useGet(thread.threadMeta$)?.muted === true;
  const setMuted = useSet(setChatThreadMutedWithFeedback$);
  if (!muted) {
    return null;
  }

  return (
    <Button
      showTooltip
      type="button"
      variant="quiet"
      size="icon-sm"
      iconSize="md"
      className="shrink-0 text-gray-600 duration-150"
      aria-label={t(($) => {
        return $.chat.sidebar.unmute;
      })}
      onClick={() => {
        detach(
          setMuted({ threadId: thread.threadId, muted: false }, pageSignal),
          Reason.DomCallback,
        );
      }}
    >
      <BellOff size={18} strokeWidth={1.75} />
    </Button>
  );
}

function MobileMuteMenuItem({ thread }: { readonly thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const muted = useGet(thread.threadMeta$)?.muted === true;
  const setMuted = useSet(setChatThreadMutedWithFeedback$);
  return (
    <DropdownMenuItem
      className="min-h-11"
      onClick={() => {
        detach(
          setMuted({ threadId: thread.threadId, muted: !muted }, pageSignal),
          Reason.DomCallback,
        );
      }}
    >
      {muted ? <Bell size={16} /> : <BellOff size={16} />}
      {muted
        ? t(($) => {
            return $.chat.sidebar.unmute;
          })
        : t(($) => {
            return $.chat.sidebar.mute;
          })}
    </DropdownMenuItem>
  );
}

function MobileBrowserMenuItem({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const openBrowser = useSet(openThreadBrowserSession$);
  const transitioning = useChatHeaderTransitioning(thread);
  return (
    <DropdownMenuItem
      className="min-h-11"
      disabled={transitioning}
      onClick={() => {
        openBrowser(thread.threadId);
      }}
    >
      <Globe size={16} />
      {t(($) => {
        return $.chat.thread.openBrowser;
      })}
    </DropdownMenuItem>
  );
}

export function MobileChatThreadMoreMenu({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const rootSignal = useGet(rootSignal$);
  const pinned = useGet(thread.pin.pinned$);
  const setPinned = useSet(thread.pin.setPinned$);
  const openRename = useSet(openRenameChatThreadDialogForThreadId$);
  const archived = useGet(thread.threadMeta$)?.archived === true;
  const [archiveLoadable, archive] = useLoadableSet(
    setChatThreadArchivedWithFeedback$,
  );
  const archiving = archiveLoadable.state === "loading";
  const reloadAutomations = useSet(thread.headerAutomations.reloadAutomations$);
  const openAutomations = useSet(openThreadAutomations$);
  const transitioning = useChatHeaderTransitioning(thread);

  return (
    <DropdownMenu>
      <ChatHeaderIconButton
        thread={thread}
        icon={<Ellipsis size={18} />}
        label={t(($) => {
          return $.chat.actions.more;
        })}
        largeTarget
        usage={{ kind: "popup", popup: "menu" }}
      />
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem
          className="min-h-11"
          onClick={() => {
            detach(setPinned(!pinned, pageSignal), Reason.DomCallback);
          }}
        >
          {pinned ? <PinOff size={16} /> : <Pin size={16} />}
          {pinned
            ? t(($) => {
                return $.chat.sidebar.unpin;
              })
            : t(($) => {
                return $.chat.sidebar.pin;
              })}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="min-h-11"
          onClick={() => {
            detach(openRename(thread.threadId, pageSignal), Reason.DomCallback);
          }}
        >
          <Pencil size={16} />
          {t(($) => {
            return $.chat.sidebar.rename;
          })}
        </DropdownMenuItem>
        <MobileMuteMenuItem thread={thread} />
        <DropdownMenuItem
          className="min-h-11"
          disabled={archiving}
          onClick={() => {
            detach(
              archive(
                {
                  threadId: thread.threadId,
                  archived: !archived,
                  leaveToAgentId: thread.agentId,
                },
                // Archiving navigates away immediately, which aborts the page signal.
                rootSignal,
              ),
              Reason.DomCallback,
            );
          }}
        >
          {archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
          {archived
            ? t(($) => {
                return $.chat.sidebar.unarchive;
              })
            : t(($) => {
                return $.chat.sidebar.archive;
              })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="min-h-11"
          disabled={transitioning}
          onClick={() => {
            reloadAutomations();
            openAutomations(thread);
          }}
        >
          <Clock size={16} />
          {t(($) => {
            return $.chat.automations.title;
          })}
        </DropdownMenuItem>
        <MobileBrowserMenuItem thread={thread} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DesktopChatThreadMoreMenu({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const anchor = useGet(thread.mail.menuAnchor$);
  const anchorRef = useSet(thread.mail.menuAnchorRef$);
  const transitioning = useChatHeaderTransitioning(thread);
  const openAutomations = useSet(openThreadAutomations$);
  const reloadAutomations = useSet(thread.headerAutomations.reloadAutomations$);
  const openBrowser = useSet(openThreadBrowserSession$);
  const openMail = useSet(openThreadMailList$);
  const mailOpen = useGet(thread.mail.open$);
  const target = useGet(thread.sidebar.target$);
  return (
    <>
      <DropdownMenu>
        <ChatHeaderIconButton
          ref={anchorRef}
          thread={thread}
          icon={<Ellipsis size={18} />}
          label={t(($) => {
            return $.chat.actions.more;
          })}
          usage={{ kind: "popup", popup: "menu" }}
        />
        <DropdownMenuContent
          align="end"
          className="min-w-48"
          // The email popover takes focus when selected; dismissal returns here.
          finalFocus={mailOpen ? false : undefined}
        >
          <DropdownMenuItem
            disabled={transitioning}
            onClick={() => {
              reloadAutomations();
              openAutomations(thread);
            }}
          >
            <Clock size={16} />
            {t(($) => {
              return $.chat.automations.title;
            })}
            {target?.type === "automations" && (
              <Check className="ml-auto" size={16} />
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={transitioning}
            onClick={() => {
              return openMail(thread);
            }}
          >
            <Mail size={16} />
            {t(($) => {
              return $.chat.mail.manager.open;
            })}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={transitioning}
            onClick={() => {
              return openBrowser(thread.threadId);
            }}
          >
            <Globe size={16} />
            {t(($) => {
              return $.chat.thread.openBrowser;
            })}
            {target?.type === "browser" && (
              <Check className="ml-auto" size={16} />
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ThreadMailButton thread={thread} menuAnchor={anchor} />
    </>
  );
}
