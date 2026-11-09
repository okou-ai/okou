import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Badge, cn, getShortcutLabel } from "@okouai/ui";
import { defaultAgentChatPageActive$ } from "../../signals/agent.ts";
import { assistantName$ } from "../../signals/branding.ts";
import {
  waitingSuggestionCount$,
  followWaitingSuggestionCountOnRef$,
  suggestionsEnabled$,
} from "../../signals/okou-page/agent-suggestion-session.ts";
import { singleAgentEnabled$ } from "../../signals/single-agent.ts";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { OkouLogomark } from "../components/okou-logomark.tsx";
import { Link } from "../router/link.tsx";

const ENTRY_ROW =
  "flex h-8 w-full min-w-0 items-center rounded-lg pr-2 text-left text-sm text-nav-copy motion-safe:transition-colors motion-safe:duration-[180ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function WaitingSuggestionCount() {
  const { t } = useTranslation();
  const count = useLastResolved(waitingSuggestionCount$) ?? 0;
  if (count === 0) {
    return null;
  }
  return (
    <Badge className="shrink-0 text-xs font-medium tabular-nums text-nav-copy-muted">
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">
        {t(
          ($) => {
            return $.appShell.sidebar.suggestionsWaiting;
          },
          { count },
        )}
      </span>
    </Badge>
  );
}

/**
 * Okou's own entry, first in the chat list: it opens home and counts the
 * suggestion cards waiting there. The glyph takes the Project folders' slot so
 * the names line up. In My Okou home is the new chat, so the row is named New
 * chat.
 */
export function OkouChatListRow() {
  const enabled = useGet(suggestionsEnabled$);
  const singleAgent = useGet(singleAgentEnabled$);
  const active = useLastResolved(defaultAgentChatPageActive$) === true;
  const assistantName = useGet(assistantName$);
  const followCount = useSet(followWaitingSuggestionCountOnRef$);
  const { t } = useTranslation();
  if (!enabled && !singleAgent) {
    return null;
  }
  const newChat = GLOBAL_KEYBOARD_SHORTCUTS.newChat;
  return (
    <Link
      ref={enabled ? followCount : undefined}
      pathname="/"
      aria-current={active ? "page" : undefined}
      aria-keyshortcuts={singleAgent ? newChat.ariaKeyShortcuts : undefined}
      className={cn(
        "group/okou-row",
        ENTRY_ROW,
        active ? "bg-state-selected font-medium" : "hover:bg-state-hover",
      )}
    >
      <span className="flex w-8 shrink-0 items-center justify-center px-2">
        <OkouLogomark className="size-4 shrink-0 opacity-70" />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {singleAgent
          ? t(($) => {
              return $.chat.newChat;
            })
          : assistantName}
      </span>
      {enabled ? <WaitingSuggestionCount /> : null}
      {singleAgent ? (
        <kbd
          aria-hidden="true"
          className="shrink-0 whitespace-nowrap pl-2 font-sans text-xs text-nav-copy-muted md:[@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/okou-row:opacity-100 group-focus-visible/okou-row:opacity-100"
        >
          {getShortcutLabel(newChat.binding)}
        </kbd>
      ) : null}
    </Link>
  );
}
