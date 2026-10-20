import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Package } from "lucide-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  Button,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  surfaceVariants,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import type { ArtifactSummary } from "@okouai/api-contracts/contracts/artifact-catalog";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { currentChatThreadId$ } from "../../signals/agent-chat.ts";
import { searchParams$ } from "../../signals/route.ts";
import { SIDEBAR_PARAM } from "../../signals/chat-page/chat-thread-panes.ts";
import { openThreadCatalogArtifact$ } from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatResourceLinks, CopyResourceLink } from "./chat-resource-links.tsx";
import { FilePreviewIcon } from "./file-preview-icon.tsx";
import { ChatOrigin, ChatRelationships } from "./chat-relations.tsx";
import { HoverScrollTitle } from "./hover-scroll-title.tsx";
import { hostedSiteLink } from "./artifact-display.ts";
import {
  currentHostedSiteUrl,
  hostedSiteUrlChanges$,
} from "../../signals/hosted-site-url-changes.ts";
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
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.ChatResourcePanel];
  const mainThreadId = useGet(currentChatThreadId$);
  const secondaryThreadId = useGet(searchParams$).get(SIDEBAR_PARAM);
  // The old pane can remain mounted while the next thread's metadata loads.
  const current =
    mainThreadId !== null &&
    (thread.threadId === mainThreadId || thread.threadId === secondaryThreadId);
  return enabled && current ? (
    <ChatResourcesButtonInner
      key={thread.threadId}
      thread={thread}
      largeTarget={largeTarget}
    />
  ) : null;
}

