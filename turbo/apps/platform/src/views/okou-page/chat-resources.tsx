import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Copy, Package } from "lucide-react";
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
import { copyChatResourceArtifact$ } from "../../signals/chat-page/chat-resources.ts";
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
  // Resources load only while the panel shows, so the default cannot wait for them.
  const open = chosen ?? automatic;
  const wide = useGet(resources.wide$);
  const anchor = useGet(resources.anchor$);
  const boundary = useGet(resources.boundary$);
  const collisionBoundary = useGet(resources.collisionBoundary$);
  const popupAnchor = useGet(resources.popupAnchor$);
  const setOpen = useSet(resources.setOpen$);
  const visible = open && boundary !== null;

  return (
    <Popover
      open={visible}
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
        {visible ? <ChatResourcesBody thread={thread} /> : null}
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
  const { t } = useTranslation();
  const openArtifact = useSet(openThreadCatalogArtifact$);
  const copyArtifact = useSet(copyChatResourceArtifact$);
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
            copyArtifact(thread.resources.catalog, artifact.id, pageSignal),
            Reason.DomCallback,
          );
        }}
      >
        <Copy size={14} />
      </Button>
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
  const reload = useSet(thread.resources.catalog.reload$);
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
        <Button variant="quiet" size="xs" onClick={reload}>
          {t(($) => {
            return $.chat.resources.retry;
          })}
        </Button>
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
  if (
    data === null ||
    content.state === "loading" ||
    chats.state === "loading"
  ) {
    return (
      <p
        role="status"
        className="px-2 py-6 text-center text-[13px] leading-5 text-muted-foreground"
      >
        {t(($) => {
          return $.chat.resources.loading;
        })}
      </p>
    );
  }
  if (data === undefined || chats.state !== "hasData" || chats.data.failed) {
    return null;
  }
  return (
    <p className="px-2 py-6 text-center text-[13px] leading-5 text-muted-foreground">
      {t(($) => {
        return $.chat.resources.empty;
      })}
    </p>
  );
}

function ChatResourcesBody({ thread }: { readonly thread: ChatPanelSignals }) {
  const artifactsId = `${thread.threadId}-resource-artifacts`;
  const { t } = useTranslation();
  const data = useLastResolved(thread.resources.content$);
  const [paging, loadMore] = useLoadableSet(thread.resources.catalog.loadMore$);
  const pageSignal = useGet(pageSignal$);
  const expanded = useGet(thread.resources.expandedSections$);
  const toggleSection = useSet(thread.resources.toggleSection$);
  return (
    <div
      data-resource-scroll
      className="isolate mt-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3 [overflow-anchor:none]"
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
      <ChatResourcesStatus thread={thread} />
    </div>
  );
}
