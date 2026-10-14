import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  Link,
  RefreshCw,
} from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { Button, ScrollBar, cn } from "@okouai/ui";
import type {
  FilesError,
  FilesDirectory,
  SandboxFilesSidebarSignals,
} from "../../signals/chat-page/sandbox-files-sidebar.ts";
import {
  FILES_ROW_HEIGHT,
  filesDirectoryKey,
  type FilesVirtualRow,
} from "../../signals/chat-page/sandbox-files-virtual-list.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";

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
  if (row.type === "entry") {
    const { entry } = row;
    if (entry.kind === "directory") {
      return (
        <Button
          type="button"
          variant="quiet"
          size="sm"
          className="h-11 w-full justify-start gap-2"
          aria-expanded={row.expanded}
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
        disabled={row.directory.loading}
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
  return (
    <FilesDirectoryStatus
      signals={signals}
      directory={row.directory}
      path={row.path}
    />
  );
}

function FilesDirectoryStatus({
  signals,
  directory,
  path,
}: {
  readonly signals: SandboxFilesSidebarSignals;
  readonly directory: FilesDirectory;
  readonly path: readonly string[];
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const refresh = useSet(signals.refresh$);
  if (directory.loading && directory.listingId === null) {
    return (
      <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
        {t(($) => {
          return $.chat.files.loading;
        })}
      </p>
    );
  }
  if (directory.error) {
    return (
      <div className="space-y-2 px-3 py-2">
        <p role="status" className="text-sm text-muted-foreground">
          <FilesErrorMessage error={directory.error} />
        </p>
        {directory.error !== "updateRequired" && (
          <Button
            type="button"
            variant="neutral"
            size="sm"
            onClick={() => {
              detach(refresh(path, signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.chat.files.retry;
            })}
          </Button>
        )}
      </div>
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
              height: row.slots * FILES_ROW_HEIGHT,
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

export function SandboxFilesSidebarBody({
  signals,
}: {
  readonly signals: SandboxFilesSidebarSignals;
}) {
  const { t } = useTranslation();
  const runId = useGet(signals.activeRunId$);
  const signal = useGet(pageSignal$);
  const pending = useGet(signals.pending$);
  const phase = useGet(signals.phase$);
  const limit = useGet(signals.limit$);
  const directories = useGet(signals.directories$);
  const refresh = useSet(signals.refresh$);
  const retry = useSet(signals.retry$);
  const viewport = useSet(signals.virtual.scroll.setScrollViewport$);
  const metrics = useSet(signals.virtual.scroll.setScrollMetrics$);
  const root = directories.get(filesDirectoryKey([]));
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
  if (phase !== "ready") {
    return (
      <div className="space-y-3 p-4">
        <p role="status" className="text-sm text-muted-foreground">
          {phase === "connecting" ? (
            t(($) => {
              return $.chat.files.connecting;
            })
          ) : (
            <FilesErrorMessage error={phase} />
          )}
        </p>
        {phase !== "connecting" && phase !== "updateRequired" && (
          <Button
            type="button"
            variant="neutral"
            size="sm"
            onClick={() => {
              retry(signal);
            }}
          >
            {t(($) => {
              return $.chat.files.retry;
            })}
          </Button>
        )}
      </div>
    );
  }
  return (
    <>
      <div className="flex items-center gap-2 px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          /home/user
        </span>
        <Button
          showTooltip
          type="button"
          variant="quiet"
          size="icon-sm"
          aria-label={t(($) => {
            return $.chat.files.refresh;
          })}
          disabled={root?.loading}
          focusableWhenDisabled
          aria-busy={root?.loading}
          onClick={() => {
            detach(refresh([], signal), Reason.DomCallback);
          }}
        >
          <RefreshCw size={16} />
        </Button>
      </div>
      {limit && (
        <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
          {t(($) => {
            return $.chat.files.limit;
          })}
        </p>
      )}
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
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
        {t(($) => {
          return $.chat.files.readonly;
        })}
      </p>
    </>
  );
}
