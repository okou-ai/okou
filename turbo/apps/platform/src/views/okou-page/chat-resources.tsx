import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
  type Loadable,
} from "ccstate-react";
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
import type { ChatResourceContent } from "../../signals/chat-page/chat-resources.ts";
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
  const requestedOpen = useLastResolved(resources.open$) ?? false;
  const content = useLastLoadable(resources.content$);
  const ready =
    content.state === "hasError" ||
    (content.state === "hasData" && content.data !== null);
  const open = requestedOpen && ready;
  const wide = useGet(resources.wide$);
  const saving = useGet(resources.saving$);
  const anchor = useGet(resources.anchor$);
  const boundary = useGet(resources.boundary$);
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
        collisionBoundary={boundary ?? undefined}
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
            "flex max-h-[min(480px,var(--available-height))] w-[376px] max-w-[var(--available-width)] flex-col overflow-hidden p-0",
        })}
      >
        <ChatResourcesBody thread={thread} content={content} />
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
    <li className="group flex min-w-0 items-center rounded-lg hover:bg-state-hover">
      <Button
        variant="quiet"
        className="h-10 min-w-0 flex-1 justify-start gap-3 px-2 text-sm font-normal"
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

function ChatResourcesBody({
  thread,
  content,
}: {
  readonly thread: ChatPanelSignals;
  readonly content: Loadable<ChatResourceContent | null>;
}) {
  const { t } = useTranslation();
  const retry = useSet(thread.reloadArtifacts$);
  const openAll = useOpenThreadArtifacts(thread);
  const setOpen = useSet(thread.resources.setOpen$);
  const data = content.state === "hasData" ? content.data : null;
  return (
    <>
      <div className="min-h-0 overflow-y-auto p-3">
        {content.state === "hasError" ? (
          <div className="flex flex-col items-center gap-2 py-4 text-sm text-muted-foreground">
            <p>
              {t(($) => {
                return $.chat.resources.loadFailed;
              })}
            </p>
            <Button variant="quiet" size="sm" onClick={retry}>
              {t(($) => {
                return $.chat.resources.retry;
              })}
            </Button>
          </div>
        ) : data ? (
          <div className="space-y-4">
            {data.artifacts.length > 0 && (
              <section
                aria-label={t(($) => {
                  return $.artifacts.sidebar.panelTitle;
                })}
              >
                <h3 className="px-2 pb-2 text-xs font-medium text-muted-foreground">
                  {t(($) => {
                    return $.artifacts.sidebar.panelTitle;
                  })}
                </h3>
                <ul className="m-0 list-none p-0">
                  {data.artifacts.map((file) => {
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
            <ChatResourceLinks thread={thread} />
            {data.artifacts.length === 0 && data.links.length === 0 && (
              <p className="px-2 py-4 text-sm text-muted-foreground">
                {t(($) => {
                  return $.chat.resources.empty;
                })}
              </p>
            )}
          </div>
        ) : null}
      </div>
      <div className="shrink-0 border-t border-border/60 p-2">
        <Button
          variant="quiet"
          size="sm"
          className="w-full justify-start"
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
    </>
  );
}
