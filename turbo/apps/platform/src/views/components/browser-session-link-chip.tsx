import { AppWindow } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";
import {
  MARKDOWN_CHIP_RESET_CLASS,
  STRUCTURED_INLINE_LINK_REFERENCE_CLASS,
} from "./chat-thread-link-chip.tsx";

/**
 * An in-App link to a chat thread's cloud browser, shown as an inline chip
 * that opens the full-page browser viewer in place.
 *
 * The live browser card stays reserved for the current thread's own browser,
 * whose sidebar it opens; any other `/browsers/<id>` link, including one a
 * user pastes, reads as this chip. A bare URL is labeled as a cloud browser,
 * while an authored label is kept.
 */
export function BrowserSessionLinkChip({
  threadId,
  label,
  insideMarkdown = false,
}: {
  readonly threadId: string;
  readonly label?: string;
  readonly insideMarkdown?: boolean;
}) {
  const { t } = useTranslation();
  const title =
    label ??
    t(($) => {
      return $.browserSession.cardTitle;
    });
  return (
    <Link
      pathname={ROUTES.browser}
      options={{ pathParams: { browserThreadId: threadId } }}
      className={
        insideMarkdown
          ? `${STRUCTURED_INLINE_LINK_REFERENCE_CLASS} ${MARKDOWN_CHIP_RESET_CLASS}`
          : STRUCTURED_INLINE_LINK_REFERENCE_CLASS
      }
      title={title}
    >
      <AppWindow size={13} className="shrink-0" />
      <span className="min-w-0 truncate">{title}</span>
    </Link>
  );
}
