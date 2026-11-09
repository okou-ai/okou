import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Badge, cn } from "@okouai/ui";
import { activeRoute$ } from "../../signals/active-route.ts";
import { assistantName$ } from "../../signals/branding.ts";
import {
  feedWaitingCount$,
  followFeedWaitingCountOnRef$,
  suggestionFeedEnabled$,
} from "../../signals/okou-page/agent-suggestion-session.ts";
import { OkouLogomark } from "../components/okou-logomark.tsx";
import { Link } from "../router/link.tsx";

function FeedWaitingCount() {
  const { t } = useTranslation();
  const count = useLastResolved(feedWaitingCount$) ?? 0;
  if (count === 0) {
    return null;
  }
  return (
    <Badge className="shrink-0 text-xs font-medium tabular-nums text-nav-copy-muted">
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">
        {t(
          ($) => {
            return $.appShell.sidebar.feedWaiting;
          },
          { count },
        )}
      </span>
    </Badge>
  );
}

/**
 * Okou's own entry, first in the chat list: it opens the Feed and counts the
 * cards waiting there. The glyph takes the Project folders' slot so the names
 * line up.
 */
export function FeedChatListRow() {
  const enabled = useGet(suggestionFeedEnabled$);
  const active = useGet(activeRoute$) === "feed";
  const assistantName = useGet(assistantName$);
  const followCount = useSet(followFeedWaitingCountOnRef$);
  if (!enabled) {
    return null;
  }
  return (
    <Link
      ref={followCount}
      pathname="/feed"
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 w-full min-w-0 items-center rounded-lg pr-2 text-left text-sm text-nav-copy motion-safe:transition-colors motion-safe:duration-[180ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        active ? "bg-state-selected font-medium" : "hover:bg-state-hover",
      )}
    >
      <span className="flex w-8 shrink-0 items-center justify-center px-2">
        <OkouLogomark className="size-4 shrink-0 opacity-70" />
      </span>
      <span className="min-w-0 flex-1 truncate">{assistantName}</span>
      <FeedWaitingCount />
    </Link>
  );
}
