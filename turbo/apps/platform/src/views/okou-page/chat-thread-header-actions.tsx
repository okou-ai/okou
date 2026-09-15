import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Clock, Ellipsis, Package, Pencil, Pin, PinOff } from "lucide-react";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ShortcutTooltipGroup,
} from "@okouai/ui";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { openRenameChatThreadDialogForThreadId$ } from "../../signals/chat-page/chat-thread-rename.ts";
import { openThreadAutomations$ } from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { DropdownMenuModalItem } from "../components/dropdown-menu-modal-item.tsx";
import { useOpenThreadArtifacts } from "./thread-sidebar.tsx";

export function ChatThreadPinButton({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const pinned = useGet(thread.pin.pinned$);
  const setPinned = useSet(thread.pin.setPinned$);

  return (
    <ShortcutTooltipGroup
      items={[
        {
          shortcut: GLOBAL_KEYBOARD_SHORTCUTS.toggleChatPin.binding,
          trigger: (
            <Button
              type="button"
              variant="quiet"
              size="icon-sm"
              iconSize="md"
              className={cn(
                "shrink-0 duration-150",
                pinned ? "text-gray-700" : "text-gray-600",
              )}
              aria-label={
                pinned
                  ? t(($) => {
                      return $.chat.sidebar.unpin;
                    })
                  : t(($) => {
                      return $.chat.sidebar.pin;
                    })
              }
              aria-keyshortcuts={
                GLOBAL_KEYBOARD_SHORTCUTS.toggleChatPin.ariaKeyShortcuts
              }
              aria-pressed={pinned}
              onClick={() => {
                detach(setPinned(!pinned, pageSignal), Reason.DomCallback);
              }}
            >
              <span className="relative inline-flex" aria-hidden="true">
                <Pin size={18} strokeWidth={1.75} />
                {pinned && (
                  <span className="absolute -bottom-1 left-1/2 size-0.75 -translate-x-1/2 rounded-full bg-current" />
                )}
              </span>
            </Button>
          ),
        },
      ]}
    />
  );
}

export function MobileChatThreadMoreMenu({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const pinned = useGet(thread.pin.pinned$);
  const setPinned = useSet(thread.pin.setPinned$);
  const openRename = useSet(openRenameChatThreadDialogForThreadId$);
  const automations = useLastResolved(thread.headerAutomations.automations$);
  const reloadAutomations = useSet(thread.headerAutomations.reloadAutomations$);
  const openAutomations = useSet(openThreadAutomations$);
  const reloadArtifacts = useSet(thread.reloadArtifacts$);
  const openArtifacts = useOpenThreadArtifacts(thread);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          showTooltip
          type="button"
          variant="quiet"
          size="icon-sm"
          iconSize="md"
          className="size-11 shrink-0"
          aria-label={t(($) => {
            return $.chat.actions.more;
          })}
        >
          <Ellipsis size={18} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem
          className="min-h-11"
          onSelect={() => {
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
        <DropdownMenuModalItem
          className="min-h-11"
          onModalSelect={() => {
            detach(openRename(thread.threadId, pageSignal), Reason.DomCallback);
          }}
        >
          <Pencil size={16} />
          {t(($) => {
            return $.chat.sidebar.rename;
          })}
        </DropdownMenuModalItem>
        <DropdownMenuSeparator />
        {automations && automations.length > 0 && (
          <DropdownMenuItem
            className="min-h-11"
            onSelect={() => {
              reloadAutomations();
              openAutomations(thread);
            }}
          >
            <Clock size={16} />
            {t(($) => {
              return $.chat.automations.title;
            })}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          className="min-h-11"
          onSelect={() => {
            reloadArtifacts();
            openArtifacts();
          }}
        >
          <Package size={16} />
          {t(($) => {
            return $.appShell.sidebar.navigation.artifacts;
          })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
