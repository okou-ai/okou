import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  House,
  Link,
  RefreshCw,
  ArrowRightToLine,
} from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@base-ui/react/scroll-area";
import {
  Button,
  ScrollBar,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import type {
  FilesError,
  FilesDirectory,
  SandboxFilesSidebarSignals,
} from "../../signals/chat-page/sandbox-files-sidebar.ts";
import {
  FILES_ROW_HEIGHT,
  type FilesVirtualRow,
} from "../../signals/chat-page/sandbox-files-virtual-list.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  FILES_HOME_LOCATION,
  filesLocationLabel,
} from "../../signals/chat-page/sandbox-files-location.ts";
import { SandboxFilesBreadcrumb } from "./sandbox-files-breadcrumb.tsx";

function FilesErrorMessage({ error }: { readonly error: FilesError }) {
  const { t } = useTranslation();
  switch (error) {
    case "updateRequired": {
      return t(($) => {
        return $.chat.files.updateRequired;
      });
    }
    case "stale": {
      return t(($) => {
        return $.chat.files.stale;
      });
    }
    case "limit": {
      return t(($) => {
        return $.chat.files.limit;
      });
    }
    case "unavailable": {
      return t(($) => {
        return $.chat.files.unavailable;
      });
    }
  }
}
const DEPTH_PADDING = ["pl-2", "pl-6", "pl-10", "pl-14", "pl-18"] as const;

