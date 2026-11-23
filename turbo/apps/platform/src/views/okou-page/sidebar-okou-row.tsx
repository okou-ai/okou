import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Edit, HandHeart } from "lucide-react";
import { cn, getShortcutLabel } from "@okouai/ui";
import {
  activeRoute$,
  agentChatPageActive$,
} from "../../signals/active-route.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  followForYouFeedOnRef$,
  suggestionsEnabled$,
} from "../../signals/okou-page/agent-suggestion-session.ts";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { Link } from "../router/link.tsx";
import { forYouHasUnread$ } from "../../signals/okou-page/for-you-sources.ts";
import {
  ChatThreadStateIndicator,
  ChatThreadStateText,
} from "./sidebar-shared.tsx";

const ENTRY_ROW =
  "flex h-8 w-full min-w-0 items-center rounded-lg pr-2 text-left text-sm text-nav-copy motion-safe:transition-colors motion-safe:duration-[180ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

const SHORTCUT_HINT =
  "shrink-0 whitespace-nowrap pl-2 font-sans text-xs text-nav-copy-muted";

function ShortcutHint({
  label,
  className,
}: {
  label: string;
  className: string;
}) {
  return (
    <kbd aria-hidden="true" className={cn(SHORTCUT_HINT, className)}>
      {label}
    </kbd>
  );
}

function RestingShortcutHint({ label }: { label: string | null }) {
  return label === null ? null : (
    <ShortcutHint
      label={label}
      className="md:[@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/okou-row:opacity-100 group-focus-visible/okou-row:opacity-100"
    />
  );
}

/** New chat leads the conversation list; suggestions have their own entry. */
export function OkouChatListRow() {
  const active = useGet(agentChatPageActive$);
  const { t } = useTranslation();

  const newChat = GLOBAL_KEYBOARD_SHORTCUTS.newChat;
  const shortcutLabel = getShortcutLabel(newChat.binding);
  return (
    <Link
      pathname="/"
      aria-current={active ? "page" : undefined}
      aria-keyshortcuts={newChat.ariaKeyShortcuts}
      className={cn(
        "group/okou-row",
        ENTRY_ROW,
        active ? "bg-state-selected font-medium" : "hover:bg-state-hover",
      )}
    >
      <span className="flex w-8 shrink-0 items-center justify-center px-2">
        {/* The rail entry carries the Okou mark, so New chat reads as an action. */}
        <Edit aria-hidden className="size-4 shrink-0 opacity-70" />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {t(($) => {
          return $.chat.newChat;
        })}
      </span>
      <RestingShortcutHint label={shortcutLabel} />
    </Link>
  );
}

export function ForYouChatListRow({
  touch = false,
}: {
  readonly touch?: boolean;
}) {
  const { t } = useTranslation();
  const enabled = useLastResolved(suggestionsEnabled$) ?? false;
  const active = useGet(activeRoute$) === "forYou";
  const unread = useLastResolved(forYouHasUnread$) === true;
  const followFeed = useSet(followForYouFeedOnRef$);
  if (!enabled) {
    return null;
  }
  return (
    <Link
      pathname={ROUTES.forYou}
      ref={followFeed}
      aria-current={active ? "page" : undefined}
      className={cn(
        ENTRY_ROW,
        active ? "bg-state-selected font-medium" : "hover:bg-state-hover",
        unread && "font-medium",
        touch && "min-h-11 px-3",
      )}
    >
      <span className="flex w-8 shrink-0 items-center justify-center px-2">
        <HandHeart
          aria-hidden
          className="size-4 shrink-0 text-nav-copy-muted"
        />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {t(($) => {
          return $.chat.agentSuggestions.forYou.title;
        })}
      </span>
      <ForYouUnreadIndicator unread={unread} />
    </Link>
  );
}

function ForYouUnreadIndicator({ unread }: { readonly unread: boolean }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {unread && (
        <>
          <ChatThreadStateIndicator state="unread" rowIndex={0} />
          <ChatThreadStateText state="unread" />
        </>
      )}
    </span>
  );
}
