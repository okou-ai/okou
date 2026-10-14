import { useLastResolved, useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ChevronUp, Copy, Ellipsis, ExternalLink } from "lucide-react";
import { Button } from "@okouai/ui";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { copyChatResourceLink$ } from "../../signals/chat-page/chat-resources.ts";
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

export function ChatResourcePreviewToggle({
  expanded,
  onToggle,
}: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return expanded ? $.chat.resources.showLess : $.chat.resources.viewAll;
  });
  return (
    <Button
      variant="quiet"
      size="xs"
      iconSize="lg"
      className="w-full justify-start rounded-lg px-2 font-normal"
      aria-label={label}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {expanded ? (
        <>
          {label}
          <ChevronUp aria-hidden />
        </>
      ) : (
        <Ellipsis size={20} aria-hidden />
      )}
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
        <h3 className="px-2 pb-2 text-xs font-medium text-muted-foreground">
          {t(($) => {
            return $.chat.resources.links;
          })}
        </h3>
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
                  className="flex h-10 min-w-0 flex-1 items-center gap-3 rounded-lg px-2 text-sm hover:bg-state-hover"
                  title={link.url}
                >
                  <ExternalLink
                    size={16}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="truncate">{link.title}</span>
                </a>
                <CopyResourceLink url={link.url} />
              </li>
            );
          })}
      </ul>
      {preview && links.length > preview.limit && (
        <ChatResourcePreviewToggle
          expanded={preview.expanded}
          onToggle={preview.onToggle}
        />
      )}
    </section>
  );
}
