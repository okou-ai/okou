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
  return (
    <>
      <DropdownMenuItem
        onClick={() => {
          return detach(move(signals.threadId, -1, signal), Reason.DomCallback);
        }}
      >
        <ArrowUp size={16} className="mr-2" />
        {t(($) => {
          return $.chat.sidebar.movePinUp;
        })}
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => {
          return detach(move(signals.threadId, 1, signal), Reason.DomCallback);
        }}
      >
        <ArrowDown size={16} className="mr-2" />
        {t(($) => {
          return $.chat.sidebar.movePinDown;
        })}
      </DropdownMenuItem>
    </>
  );
}
