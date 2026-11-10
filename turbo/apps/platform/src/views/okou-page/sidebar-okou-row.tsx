import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { DEFAULT_AGENT_AVATAR_URL } from "@okouai/core/agent-avatar";
import {
  avatarTextureUrl,
  defaultAgentAvatarTextures,
} from "@okouai/core/agent-avatar-texture";
import { cn } from "@okouai/ui";
import { defaultAgentChatPageActive$ } from "../../signals/agent.ts";
import { assistantName$ } from "../../signals/branding.ts";
import {
  waitingSuggestionCount$,
  followWaitingSuggestionCountOnRef$,
  suggestionsEnabled$,
} from "../../signals/okou-page/agent-suggestion-session.ts";
import { singleAgentEnabled$ } from "../../signals/single-agent.ts";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { Link } from "../router/link.tsx";
import { AvatarTextureLayer } from "./avatar-svg-preview.tsx";

const ENTRY_ROW =
  "flex h-16 w-full min-w-0 items-center gap-3 rounded-lg px-2 text-left text-sm text-nav-copy motion-safe:transition-colors motion-safe:duration-[180ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

// The default avatar's own brand tile, the one the chat home greeting draws
// behind the same artwork.
const OKOU_AVATAR_TEXTURE_URL = avatarTextureUrl(
  defaultAgentAvatarTextures()[0]!,
);

/** The badge stops at two characters so it keeps the corner it sits in. */
function waitingBadgeLabel(count: number): string {
  return count > 9 ? "9+" : String(count);
}

/**
 * Okou's face peeking into its tile: the artwork is turned 30° clockwise and
 * cropped so the face enters from the lower left with the bun at the upper
 * right, over the avatar's brand texture. The count takes the lower right
 * corner, clear of the bun.
 */
function OkouRowAvatar({ count }: { count: number }) {
  return (
    <span aria-hidden="true" className="relative size-10 shrink-0">
      <span className="absolute inset-0 overflow-hidden rounded-[10px] border border-surface-border">
        <AvatarTextureLayer url={OKOU_AVATAR_TEXTURE_URL} />
        <img
          src={DEFAULT_AGENT_AVATAR_URL}
          alt=""
          className="absolute -left-[15px] -top-2 h-auto w-[61.5px] max-w-none rotate-30"
        />
      </span>
      {count === 0 ? null : (
        <span
          data-testid="okou-row-waiting-badge"
          className="absolute -bottom-[5px] -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-[3px] text-[10px] font-semibold leading-none tabular-nums text-primary-foreground"
        >
          {waitingBadgeLabel(count)}
        </span>
      )}
    </span>
  );
}

/**
 * The count is drawn on the avatar for sight and named after the row's label
 * for assistive technology, so the badge itself stays hidden from it.
 */
function CountedOkouRowAvatar() {
  const count = useLastResolved(waitingSuggestionCount$) ?? 0;
  return <OkouRowAvatar count={count} />;
}

function WaitingCountLabel() {
  const { t } = useTranslation();
  const count = useLastResolved(waitingSuggestionCount$) ?? 0;
  if (count === 0) {
    return null;
  }
  return (
    <span className="sr-only">
      {t(
        ($) => {
          return $.appShell.sidebar.suggestionsWaiting;
        },
        { count },
      )}
    </span>
  );
}

/**
 * Okou's own entry, first in the chat list: it opens home, where a new chat
 * starts, and counts the suggestion cards waiting there. In My Okou the New
 * chat shortcut lives on the rail's Chat link, which opens the same page.
 */
export function OkouChatListRow() {
  const enabled = useGet(suggestionsEnabled$);
  const singleAgent = useGet(singleAgentEnabled$);
  const active = useLastResolved(defaultAgentChatPageActive$) === true;
  const assistantName = useGet(assistantName$);
  const followCount = useSet(followWaitingSuggestionCountOnRef$);
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
        ENTRY_ROW,
        active ? "bg-state-selected font-medium" : "hover:bg-state-hover",
      )}
    >
      {enabled ? <CountedOkouRowAvatar /> : <OkouRowAvatar count={0} />}
      <span className="min-w-0 flex-1 truncate">{assistantName}</span>
      {enabled ? <WaitingCountLabel /> : null}
    </Link>
  );
}
