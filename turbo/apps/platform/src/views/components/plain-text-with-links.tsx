import { useLastResolved } from "ccstate-react";
import type { ReactNode } from "react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { parseChatThreadLink } from "../../lib/chat-thread-link.ts";
import { splitPlainTextUrls } from "../../lib/plain-text-urls.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { ChatThreadLinkChip } from "./chat-thread-link-chip.tsx";

/**
 * User-authored text with its plain http(s) URLs made clickable.
 *
 * Text around a URL is emitted unchanged, so literal Markdown, HTML and
 * whitespace keep reading exactly as the author typed them. Links follow the
 * treatment the App stylesheet gives Markdown links, and carry the same
 * `target`/`rel` pair.
 *
 * `chatThreadChips` is for surfaces inside the signed-in App: there a link to
 * one of its chat threads becomes a chat chip that opens in place. Public
 * surfaces such as a shared thread leave it off, since their reader has no
 * thread list to name the chat and may not be able to open it.
 */
export function PlainTextWithLinks({
  text,
  chatThreadChips = false,
}: {
  text: string;
  chatThreadChips?: boolean;
}): ReactNode {
  const features = useLastResolved(featureSwitch$);
  if (features?.[FeatureSwitchKey.UserMessageLinks] !== true) {
    return <span>{text}</span>;
  }
  const showChatThreadChips =
    chatThreadChips && features[FeatureSwitchKey.ChatThreadLinkChips] === true;
  return (
    <>
      {splitPlainTextUrls(text).map((segment, index) => {
        const key = `${String(index)}:${segment.value}`;
        const chatThreadLink =
          showChatThreadChips && segment.type === "url"
            ? parseChatThreadLink(segment.value, window.location.origin)
            : null;
        if (chatThreadLink !== null) {
          return (
            <ChatThreadLinkChip
              key={key}
              {...chatThreadLink}
              title={segment.value}
            />
          );
        }
        return segment.type === "url" ? (
          <a
            key={key}
            href={segment.value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-link underline-offset-2 hover:text-link-hover hover:underline"
          >
            {segment.value}
          </a>
        ) : (
          <span key={key}>{segment.value}</span>
        );
      })}
    </>
  );
}
