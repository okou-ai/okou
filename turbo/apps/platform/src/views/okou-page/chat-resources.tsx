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
} from "@okouai/ui";
import type { ArtifactSummary } from "@okouai/api-contracts/contracts/artifact-catalog";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { currentChatThreadId$ } from "../../signals/agent-chat.ts";
import { searchParams$ } from "../../signals/route.ts";
import { SIDEBAR_PARAM } from "../../signals/chat-page/chat-thread-panes.ts";
import { openThreadCatalogArtifact$ } from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
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
  RESOURCE_PREVIEW_LIMIT,
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
  const blurControl = useSet(thread.resources.blurControl$);
  const resources = thread.resources;
  const open = useLastResolved(resources.open$) ?? false;
  const wide = useGet(resources.wide$);
  const saving = useGet(resources.saving$);
  const anchor = useGet(resources.anchor$);
  const boundary = useGet(resources.boundary$);
  const collisionBoundary = useGet(resources.collisionBoundary$);
  const popupAnchor = useGet(resources.popupAnchor$);
  const anchorRef = useSet(resources.anchorOnRef$);
  const setOpen = useSet(resources.setOpen$);
  const changePreference = useSet(resources.changePreference$);
  const rootSignal = useGet(rootSignal$);
  const content = useLastLoadable(resources.content$);
  const data = useLastResolved(resources.content$);
  const relationsEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatResourcePanel];
  const origin = useGet(thread.relations.origin$);
  const chats = useLastLoadable(thread.relations.chats.data$);
  const hasRelations =
    relationsEnabled &&
    (origin?.kind === "source" ||
      chats.state === "hasError" ||
      (chats.state === "hasData" &&
        (chats.data.items.length > 0 || chats.data.failed)));
  if (
    !hasRelations &&
    content.state !== "hasError" &&
    !data?.artifacts.length &&
    !data?.links.length
  ) {
    return null;
  }

  return (
    <Popover
      open={open && boundary !== null}
      modal={false}
      onOpenChange={(nextOpen, details) => {
        if (details.reason === "trigger-press") {
          // Only the artifact button changes the preference across chats.
          detach(changePreference(nextOpen, rootSignal), Reason.DomCallback);
          return;
        }
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
      <PopoverTrigger
        ref={anchorRef}
        aria-haspopup={undefined}
        disabled={saving}
        onBlur={(event) => {
          // The artifact button and popup form one keyboard interaction zone.
          blurControl(event.relatedTarget);
        }}
        render={
          <Button
            focusableWhenDisabled
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
            aria-label={t(($) => {
              return $.chat.thread.openArtifacts;
            })}
            aria-pressed={open}
            aria-busy={saving}
          />
        }
      >
        <Package size={18} />
      </PopoverTrigger>
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
        className="h-8.5 min-w-0 flex-1 justify-start gap-2.5 px-1 text-[13px] leading-5 font-normal text-foreground hover:bg-gray-50 focus-visible:bg-gray-50"
        onClick={() => {
          detach(
            openArtifact(thread, artifact.id, pageSignal),
            Reason.DomCallback,
          );
        }}
      >
        <FilePreviewIcon
          filename={artifact.title}
          size="sm"
          className="shrink-0"
        />
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
  return (
    <>
      <ChatOrigin thread={thread} />
      <div
        data-resource-scroll
        className="isolate min-h-0 flex-1 divide-y divide-divider overflow-y-auto overscroll-contain px-4 [overflow-anchor:none] empty:hidden"
      >
        <ChatRelationships thread={thread} />
        {data && data.artifacts.length > 0 && (
          <section
            className="py-3"
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
                .slice(
                  0,
                  expanded.artifacts ? undefined : RESOURCE_PREVIEW_LIMIT,
                )
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
            className="flex items-center justify-between gap-2 py-3 text-xs text-muted-foreground"
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
      </div>
    </>
  );
}