function FilesRow({
  signals,
  row,
}: {
  readonly signals: SandboxFilesSidebarSignals;
  readonly row: FilesVirtualRow;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const toggle = useSet(signals.toggle$);
  const more = useSet(signals.more$);
  const enter = useSet(signals.enter$);
  const location = useGet(signals.location$);
  const navigating = useGet(signals.navigating$);
  if (row.type === "entry") {
    const { entry } = row;
    if (entry.kind === "directory") {
      return (
        <div className="group/files-row flex h-11 min-w-0 items-center gap-1">
          <Button
            type="button"
            variant="quiet"
            size="sm"
            className="h-11 min-w-0 flex-1 justify-start gap-2"
            aria-expanded={row.expanded}
            disabled={navigating}
            focusableWhenDisabled
            onClick={() => {
              detach(
                toggle([...row.path, entry.nameToken], signal),
                Reason.DomCallback,
              );
            }}
          >
            {row.expanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )}
            <Folder size={16} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate" title={entry.displayName}>
              {entry.displayName}
            </span>
          </Button>
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            showTooltip
            className="shrink-0 [@media(pointer:coarse)]:size-10 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/files-row:opacity-100 group-focus-within/files-row:opacity-100"
            aria-label={t(
              ($) => {
                return $.chat.files.enterFolder;
              },
              { name: entry.displayName },
            )}
            onClick={() => {
              detach(
                enter(location, [...row.path, entry.nameToken], signal),
                Reason.DomCallback,
              );
            }}
          >
            <ArrowRightToLine size={16} />
          </Button>
        </div>
      );
    }
    return (
      <div className="flex h-full min-w-0 items-center gap-2 px-3 text-sm">
        <span className="w-3.5 shrink-0" />
        {entry.kind === "symlink" ? (
          <Link size={16} className="shrink-0 text-muted-foreground" />
        ) : (
          <File size={16} className="shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 truncate" title={entry.displayName}>
          {entry.displayName}
        </span>
        {entry.kind === "symlink" && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {t(($) => {
              return $.chat.files.link;
            })}
          </span>
        )}
        {entry.kind === "other" && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {t(($) => {
              return $.chat.files.other;
            })}
          </span>
        )}
      </div>
    );
  }
  if (row.type === "more") {
    return (
      <Button
        type="button"
        variant="quiet"
        size="sm"
        className="h-11"
        disabled={row.directory.loading || navigating}
        focusableWhenDisabled
        aria-busy={row.directory.loading}
        onClick={() => {
          detach(more(row.path, signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.chat.files.more;
        })}
      </Button>
    );
  }
  return <FilesDirectoryStatus directory={row.directory} />;
}

function FilesDirectoryStatus({
  directory,
}: {
  readonly directory: FilesDirectory;
}) {
  const { t } = useTranslation();
  if (directory.loading && directory.listingId === null) {
    return (
      <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
        {t(($) => {
          return $.chat.files.loading;
        })}
      </p>
    );
  }
  return (
    <p className="px-3 py-2 text-sm text-muted-foreground">
      {t(($) => {
        return $.chat.files.empty;
      })}
    </p>
  );
}

function FilesVirtualList({
  signals,
}: {
  readonly signals: SandboxFilesSidebarSignals;
}) {
  const window = useGet(signals.virtual.window$);
  const focus = useSet(signals.virtual.focus$);
  return (
    <ul
      className="relative w-full"
      data-testid="sandbox-files-virtual-list"
      style={{ height: window.height }}
    >
      {window.rows.map((row) => {
        return (
          <li
            key={row.key}
            data-testid="sandbox-files-virtual-row"
            className={cn(
              "absolute left-0 top-0 w-full pr-2",
              DEPTH_PADDING[Math.min(row.depth, 4)],
            )}
            style={{
              height: FILES_ROW_HEIGHT,
              transform: "translateY(" + row.offset + "px)",
            }}
            onFocus={() => {
              focus(row.key);
            }}
            onBlur={() => {
              focus(null);
            }}
          >
            <FilesRow signals={signals} row={row} />
          </li>
        );
      })}
    </ul>
  );
}

function FilesRefreshControl({
  signals,
  errorId,
}: {
  readonly signals: SandboxFilesSidebarSignals;
  readonly errorId: string;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const phase = useGet(signals.phase$);
  const failure = useGet(signals.failure$);
  const loading = useGet(signals.refreshing$);
  const refresh = useSet(signals.refresh$);
  const retry = useSet(signals.retry$);
  const error =
    phase === "ready" ? failure?.error : phase === "connecting" ? null : phase;
  return (
    <>
      <TooltipProvider delay={200}>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="quiet"
                size="icon-sm"
                className={cn(
                  error && "text-destructive hover:text-destructive",
                )}
                aria-label={t(($) => {
                  return error ? $.chat.files.retry : $.chat.files.refresh;
                })}
                aria-describedby={error ? errorId : undefined}
                disabled={loading || error === "updateRequired"}
                focusableWhenDisabled
                aria-busy={loading}
                onClick={() => {
                  if (phase !== "ready") {
                    retry(signal);
                  } else {
                    detach(
                      refresh(failure?.path ?? [], signal),
                      Reason.DomCallback,
                    );
                  }
                }}
              >
                <span
                  aria-hidden="true"
                  className="relative inline-flex size-5 items-center justify-center"
                >
                  <RefreshCw size={16} />
                  {error && (
                    <span className="absolute -right-1 -top-1 flex size-3 items-center justify-center rounded-full bg-background text-xs font-bold">
                      !
                    </span>
                  )}
                </span>
              </Button>
            }
          />
          <TooltipContent role="tooltip" side="bottom">
            {failure?.location && error !== "updateRequired" ? (
              t(
                ($) => {
                  return $.chat.files.navigationFailed;
                },
                { path: filesLocationLabel(failure.location) },
              )
            ) : error ? (
              <FilesErrorMessage error={error} />
            ) : (
              t(($) => {
                return $.chat.files.refresh;
              })
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {phase === "ready" && error && (
        <span id={errorId} role="status" className="sr-only">
          {failure?.location && error !== "updateRequired" ? (
            t(
              ($) => {
                return $.chat.files.navigationFailed;
              },
              { path: filesLocationLabel(failure.location) },
            )
          ) : (
            <FilesErrorMessage error={error} />
          )}
        </span>
      )}
    </>
  );
}

export function SandboxFilesSidebarBody({
  signals,
}: {
  readonly signals: SandboxFilesSidebarSignals;
}) {
  const { t } = useTranslation();
  const runId = useGet(signals.activeRunId$);
  const pending = useGet(signals.pending$);
  const phase = useGet(signals.phase$);
  const signal = useGet(pageSignal$);
  const navigate = useSet(signals.navigate$);
  const viewport = useSet(signals.virtual.scroll.setScrollViewport$);
  const metrics = useSet(signals.virtual.scroll.setScrollMetrics$);
  const errorId = "sandbox-files-error-" + runId;
  if (!runId) {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        {pending
          ? t(($) => {
              return $.chat.files.pending;
            })
          : t(($) => {
              return $.chat.files.noRun;
            })}
      </p>
    );
  }
  return (
    <>
      <div className="flex items-center gap-2 px-4 py-2">
        <SandboxFilesBreadcrumb signals={signals} />
        <Button
          type="button"
          variant="quiet"
          size="icon-sm"
          className="shrink-0"
          showTooltip
          aria-label={t(($) => {
            return $.chat.files.goHome;
          })}
          disabled={phase !== "ready"}
          focusableWhenDisabled
          onClick={() => {
            detach(navigate(FILES_HOME_LOCATION, signal), Reason.DomCallback);
          }}
        >
          <House size={16} />
        </Button>
        <FilesRefreshControl signals={signals} errorId={errorId} />
      </div>
      {phase === "ready" ? (
        <ScrollArea.Root className="min-h-0 flex-1">
          <ScrollArea.Viewport
            ref={viewport}
            data-slot="scroll-area-viewport"
            data-testid="sandbox-files-viewport"
            className="h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            tabIndex={0}
            onScroll={(event) => {
              metrics({
                scrollTop: event.currentTarget.scrollTop,
                clientHeight: event.currentTarget.clientHeight,
              });
            }}
          >
            <ScrollArea.Content className="pb-4">
              <FilesVirtualList signals={signals} />
            </ScrollArea.Content>
          </ScrollArea.Viewport>
          <ScrollBar />
        </ScrollArea.Root>
      ) : (
        <p
          id={errorId}
          role="status"
          className="p-4 text-sm text-muted-foreground"
        >
          {phase === "connecting" ? (
            t(($) => {
              return $.chat.files.connecting;
            })
          ) : (
            <FilesErrorMessage error={phase} />
          )}
        </p>
      )}
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
        {t(($) => {
          return $.chat.files.readonly;
        })}
      </p>
    </>
  );
}
