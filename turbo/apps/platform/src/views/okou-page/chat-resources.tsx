import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import type { CSSProperties } from "react";
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
import type { ChatThreadArtifactFile } from "@okouai/api-contracts/contracts/chat-threads";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { currentChatThreadId$ } from "../../signals/agent-chat.ts";
import { searchParams$ } from "../../signals/route.ts";
import { SIDEBAR_PARAM } from "../../signals/chat-page/chat-thread-panes.ts";
import { openArtifactSidebar$ } from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatResourceLinks, CopyResourceLink } from "./chat-resource-links.tsx";
import { FilePreviewIcon } from "./file-preview-icon.tsx";
import { useOpenThreadArtifacts } from "./thread-sidebar.tsx";
import { ChatOrigin, ChatRelationships } from "./chat-relations.tsx";
import {
  ChatResourceSectionHeading,
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

function resourcePanelStyle(height: number | null): CSSProperties {
  return {
    "--resource-panel-height": height === null ? undefined : `${height}px`,
  } as CSSProperties;
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
  const frozenHeight = useGet(resources.frozenHeight$);
  const popupAnchor = useGet(resources.popupAnchor$);
  const anchorRef = useSet(resources.anchorOnRef$);
  const setOpen = useSet(resources.setOpen$);
  const changePreference = useSet(resources.changePreference$);
  const rootSignal = useGet(rootSignal$);

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
        style={resourcePanelStyle(frozenHeight)}
        className={surfaceVariants({
          className:
            "flex h-[var(--resource-panel-height,auto)] max-h-[min(720px,var(--available-height))] w-[376px] max-w-[var(--available-width)] flex-col overflow-hidden p-0",
        })}
      >
        <ChatResourcesBody thread={thread} />
      </PopoverContent>
    </Popover>
  );
}

function ResourceOutputRow({
  file,
  threadId,
}: {
  readonly file: ChatThreadArtifactFile;
  readonly threadId: string;
}) {
  const openArtifact = useSet(openArtifactSidebar$);
  return (
    <li className="group/resource-row flex min-w-0 items-center gap-1">
      <Button
        variant="quiet"
        className="h-8.5 min-w-0 flex-1 justify-start gap-2.5 px-1 text-[13px] leading-5 font-normal text-foreground hover:bg-gray-50 focus-visible:bg-gray-50"
        onClick={() => {
          openArtifact(
            {
              url: file.url,
              filename: file.filename,
              contentType: file.contentType,
            },
            threadId,
          );
        }}
      >
        <FilePreviewIcon
          filename={file.filename}
          contentType={file.contentType}
          size="sm"
          className="shrink-0"
        />
        <span className="truncate">{file.filename}</span>
      </Button>
      <CopyResourceLink url={file.aliasUrl ?? file.url} />
    </li>
  );
}

function ChatResourcesBody({ thread }: { readonly thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const content = useLastLoadable(thread.resources.content$);
  const relationsEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatRelations];
  const relationContent = useLastResolved(thread.relations.hasContent$);
  const hasRelations = relationContent === true && relationsEnabled;
  const openAll = useOpenThreadArtifacts(thread);
  const expanded = useGet(thread.resources.expandedSections$);
  const toggleSection = useSet(thread.resources.toggleSection$);
  const setOpen = useSet(thread.resources.setOpen$);
  const data = content.state === "hasData" ? content.data : null;
  return (
    <>
      {hasRelations && <ChatOrigin thread={thread} />}
      {/* Sticky category controls only overlap rows inside this scroll area. */}
      <div className="isolate min-h-0 flex-1 divide-y divide-divider overflow-y-auto overscroll-contain px-4 [overflow-anchor:none]">
        {hasRelations && <ChatRelationships thread={thread} />}
        {content.state === "hasError" ? (
          <div className="flex flex-col items-center gap-2 py-4 text-sm text-muted-foreground">
            <p>
              {t(($) => {
                return $.chat.resources.loadFailed;
              })}
            </p>
          </div>
        ) : data && (data.artifacts.length > 0 || data.links.length > 0) ? (
          <>
            {data.artifacts.length > 0 && (
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
                  count={data.artifacts.length}
                  preview={
                    data.artifacts.length > RESOURCE_PREVIEW_LIMIT
                      ? {
                          expanded: expanded.artifacts,
                          onToggle: () => {
                            toggleSection("artifacts");
                          },
                        }
                      : undefined
                  }
                />
                <ul className="m-0 list-none p-0">
                  {data.artifacts
                    .slice(
                      0,
                      expanded.artifacts ? undefined : RESOURCE_PREVIEW_LIMIT,
                    )
                    .map((file) => {
                      return (
                        <ResourceOutputRow
                          key={file.id}
                          file={file}
                          threadId={thread.threadId}
                        />
                      );
                    })}
                </ul>
              </section>
            )}
            <ChatResourceLinks
              thread={thread}
              preview={{
                limit: RESOURCE_PREVIEW_LIMIT,
                expanded: expanded.links,
                onToggle: () => {
                  toggleSection("links");
                },
              }}
            />
          </>
        ) : data && (!relationsEnabled || relationContent === false) ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t(($) => {
              return $.chat.resources.emptyArtifacts;
            })}
          </p>
        ) : null}
      </div>
      {(content.state === "hasError" ||
        (data && (data.artifacts.length > 0 || data.links.length > 0))) && (
        <div className="shrink-0 border-t border-divider px-4 py-1.5">
          <Button
            variant="quiet"
            size="sm"
            className="justify-start px-1 text-xs leading-4.5 font-normal hover:bg-gray-50 focus-visible:bg-gray-50"
            onClick={() => {
              setOpen(false);
              openAll();
            }}
          >
            {t(($) => {
              return $.chat.resources.viewAll;
            })}
          </Button>
        </div>
      )}
    </>
  );
}
