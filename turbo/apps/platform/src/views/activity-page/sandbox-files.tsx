import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  House,
  Link,
  RefreshCw,
  ArrowRightToLine,
  Download,
} from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import type {
  FilesError,
  FilesEntry,
  FilesDirectory,
  SandboxFilesSignals,
} from "../../signals/activity-page/sandbox-files.ts";
import {
  FILES_ROW_HEIGHT,
  filesDirectoryKey,
  type FilesVirtualRow,
} from "../../signals/activity-page/sandbox-files-virtual-list.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  FILES_HOME_LOCATION,
  filesLocationLabel,
  filesLocationTokens,
} from "../../signals/activity-page/sandbox-files-location.ts";
import { SandboxFilesBreadcrumb } from "./sandbox-files-breadcrumb.tsx";
import { WorkspaceCanvasBackdrop } from "../okou-page/workspace-inset.tsx";
import { SandboxFileDownloadFrame } from "./sandbox-file-download.tsx";
import { SandboxFilePreviewDialog } from "./sandbox-file-preview.tsx";

function FilesErrorMessage({ error }: { readonly error: FilesError }) {
  const { t } = useTranslation();
  switch (error) {
    case "updateRequired": {
      return t(($) => {
        return $.activity.detail.files.updateRequired;
      });
    }
    case "stale": {
      return t(($) => {
        return $.activity.detail.files.stale;
      });
    }
    case "limit": {
      return t(($) => {
        return $.activity.detail.files.limit;
      });
    }
    case "unavailable": {
      return t(($) => {
        return $.activity.detail.files.unavailable;
      });
    }
  }
}
const DEPTH_PADDING = ["pl-2", "pl-6", "pl-10", "pl-14", "pl-18"] as const;

