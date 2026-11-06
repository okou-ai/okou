import type { ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Copy, Package } from "lucide-react";
import {
  Button,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RunningIndicator,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import type { ArtifactSummary } from "@okouai/api-contracts/contracts/artifact-catalog";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { openThreadCatalogArtifact$ } from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { copyChatResourceArtifact$ } from "../../signals/chat-page/chat-resources.ts";
import { FilePreviewIcon } from "./file-preview-icon.tsx";
import { emptyArtifactImg } from "./platform-assets.ts";
import { ChatOrigin, ChatRelationships } from "./chat-relations.tsx";
import { HoverScrollTitle } from "./hover-scroll-title.tsx";
import { useTitleReveal } from "./use-title-reveal.ts";
import { useChatHeaderTransitioning } from "./chat-header-actions.ts";
import { ChatPanelEmptyState } from "./chat-panel-empty-state.tsx";
import {
  CHAT_HEADER_PANEL_CLASS,
  ChatHeaderPanelHeader,
} from "./chat-header-panel.tsx";
import {
  ChatResourceSectionHeading,
  ChatResourceSectionToggle,
  RESOURCE_GLYPH_CLASS,
  RESOURCE_PREVIEW_LIMIT,
  RESOURCE_ROW_CLASS,
  RESOURCE_SECTION_CLASS,
} from "./chat-resource-section.tsx";

export function ChatResourcesButton({
  thread,
  largeTarget = false,
}: {
  readonly thread: ChatPanelSignals;
  readonly largeTarget?: boolean;
}) {
  return (
    <ChatResourcesButtonInner
      key={thread.threadId}
      thread={thread}
      largeTarget={largeTarget}
    />
  );
}

function ChatResourcesButtonInner({
  thread,
  largeTarget,
}: {
  readonly thread: ChatPanelSignals;
  readonly largeTarget: boolean;
}) {
  const { t } = useTranslation();
  // The old pane can remain mounted while the next thread's metadata loads.
  const transitioning = useChatHeaderTransitioning(thread);
  const resources = thread.resources;
  const open = useGet(resources.open$);
  const setOpen = useSet(resources.setOpen$);
  const visible = !transitioning && open;
  const copyLabel = t(($) => {
    return $.chat.resources.copyLink;
  });
  const copyGlyph = <Copy size={14} />;
  const copyTooltip = (
    <TooltipContent>
      <p className="text-xs">{copyLabel}</p>
    </TooltipContent>
  );

  return (
    <Popover
      open={visible}
      onOpenChange={(nextOpen, details) => {
        if (nextOpen && transitioning) {
          details.cancel();
          return;
        }
        setOpen(nextOpen);
      }}
    >
      <ChatResourcesTrigger
        open={visible}
        loading={transitioning}
        largeTarget={largeTarget}
      />
      <PopoverContent
        align="end"
        sideOffset={8}
        aria-label={t(($) => {
          return $.chat.resources.title;
        })}
        className={CHAT_HEADER_PANEL_CLASS}
      >
        <ChatHeaderPanelHeader
          icon={<Package size={18} />}
          title={t(($) => {
            return $.chat.resources.title;
          })}
          closeLabel={t(($) => {
            return $.chat.resources.close;
          })}
          onClose={() => {
            setOpen(false);
          }}
        />
        {visible ? (
          <ChatResourcesContent
            thread={thread}
            copyLabel={copyLabel}
            copyGlyph={copyGlyph}
            copyTooltip={copyTooltip}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** Loads only while shown, then draws every source at once. */
function ChatResourcesContent({
  thread,
  copyLabel,
  copyGlyph,
  copyTooltip,
}: {
  readonly thread: ChatPanelSignals;
  readonly copyLabel: string;
  readonly copyGlyph: ReactNode;
  readonly copyTooltip: ReactNode;
}) {
  const ready = useLastResolved(thread.resources.ready$) ?? false;
  return ready ? (
    <ChatResourcesBody
      thread={thread}
      copyLabel={copyLabel}
      copyGlyph={copyGlyph}
      copyTooltip={copyTooltip}
    />
  ) : (
    <ChatResourcesSkeleton />
  );
}

/** One section of rows in the panel's own geometry, shown until it draws complete. */
function ChatResourcesSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t(($) => {
        return $.chat.resources.loading;
      })}
      className="mt-1 min-h-0 flex-1 px-3 pb-3"
    >
      <div aria-hidden="true" className={RESOURCE_SECTION_CLASS}>
        <div className="flex min-h-6 items-center px-2">
          <Skeleton className="h-3 w-16" />
        </div>
        {[0, 1, 2].map((row) => {
          return (
            <div key={row} className="flex h-8.5 items-center gap-2 px-2">
              <Skeleton className="size-5 shrink-0 rounded-md" />
              <Skeleton className="h-3.5 w-3/5" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChatResourcesTrigger({
  open,
  loading,
  largeTarget,
}: {
  readonly open: boolean;
  readonly loading: boolean;
  readonly largeTarget: boolean;
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.chat.resources.title;
  });
  const loadingLabel = t(($) => {
    return $.chat.resources.loading;
  });
  return (
    <TooltipProvider delay={300}>
      <Tooltip disabled={open}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="quiet"
                  size="icon-sm"
                  iconSize="md"
                  className={cn(
                    "shrink-0 duration-150",
                    largeTarget && "size-11",
                    open &&
                      "bg-primary/10 text-selected-foreground hover:text-selected-foreground",
                  )}
                  aria-label={label}
                  aria-busy={loading}
                  aria-disabled={loading || undefined}
                  // Why presses do nothing must not depend on hover or motion.
                  aria-description={loading ? loadingLabel : undefined}
                />
              }
            />
          }
        >
          <Package size={18} />
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ResourceOutputRow({
  artifact,
  onOpen,
  onCopy,
  copyLabel,
  copyGlyph,
}: {
  readonly artifact: ArtifactSummary;
  readonly onOpen: (artifactId: string) => void;
  readonly onCopy: (artifactId: string) => void;
  readonly copyLabel: string;
  readonly copyGlyph: ReactNode;
}) {
  const titleReveal = useTitleReveal();
  return (
    <li className="group/resource-row flex min-w-0 items-center gap-1">
      <Button
        {...titleReveal}
        variant="quiet"
        className={cn(
          RESOURCE_ROW_CLASS,
          "justify-start font-normal text-foreground",
        )}
        onClick={() => {
          onOpen(artifact.id);
        }}
      >
        <span className={RESOURCE_GLYPH_CLASS}>
          <FilePreviewIcon filename={artifact.title} size="sm" />
        </span>
        <HoverScrollTitle title={artifact.title} />
      </Button>
      <TooltipTrigger
        delay={200}
        render={
          <Button
            variant="quiet"
            size="icon-xs"
            aria-label={copyLabel}
            className="shrink-0 hover:bg-state-hover focus-visible:bg-state-hover [@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/resource-row:opacity-100 group-has-[:focus-visible]/resource-row:opacity-100 [&_svg]:size-3.5"
            onClick={() => {
              onCopy(artifact.id);
            }}
          >
            {copyGlyph}
          </Button>
        }
      />
    </li>
  );
}

function ChatResourcesStatus({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const content = useLastLoadable(thread.resources.content$);
  const data = useLastResolved(thread.resources.content$);
  const origin = useGet(thread.relations.origin$);
  const chats = useLastLoadable(thread.relations.chats.data$);
  if (content.state === "hasError") {
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-2 px-2 pt-3 text-xs text-muted-foreground"
      >
        <p>
          {t(($) => {
            return $.chat.resources.loadFailed;
          })}
        </p>
      </div>
    );
  }
  const hasContent =
    origin?.kind === "source" ||
    Boolean(data?.artifacts.length) ||
    (chats.state === "hasData" && chats.data.items.length > 0);
  if (hasContent) {
    return null;
  }
  if (!data || chats.state !== "hasData" || chats.data.failed) {
    return null;
  }
  // The scroller leaves 4px above for sections that add their own top space
  // and 12px below. The illustration's transparent margin takes the rest, so
  // the visible empty state sits centred.
  return (
    <ChatPanelEmptyState
      image={emptyArtifactImg}
      title={t(($) => {
        return $.chat.resources.emptyTitle;
      })}
      description={t(($) => {
        return $.chat.resources.emptyDescription;
      })}
      className="px-4 pt-6 pb-5"
    />
  );
}

function ChatResourceArtifacts({
  thread,
  artifactCount,
  hasMore,
  expanded,
  controls,
  children,
}: {
  readonly thread: ChatPanelSignals;
  readonly artifactCount: number;
  readonly hasMore: boolean;
  readonly expanded: boolean;
  readonly controls: string;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  const [paging, loadMore] = useLoadableSet(thread.resources.catalog.loadMore$);
  const pageSignal = useGet(pageSignal$);
  const toggleSection = useSet(thread.resources.toggleSection$);
  if (artifactCount === 0) {
    return null;
  }
  return (
    <section
      className={RESOURCE_SECTION_CLASS}
      aria-label={t(($) => {
        return $.artifacts.sidebar.panelTitle;
      })}
    >
      <ChatResourceSectionHeading
        title={t(($) => {
          return $.artifacts.sidebar.panelTitle;
        })}
      />
      {children}
      {(artifactCount > RESOURCE_PREVIEW_LIMIT || hasMore) && (
        <ChatResourceSectionToggle
          expanded={expanded}
          hasMore={hasMore}
          loading={paging.state === "loading"}
          controls={controls}
          onToggle={(trigger) => {
            if (expanded && hasMore) {
              detach(loadMore(pageSignal), Reason.DomCallback);
              return;
            }
            toggleSection("artifacts", trigger);
          }}
        />
      )}
      {expanded && hasMore && paging.state === "loading" && (
        <p
          role="status"
          className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
        >
          <RunningIndicator />
          {t(($) => {
            return $.chat.resources.loading;
          })}
        </p>
      )}
      {expanded && hasMore && paging.state === "hasError" && (
        <p role="alert" className="px-2 py-1 text-xs text-muted-foreground">
          {t(($) => {
            return $.chat.resources.loadFailed;
          })}
        </p>
      )}
    </section>
  );
}

function ChatResourcesBody({
  thread,
  copyLabel,
  copyGlyph,
  copyTooltip,
}: {
  readonly thread: ChatPanelSignals;
  readonly copyLabel: string;
  readonly copyGlyph: ReactNode;
  readonly copyTooltip: ReactNode;
}) {
  const artifactsId = `${thread.threadId}-resource-artifacts`;
  const data = useLastResolved(thread.resources.content$);
  const expanded = useGet(thread.resources.expandedSections$);
  const openArtifact = useSet(openThreadCatalogArtifact$);
  const copyArtifact = useSet(copyChatResourceArtifact$);
  const pageSignal = useGet(pageSignal$);
  const onOpen = (artifactId: string) => {
    detach(openArtifact(thread, artifactId, pageSignal), Reason.DomCallback);
  };
  const onCopy = (artifactId: string) => {
    detach(
      copyArtifact(thread.resources.catalog, artifactId, pageSignal),
      Reason.DomCallback,
    );
  };
  return (
    <div
      data-resource-scroll
      className="isolate mt-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3 [overflow-anchor:none]"
    >
      <ChatOrigin thread={thread} />
      <ChatRelationships thread={thread} />
      <ChatResourceArtifacts
        thread={thread}
        artifactCount={data?.artifacts.length ?? 0}
        hasMore={Boolean(data?.nextCursor)}
        expanded={expanded.artifacts}
        controls={artifactsId}
      >
        {data && (
          <Tooltip>
            <ul id={artifactsId} className="m-0 list-none p-0">
              {data.artifacts
                .slice(
                  0,
                  expanded.artifacts ? undefined : RESOURCE_PREVIEW_LIMIT,
                )
                .map((artifact) => {
                  return (
                    <ResourceOutputRow
                      key={artifact.id}
                      artifact={artifact}
                      onOpen={onOpen}
                      onCopy={onCopy}
                      copyLabel={copyLabel}
                      copyGlyph={copyGlyph}
                    />
                  );
                })}
            </ul>
            {copyTooltip}
          </Tooltip>
        )}
      </ChatResourceArtifacts>
      <ChatResourcesStatus thread={thread} />
    </div>
  );
}
