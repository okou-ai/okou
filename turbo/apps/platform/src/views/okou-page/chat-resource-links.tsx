import { useLastResolved, useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Copy, Link2 } from "lucide-react";
import { Button } from "@okouai/ui";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import type { ArtifactCatalogSignals } from "../../signals/artifacts-page/create-artifact-catalog-signals.ts";
import {
  copyChatResourceLink$,
  copyChatResourceArtifact$,
  type ChatResourceLink,
} from "../../signals/chat-page/chat-resources.ts";
import {
  ChatResourceSectionHeading,
  ChatResourceSectionToggle,
  RESOURCE_GLYPH_CLASS,
  RESOURCE_ROW_CLASS,
  RESOURCE_SECTION_CLASS,
} from "./chat-resource-section.tsx";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { HoverScrollTitle } from "./hover-scroll-title.tsx";

function linkTitle(link: ChatResourceLink) {
  return link.title === link.url
    ? link.title.replace(/^https?:\/\//u, "")
    : link.title;
}

// A link labelled with its own address already shows where it goes.
function linkHost(link: ChatResourceLink) {
  const host = new URL(link.url).hostname.replace(/^www\./u, "");
  return link.title === link.url || link.title.includes(host) ? null : host;
}

export function CopyResourceLink(
  source:
    | { readonly url: string }
    | {
        readonly artifactId: string;
        readonly catalog: ArtifactCatalogSignals;
      },
) {
  const { t } = useTranslation();
  const copy = useSet(copyChatResourceLink$);
  const copyArtifact = useSet(copyChatResourceArtifact$);
  const signal = useGet(pageSignal$);
  return (
    <Button
      showTooltip
      variant="quiet"
      size="icon-xs"
      aria-label={t(($) => {
        return $.chat.resources.copyLink;
      })}
      className="shrink-0 hover:bg-state-hover focus-visible:bg-state-hover [@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/resource-row:opacity-100 group-has-[:focus-visible]/resource-row:opacity-100 [&_svg]:size-3.5"
      onClick={() => {
        return detach(
          "artifactId" in source
            ? copyArtifact(source.catalog, source.artifactId, signal)
            : copy(source.url, signal),
          Reason.DomCallback,
        );
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
    readonly onToggle: (trigger: HTMLElement) => void;
  };
  readonly showHeading?: boolean;
}) {
  const { t } = useTranslation();
  const linksId = `${thread.threadId}-${preview ? "resource" : "sidebar"}-links`;
  const links = useLastResolved(thread.resources.links$) ?? [];
  if (links.length === 0) {
    return null;
  }
  return (
    <section
      className={showHeading ? RESOURCE_SECTION_CLASS : undefined}
      aria-label={t(($) => {
        return $.chat.resources.links;
      })}
    >
      {showHeading && (
        <ChatResourceSectionHeading
          title={t(($) => {
            return $.chat.resources.links;
          })}
        />
      )}
      <ul id={linksId} className="m-0 list-none p-0">
        {links
          .slice(0, preview?.expanded ? undefined : preview?.limit)
          .map((link) => {
            return (
              <li
                key={link.url}
                className="group/resource-row flex min-w-0 items-center gap-1"
              >
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={RESOURCE_ROW_CLASS}
                >
                  <span className={RESOURCE_GLYPH_CLASS}>
                    <Link2 size={16} />
                  </span>
                  <HoverScrollTitle title={linkTitle(link)} />
                  {linkHost(link) && (
                    // The address stays the link's accessible destination; the
                    // host only helps sighted users scan.
                    <span
                      aria-hidden="true"
                      className="max-w-32 shrink-0 truncate text-xs text-muted-foreground"
                    >
                      {linkHost(link)}
                    </span>
                  )}
                </a>
                <CopyResourceLink url={link.url} />
              </li>
            );
          })}
      </ul>
      {preview && links.length > preview.limit && (
        <ChatResourceSectionToggle
          expanded={preview.expanded}
          controls={linksId}
          onToggle={preview.onToggle}
        />
      )}
    </section>
  );
}