function FilesDownloadButton({
  signals,
  entry,
  path,
}: {
  readonly signals: SandboxFilesSignals;
  readonly entry: FilesEntry;
  readonly path: readonly string[];
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const location = useGet(signals.location$);
  const navigating = useGet(signals.navigating$);
  const download = useSet(signals.download$);
  const downloading = useGet(signals.download.busy$);
  const preparingPath = useGet(signals.download.preparingPath$);
  const preparing =
    preparingPath !== null &&
    filesDirectoryKey(preparingPath) ===
      filesDirectoryKey([
        ...filesLocationTokens(location),
        ...path,
        entry.nameToken,
      ]);
  const label = t(
    ($) => {
      return $.activity.detail.files.download;
    },
    { name: entry.displayName },
  );
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="quiet"
              size="icon-sm"
              className={cn(
                "shrink-0 hover:bg-transparent active:bg-transparent [@media(pointer:coarse)]:size-10",
                !preparing &&
                  "[@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/files-row:opacity-100 group-has-[:focus-visible]/files-row:opacity-100",
              )}
              focusableWhenDisabled
              pending={preparing}
              disabled={downloading || navigating}
              aria-label={label}
              onClick={() => {
                detach(
                  download(
                    { origin: location, path, nameToken: entry.nameToken },
                    signal,
                  ),
                  Reason.DomCallback,
                );
              }}
            >
              <Download size={16} />
            </Button>
          }
        />
        <TooltipContent>
          <p className="text-xs">{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function FilesPreviewButton({
  signals,
  entry,
  path,
}: {
  readonly signals: SandboxFilesSignals;
  readonly entry: FilesEntry;
  readonly path: readonly string[];
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const location = useGet(signals.location$);
  const navigating = useGet(signals.navigating$);
  const preview = useSet(signals.preview$);
  return (
    <Button
      type="button"
      variant="quiet"
      size="sm"
      disabled={navigating}
      focusableWhenDisabled
      className="h-full min-w-0 flex-1 justify-start px-0 text-left text-foreground hover:bg-transparent active:bg-transparent"
      title={entry.displayName}
      aria-label={t(
        ($) => {
          return $.activity.detail.files.preview;
        },
        { name: entry.displayName },
      )}
      onClick={(event) => {
        detach(
          preview(
            {
              origin: location,
              path,
              nameToken: entry.nameToken,
              trigger: event.currentTarget,
            },
            signal,
          ),
          Reason.DomCallback,
        );
      }}
    >
      <span className="truncate">{entry.displayName}</span>
    </Button>
  );
}

interface FilesRowProps {
  readonly signals: SandboxFilesSignals;
  readonly row: FilesVirtualRow;
}

function FilesRow({ signals, row }: FilesRowProps) {
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
        <div className="group/files-row flex h-11 min-w-0 items-center gap-1 rounded-lg pr-2 transition-colors hover:bg-state-hover has-[:focus-visible]:bg-state-hover has-[:active]:bg-state-pressed">
          <Button
            type="button"
            variant="quiet"
            size="sm"
            className="h-11 min-w-0 flex-1 justify-start gap-2 hover:bg-transparent active:bg-transparent"
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
            className="shrink-0 hover:bg-transparent active:bg-transparent [@media(pointer:coarse)]:size-10 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/files-row:opacity-100 group-has-[:focus-visible]/files-row:opacity-100"
            aria-label={t(
              ($) => {
                return $.activity.detail.files.enterFolder;
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
      <div className="group/files-row flex h-full min-w-0 items-center gap-2 rounded-lg pr-2 pl-3 text-sm transition-colors hover:bg-state-hover has-[:focus-visible]:bg-state-hover has-[:active]:bg-state-pressed">
        <span className="w-3.5 shrink-0" />
        {entry.kind === "symlink" ? (
          <Link size={16} className="shrink-0 text-muted-foreground" />
        ) : (
          <File size={16} className="shrink-0 text-muted-foreground" />
        )}
        {entry.kind === "file" ? (
          <FilesPreviewButton signals={signals} entry={entry} path={row.path} />
        ) : (
          <span className="min-w-0 flex-1 truncate" title={entry.displayName}>
            {entry.displayName}
          </span>
        )}
        {entry.kind === "file" && (
          <FilesDownloadButton
            signals={signals}
            entry={entry}
            path={row.path}
          />
        )}
        {entry.kind === "symlink" && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {t(($) => {
              return $.activity.detail.files.link;
            })}
          </span>
        )}
        {entry.kind === "other" && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {t(($) => {
              return $.activity.detail.files.other;
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
          return $.activity.detail.files.more;
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
          return $.activity.detail.files.loading;
        })}
      </p>
    );
  }
  return (
    <p className="px-3 py-2 text-sm text-muted-foreground">
      {t(($) => {
        return $.activity.detail.files.empty;
      })}
    </p>
  );
}

function equalFilesRow(
  previous: FilesVirtualRow | undefined,
  next: FilesVirtualRow | undefined,
): boolean {
  if (previous === next) {
    return true;
  }
  if (
    !previous ||
    !next ||
    previous.key !== next.key ||
    previous.path !== next.path ||
    previous.depth !== next.depth ||
    previous.offset !== next.offset
  ) {
    return false;
  }
  if (previous.type === "entry" && next.type === "entry") {
    return previous.entry === next.entry && previous.expanded === next.expanded;
  }
  return (
    previous.type !== "entry" &&
    next.type !== "entry" &&
    previous.type === next.type &&
    previous.directory === next.directory
  );
}

function FilesVirtualListRow({
  signals,
  rowKey,
}: {
  readonly signals: SandboxFilesSignals;
  readonly rowKey: string;
}) {
  const window = useGet(signals.virtual.window$, {
    equalityFn: (previous, next) => {
      return equalFilesRow(previous.byKey.get(rowKey), next.byKey.get(rowKey));
    },
  });
  const focus = useSet(signals.virtual.focus$);
  const row = window.byKey.get(rowKey);
  if (!row) {
    return null;
  }
  return (
    <li
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
}

function FilesVirtualListFrame({
  signals,
  children,
}: {
  readonly signals: SandboxFilesSignals;
  readonly children: ReactNode;
}) {
  const listRef = useSet(signals.virtual.scroll.setListRef$);
  const window = useGet(signals.virtual.window$, {
    equalityFn: (previous, next) => {
      return previous.height === next.height;
    },
  });
  return (
    <ul
      ref={listRef}
      className="relative w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      data-testid="sandbox-files-virtual-list"
      tabIndex={0}
      style={{ height: window.height }}
    >
      {children}
    </ul>
  );
}

function FilesVirtualList({
  signals,
}: {
  readonly signals: SandboxFilesSignals;
}) {
  const window = useGet(signals.virtual.window$, {
    equalityFn: (previous, next) => {
      return (
        previous.rows.length === next.rows.length &&
        previous.rows.every((row, index) => {
          return row.key === next.rows[index]?.key;
        })
      );
    },
  });
  return (
    <FilesVirtualListFrame signals={signals}>
      {window.rows.map((row) => {
        return (
          <FilesVirtualListRow
            key={row.key}
            signals={signals}
            rowKey={row.key}
          />
        );
      })}
    </FilesVirtualListFrame>
  );
}

function FilesRefreshControl({
  signals,
  errorId,
}: {
  readonly signals: SandboxFilesSignals;
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
                  "shrink-0 [@media(pointer:coarse)]:size-10",
                  error && "text-destructive hover:text-destructive",
                )}
                aria-label={t(($) => {
                  return error
                    ? $.activity.detail.files.retry
                    : $.activity.detail.files.refresh;
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
                  return $.activity.detail.files.navigationFailed;
                },
                { path: filesLocationLabel(failure.location) },
              )
            ) : error ? (
              <FilesErrorMessage error={error} />
            ) : (
              t(($) => {
                return $.activity.detail.files.refresh;
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
                return $.activity.detail.files.navigationFailed;
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

export function SandboxFilesBody({
  signals,
}: {
  readonly signals: SandboxFilesSignals;
}) {
  const { t } = useTranslation();
  const runId = useGet(signals.activeRunId$);
  const pending = useGet(signals.pending$);
  const phase = useGet(signals.phase$);
  const signal = useGet(pageSignal$);
  const navigate = useSet(signals.navigate$);
  const errorId = "sandbox-files-error-" + runId;
  if (!runId) {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        {pending
          ? t(($) => {
              return $.activity.detail.files.pending;
            })
          : t(($) => {
              return $.activity.detail.files.noRun;
            })}
      </p>
    );
  }
  return (
    <>
      {/* Match the workspace canvas while occluding the virtual rows below. */}
      <div className="sticky top-0 z-10 isolate flex h-12 items-center gap-2 px-4 py-2">
        <WorkspaceCanvasBackdrop />
        <SandboxFilesBreadcrumb signals={signals} />
        <Button
          type="button"
          variant="quiet"
          size="icon-sm"
          className="shrink-0"
          showTooltip
          aria-label={t(($) => {
            return $.activity.detail.files.goHome;
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
      <SandboxFileDownloadFrame signals={signals.download} />
      <SandboxFilePreviewDialog signals={signals} />
      {phase === "ready" ? (
        <div className="pb-4">
          <FilesVirtualList signals={signals} />
        </div>
      ) : (
        <p
          id={errorId}
          role="status"
          className="p-4 text-sm text-muted-foreground"
        >
          {phase === "connecting" ? (
            t(($) => {
              return $.activity.detail.files.connecting;
            })
          ) : (
            <FilesErrorMessage error={phase} />
          )}
        </p>
      )}
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
        {t(($) => {
          return $.activity.detail.files.readonly;
        })}
      </p>
    </>
  );
}
