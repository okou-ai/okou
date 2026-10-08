import { MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ChatThreadLink } from "../../lib/chat-thread-link.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";

export const STRUCTURED_INLINE_REFERENCE_CLASS =
  "relative -top-px mx-0.5 inline-flex h-7 max-w-[240px] items-center " +
  "gap-1.5 rounded-md bg-orange-500/10 px-2 align-middle text-[13px] " +
  "font-medium text-orange-600 dark:bg-orange-400/15 dark:text-orange-300";
const STRUCTURED_INLINE_INTERACTIVE_CLASS =
  "transition-colors hover:bg-orange-500/15 focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-orange-500/30 " +
  "active:bg-orange-500/20 dark:hover:bg-orange-400/20 " +
  "dark:active:bg-orange-400/25";
export const STRUCTURED_INLINE_LINK_REFERENCE_CLASS = `${STRUCTURED_INLINE_REFERENCE_CLASS} ${STRUCTURED_INLINE_INTERACTIVE_CLASS}`;

/**
 * Markdown frames style every `a` through unlayered stylesheet rules — link
 * color, a transparent background and a hover underline — which outrank the
 * chip's layered utilities. Restating the chip's own colors as important keeps
 * a chip inside Markdown looking like one in a user message.
 */
const MARKDOWN_CHIP_RESET_CLASS =
  "bg-orange-500/10! text-orange-600! no-underline! " +
  "hover:bg-orange-500/15! active:bg-orange-500/20! " +
  "dark:bg-orange-400/15! dark:text-orange-300! " +
  "dark:hover:bg-orange-400/20! dark:active:bg-orange-400/25!";

/**
 * An in-App link to a chat thread, shown as an inline chip with its title.
 * A link found in message text also carries its query and hash, so a deep
 * link such as `#run-<id>` still lands where it points.
 */
export function ChatThreadLinkChip({
  threadId,
  searchParams,
  hash,
  title,
  insideMarkdown = false,
}: ChatThreadLink & {
  readonly title: string;
  readonly insideMarkdown?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Link
      pathname={ROUTES.chat}
      options={{ pathParams: { threadId }, searchParams, hash }}
      aria-label={t(
        ($) => {
          return $.chat.thread.openNamedChat;
        },
        { title },
      )}
      className={
        insideMarkdown
          ? `${STRUCTURED_INLINE_LINK_REFERENCE_CLASS} ${MARKDOWN_CHIP_RESET_CLASS}`
          : STRUCTURED_INLINE_LINK_REFERENCE_CLASS
      }
      title={title}
    >
      <MessageCircle size={13} className="shrink-0" />
      <span className="min-w-0 truncate">{title}</span>
    </Link>
  );
}
