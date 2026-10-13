import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  Button,
  Popover,
  PopoverContent,
  Switch,
  surfaceVariants,
} from "@okouai/ui";
import type { ChatThreadArtifactFile } from "@okouai/api-contracts/contracts/chat-threads";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { openArtifactSidebar$ } from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatResourceLinks, CopyResourceLink } from "./chat-resource-links.tsx";
import { FilePreviewIcon } from "./file-preview-icon.tsx";
import { useOpenThreadArtifacts } from "./thread-sidebar.tsx";

export function ChatResourcesControl({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.ChatResourcePanel];
  return enabled ? <ChatResourcesControlInner thread={thread} /> : null;
}

function ChatResourcesControlInner({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const labelId = `chat-resources-label-${thread.threadId}`;
  const popupRef = useSet(thread.resources.popupOnRef$);
  const blurControl = useSet(thread.resources.blurControl$);
  const resources = thread.resources;
  const open = useLastResolved(resources.open$) ?? false;
  const wide = useGet(resources.wide$);
  const saving = useGet(resources.saving$);
  const anchor = useGet(resources.anchor$);
  const boundary = useGet(resources.boundary$);
  const popupAnchor = useGet(resources.popupAnchor$);
  const anchorRef = useSet(resources.anchorOnRef$);
  const setOpen = useSet(resources.setOpen$);
  const changePreference = useSet(resources.changePreference$);
  const rootSignal = useGet(rootSignal$);
  const label = t(($) => {
    return $.chat.resources.show;
  });

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
      <label
        ref={anchorRef}
        onBlur={(event) => {
          // The switch and popup form one keyboard interaction zone.
          blurControl(event.relatedTarget);
        }}
        className="ml-2 inline-flex min-h-8 shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground"
      >
        <span id={labelId} className="hidden sm:inline">
          {label}
        </span>
        <Switch
          size="sm"
          aria-labelledby={labelId}
          checked={open}
          disabled={saving}
          onCheckedChange={(checked) => {
            // User preferences outlive navigation to another chat.
            detach(changePreference(checked, rootSignal), Reason.DomCallback);
          }}
        />
      </label>
      <PopoverContent
        ref={popupRef}
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

function ChatResourcesBody({ thread }: { readonly thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const outputs = useLastLoadable(thread.resources.outputs$);
  const links = useLastLoadable(thread.resources.links$);
  const retry = useSet(thread.reloadArtifacts$);
  const openAll = useOpenThreadArtifacts(thread);
  const setOpen = useSet(thread.resources.setOpen$);
  const failed = outputs.state === "hasError" || links.state === "hasError";
  const loading = outputs.state === "loading" || links.state === "loading";
  return (
    <>
      <div className="min-h-0 overflow-y-auto p-3">
        {failed ? (
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
        ) : loading ? (
          <div
            role="status"
            aria-label={t(($) => {
              return $.chat.resources.loading;
            })}
            className="flex justify-center p-4"
          >
            <Loader2 className="animate-spin" size={18} />
          </div>
        ) : (
          <div className="space-y-4">
            {outputs.data.length > 0 && (
              <section
                aria-label={t(($) => {
                  return $.chat.resources.outputs;
                })}
              >
                <h3 className="px-2 pb-2 text-xs font-medium text-muted-foreground">
                  {t(($) => {
                    return $.chat.resources.outputs;
                  })}
                </h3>
                <ul className="m-0 list-none p-0">
                  {outputs.data.map((file) => {
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
            {outputs.data.length === 0 && links.data.length === 0 && (
              <p className="px-2 py-4 text-sm text-muted-foreground">
                {t(($) => {
                  return $.chat.resources.empty;
                })}
              </p>
            )}
          </div>
        )}
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
