import { MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { inlineReferenceVariants } from "@okouai/ui";

import type { ChatThreadLink } from "../../lib/chat-thread-link.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";

export const STRUCTURED_INLINE_REFERENCE_CLASS = inlineReferenceVariants({
  className: "max-w-[min(240px,100%)]",
});
export const STRUCTURED_INLINE_LINK_REFERENCE_CLASS = inlineReferenceVariants({
  interactive: true,
  className: "max-w-[min(240px,100%)]",
});

/**
 * Markdown frames style every `a` through unlayered stylesheet rules — link
 * color, a transparent background and a hover underline — which outrank the
 * chip's layered utilities. Restating the chip's own colors as important keeps
 * a chip inside Markdown looking like one in a user message.
 */
const MARKDOWN_CHIP_RESET_CLASS =
  "bg-state-selected-hover! dark:bg-state-selected! text-foreground! " +
  "no-underline! hover:bg-state-hover-overlay! active:bg-state-pressed-overlay!";

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
      <MessageCircle size={13} className="shrink-0 text-selected-foreground" />
      <span className="min-w-0 truncate">{title}</span>
    </Link>
  );
}