// Whether this chat has anything to list, or a failure to explain.
function useHasResources(thread: ChatPanelSignals) {
  const content = useLastLoadable(thread.resources.content$);
  const data = useLastResolved(thread.resources.content$);
  const origin = useGet(thread.relations.origin$);
  const chats = useLastLoadable(thread.relations.chats.data$);
  return (
    origin?.kind === "source" ||
    chats.state === "hasError" ||
    (chats.state === "hasData" &&
      (chats.data.items.length > 0 || chats.data.failed)) ||
    content.state === "hasError" ||
    Boolean(data?.artifacts.length) ||
    Boolean(data?.links.length)
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
  const popupRef = useSet(thread.resources.popupOnRef$);
  const resources = thread.resources;
  const chosen = useGet(resources.chosen$);
  const automatic = useLastResolved(resources.automatic$) ?? false;
  const hasResources = useHasResources(thread);
  // Only a chat with something to show opens on its own.
  const open = chosen ?? (automatic && hasResources);
  const wide = useGet(resources.wide$);
  const anchor = useGet(resources.anchor$);
  const boundary = useGet(resources.boundary$);
  const collisionBoundary = useGet(resources.collisionBoundary$);
  const popupAnchor = useGet(resources.popupAnchor$);
  const setOpen = useSet(resources.setOpen$);

  return (
    <Popover
      open={open && boundary !== null}
      modal={false}
      onOpenChange={(nextOpen, details) => {
        const outside =
          details.reason === "outside-press" || details.reason === "focus-out";
        if (
          !nextOpen &&
          outside &&
          (wide ||
            (details.event.target instanceof Node &&
              anchor?.contains(details.event.target)))
        ) {
          details.cancel();
          return;
        }
        setOpen(nextOpen);
      }}
    >
      <ChatResourcesTrigger
        thread={thread}
        open={open}
        largeTarget={largeTarget}
      />
      <PopoverContent
        ref={popupRef}
        // Persistent resources share the chat's keyboard context.
        role="region"
        anchor={popupAnchor ?? undefined}
        collisionBoundary={collisionBoundary ?? undefined}
        collisionPadding={16}
        collisionAvoidance={{
          side: "none",
          align: "shift",
          fallbackAxisSide: "none",
        }}
        side="bottom"
        sideOffset={0}
        align="end"
        // Automatic opening must never take focus away from the composer.
        initialFocus={false}
        aria-label={t(($) => {
          return $.chat.resources.title;
        })}
        className={surfaceVariants({
          className:
            "flex max-h-[min(720px,var(--available-height))] w-[376px] max-w-[var(--available-width)] flex-col overflow-hidden p-0",
        })}
      >
        <ChatResourcesBody thread={thread} />
      </PopoverContent>
    </Popover>
  );
}

function ChatResourcesTrigger({
  thread,
  open,
  largeTarget,
}: {
  readonly thread: ChatPanelSignals;
  readonly open: boolean;
  readonly largeTarget: boolean;
}) {
  const { t } = useTranslation();
  const anchorRef = useSet(thread.resources.anchorOnRef$);
  const blurControl = useSet(thread.resources.blurControl$);
  const label = t(($) => {
    return $.chat.resources.title;
  });
  return (
    <TooltipProvider delay={300}>
      {/* The open panel sits below the button, where the tooltip would cover it. */}
      <Tooltip disabled={open}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              ref={anchorRef}
              aria-haspopup={undefined}
              onBlur={(event) => {
                // The resource button and popup form one keyboard interaction zone.
                blurControl(event.relatedTarget);
              }}
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
  thread,
}: {
  readonly artifact: ArtifactSummary;
  readonly thread: ChatPanelSignals;
}) {
  const openArtifact = useSet(openThreadCatalogArtifact$);
  const pageSignal = useGet(pageSignal$);
  const changes = useGet(hostedSiteUrlChanges$);
  const titleLink =
    artifact.kind === "hosted-site"
      ? hostedSiteLink(
          artifact.aliasUrl
            ? currentHostedSiteUrl(artifact.aliasUrl, changes)
            : undefined,
        )
      : null;
  return (
    <li className="group/resource-row flex min-w-0 items-center gap-1">
      <Button
        variant="quiet"
        className={cn(
          RESOURCE_ROW_CLASS,
          "justify-start font-normal text-foreground",
        )}
        onClick={() => {
          detach(
            openArtifact(thread, artifact.id, pageSignal),
            Reason.DomCallback,
          );
        }}
      >
        <span className={RESOURCE_GLYPH_CLASS}>
          <FilePreviewIcon filename={artifact.title} size="sm" />
        </span>
        <HoverScrollTitle title={titleLink?.label ?? artifact.title} />
      </Button>
      <CopyResourceLink
        artifactId={artifact.id}
        catalog={thread.resources.catalog}
      />
    </li>
  );
}

function ChatResourcesBody({ thread }: { readonly thread: ChatPanelSignals }) {
  const artifactsId = `${thread.threadId}-resource-artifacts`;
  const { t } = useTranslation();
  const content = useLastLoadable(thread.resources.content$);
  const data = useLastResolved(thread.resources.content$);
  const reload = useSet(thread.resources.catalog.reload$);
  const [paging, loadMore] = useLoadableSet(thread.resources.catalog.loadMore$);
  const pageSignal = useGet(pageSignal$);
  const expanded = useGet(thread.resources.expandedSections$);
  const toggleSection = useSet(thread.resources.toggleSection$);
  const hasResources = useHasResources(thread);
  const chatsLoading =
    useLastLoadable(thread.relations.chats.data$).state === "loading";
  return (
    <div
      data-resource-scroll
      className="isolate min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3 pt-1 [overflow-anchor:none]"
    >
      <ChatOrigin thread={thread} />
      <ChatRelationships thread={thread} />
      {data && data.artifacts.length > 0 && (
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
          <ul id={artifactsId} className="m-0 list-none p-0">
            {data.artifacts
              .slice(0, expanded.artifacts ? undefined : RESOURCE_PREVIEW_LIMIT)
              .map((artifact) => {
                return (
                  <ResourceOutputRow
                    key={artifact.id}
                    artifact={artifact}
                    thread={thread}
                  />
                );
              })}
          </ul>
          {(data.artifacts.length > RESOURCE_PREVIEW_LIMIT ||
            data.nextCursor) && (
            <ChatResourceSectionToggle
              expanded={expanded.artifacts}
              controls={artifactsId}
              onToggle={(trigger) => {
                toggleSection("artifacts", trigger);
              }}
            />
          )}
          {expanded.artifacts && data.nextCursor && (
            <Button
              variant="quiet"
              size="xs"
              disabled={paging.state === "loading"}
              onClick={() => {
                detach(loadMore(pageSignal), Reason.DomCallback);
              }}
            >
              {t(($) => {
                return paging.state === "hasError"
                  ? $.chat.resources.retry
                  : $.artifacts.catalog.loadMore;
              })}
            </Button>
          )}
        </section>
      )}
      <ChatResourceLinks
        thread={thread}
        preview={{
          limit: RESOURCE_PREVIEW_LIMIT,
          expanded: expanded.links,
          onToggle: (trigger) => {
            toggleSection("links", trigger);
          },
        }}
      />
      {content.state === "hasError" && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 px-2 pt-3 text-xs text-muted-foreground"
        >
          <p>
            {t(($) => {
              return $.chat.resources.loadFailed;
            })}
          </p>
          <Button variant="quiet" size="xs" onClick={reload}>
            {t(($) => {
              return $.chat.resources.retry;
            })}
          </Button>
        </div>
      )}
      {!hasResources && (
        <p className="px-2 py-6 text-center text-[13px] leading-5 text-muted-foreground">
          {data && !chatsLoading
            ? t(($) => {
                return $.chat.resources.empty;
              })
            : t(($) => {
                return $.chat.resources.loading;
              })}
        </p>
      )}
    </div>
  );
}
