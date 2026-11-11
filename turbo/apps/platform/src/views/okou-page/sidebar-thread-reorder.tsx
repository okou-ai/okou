import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowUp, ArrowDown } from "lucide-react";
import { DropdownMenuItem } from "@okouai/ui";
import {
  pinnedThreadReorderEnabled$,
  stepPinnedThread$,
} from "../../signals/chat-page/chat-thread-pin-order.ts";
import type { SidebarChatThreadItemSignals } from "../../signals/chat-page/sidebar-chat-thread-item.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { ChatThreadMenuShortcut } from "./chat-thread-menu-shortcut.tsx";

export function ThreadPinMoveMenuItems({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const { t } = useTranslation();
  const enabled = useGet(pinnedThreadReorderEnabled$);
  const pinned = useGet(signals.pinned$);
  const move = useSet(stepPinnedThread$);
  const signal = useGet(pageSignal$);
  if (!enabled || !pinned) {
    return null;
  }
  const upLabel = t(($) => {
    return $.chat.sidebar.movePinUp;
  });
  const downLabel = t(($) => {
    return $.chat.sidebar.movePinDown;
  });
  return (
    <>
      <DropdownMenuItem
        aria-label={upLabel}
        aria-keyshortcuts={
          GLOBAL_KEYBOARD_SHORTCUTS.moveChatPinUp.ariaKeyShortcuts
        }
        onClick={() => {
          return detach(move(signals.threadId, -1, signal), Reason.DomCallback);
        }}
      >
        <ArrowUp size={16} className="mr-2" />
        {upLabel}
        <ChatThreadMenuShortcut
          shortcut={GLOBAL_KEYBOARD_SHORTCUTS.moveChatPinUp.binding}
        />
      </DropdownMenuItem>
      <DropdownMenuItem
        aria-label={downLabel}
        aria-keyshortcuts={
          GLOBAL_KEYBOARD_SHORTCUTS.moveChatPinDown.ariaKeyShortcuts
        }
        onClick={() => {
          return detach(move(signals.threadId, 1, signal), Reason.DomCallback);
        }}
      >
        <ArrowDown size={16} className="mr-2" />
        {downLabel}
        <ChatThreadMenuShortcut
          shortcut={GLOBAL_KEYBOARD_SHORTCUTS.moveChatPinDown.binding}
        />
      </DropdownMenuItem>
    </>
  );
}
