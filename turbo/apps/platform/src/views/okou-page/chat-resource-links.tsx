import { useLastResolved, useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Copy, ExternalLink, Link2 } from "lucide-react";
import { Button } from "@okouai/ui";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { copyChatResourceLink$ } from "../../signals/chat-page/chat-resources.ts";
import { ChatResourceSectionHeading } from "./chat-resource-section.tsx";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function CopyResourceLink({ url }: { readonly url: string }) {
  const { t } = useTranslation();
  const copy = useSet(copyChatResourceLink$);
  const signal = useGet(pageSignal$);
  return (
    <Button
      showTooltip
      variant="quiet"
      size="icon-sm"
      aria-label={t(($) => {
        return $.chat.resources.copyLink;
      })}
      className="shrink-0 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
      onClick={() => {
        return detach(copy(url, signal), Reason.DomCallback);
      }}
    >
      <Copy size={14} />
    </Button>
  );
}

export function ChatResourceLinks({
  thread,
  preview,
  showHeading = true,
}: {
  readonly thread: ChatPanelSignals;
  readonly preview?: {
    readonly limit: number;
    readonly expanded: boolean;
    readonly onToggle: () => void;
  };
  readonly showHeading?: boolean;
}) {
  const { t } = useTranslation();
  const links = useLastResolved(thread.resources.links$) ?? [];
  if (links.length === 0) {
    return null;
  }
  return (
    <section
      aria-label={t(($) => {
        return $.chat.resources.links;
      })}
    >
      {showHeading && (
        <ChatResourceSectionHeading
          icon={Link2}
          title={t(($) => {
            return $.chat.resources.links;
          })}
          count={links.length}
          preview={
            preview && links.length > preview.limit ? preview : undefined
          }
        />
      )}
      <ul className="m-0 list-none p-0">
        {links
          .slice(0, preview?.expanded ? undefined : preview?.limit)
          .map((link) => {
            return (
              <li
                key={link.url}
                className="group flex min-w-0 items-center rounded-lg hover:bg-state-hover"
              >
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1 text-sm hover:bg-state-hover"
                  title={link.url}
                >
                  <ExternalLink
                    size={16}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{link.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {new URL(link.url).hostname}
                    </span>
                  </span>
                </a>
                <CopyResourceLink url={link.url} />
              </li>
            );
          })}
      </ul>
    </section>
  );
}
