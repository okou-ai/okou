import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Layers } from "lucide-react";
import { Badge, cn, getShortcutLabel } from "@okouai/ui";
import { defaultAgentChatPageActive$ } from "../../signals/agent.ts";
import { activeRoute$ } from "../../signals/active-route.ts";
import { ROUTES } from "../../signals/route-paths.ts";
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
  const enabled = useGet(suggestionsEnabled$);
  const singleAgent = useGet(singleAgentEnabled$);
  const active = useLastResolved(defaultAgentChatPageActive$) === true;
  const assistantName = useGet(assistantName$);
  const { t } = useTranslation();
  if (!enabled && !singleAgent) {
    return null;
  }
  const newChat = GLOBAL_KEYBOARD_SHORTCUTS.newChat;
  const shortcutLabel = singleAgent ? getShortcutLabel(newChat.binding) : null;
  return (
    <Link
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
  const enabled = useGet(suggestionsEnabled$);
  const active = useGet(activeRoute$) === "forYou";
  const count = useLastResolved(waitingSuggestionCount$);
  const followCount = useSet(followWaitingSuggestionCountOnRef$);
  if (!enabled) {
    return null;
  }
  return (
    <Link
      pathname={ROUTES.forYou}
      ref={followCount}
      aria-current={active ? "page" : undefined}
      className={cn(
        ENTRY_ROW,
        active ? "bg-state-selected font-medium" : "hover:bg-state-hover",
        touch && "min-h-11 px-3",
      )}
    >
      <span className="flex w-8 shrink-0 items-center justify-center px-2">
        <Layers aria-hidden className="size-4 shrink-0 text-nav-copy-muted" />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {t(($) => {
          return $.chat.agentSuggestions.forYou.title;
        })}
      </span>
      <Badge
        className="min-w-6 justify-center text-xs tabular-nums text-nav-copy-muted"
        aria-label={
          count !== undefined
            ? t(
                ($) => {
                  return $.appShell.sidebar.suggestionsWaiting;
                },
                { count },
              )
            : undefined
        }
      >
        {count === undefined ? "–" : count > 9 ? "9+" : count}
      </Badge>
    </Link>
  );
}
