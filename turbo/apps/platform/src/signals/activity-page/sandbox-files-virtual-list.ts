import { command, computed, state, type Computed } from "ccstate";
import { animationFrame } from "signal-timers";
import {
  createFixedVirtualScrollSignals,
  getFixedVirtualRange,
} from "../fixed-virtual-list.ts";
import type { FilesDirectory, FilesEntry } from "./sandbox-files.ts";

export function filesDirectoryKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

export const FILES_ROW_HEIGHT = 44;
export type FilesVirtualRow = {
  readonly key: string;
  readonly path: readonly string[];
  readonly depth: number;
  readonly offset: number;
} & (
  | {
      readonly type: "entry";
      readonly entry: FilesEntry;
      readonly expanded: boolean;
    }
  | { readonly type: "status" | "more"; readonly directory: FilesDirectory }
);

function buildFilesRows(directories: ReadonlyMap<string, FilesDirectory>) {
  const rows: FilesVirtualRow[] = [];
  let offset = 0;
  const visit = (path: readonly string[], depth: number) => {
    const directory = directories.get(filesDirectoryKey(path));
    if (!directory) {
      return;
    }
    for (const entry of directory.entries) {
      const childPath = [...path, entry.nameToken];
      const expanded =
        entry.kind === "directory" &&
        directories.has(filesDirectoryKey(childPath));
      rows.push({
        type: "entry",
        key: `${directory.id}:${entry.nameToken}`,
        path: directory.path,
        depth,
        offset,
        entry,
        expanded,
      });
      offset += FILES_ROW_HEIGHT;
      if (expanded) {
        visit(childPath, depth + 1);
      }
    }
    if (
      !directory.error &&
      ((directory.loading && directory.listingId === null) ||
        (directory.entries.length === 0 && !directory.cursor))
    ) {
      rows.push({
        type: "status",
        key: `status:${directory.id}`,
        path: directory.path,
        depth,
        offset,
        directory,
      });
      offset += FILES_ROW_HEIGHT;
    }
    if (directory.cursor && !directory.error) {
      rows.push({
        type: "more",
        key: `more:${directory.id}`,
        path: directory.path,
        depth,
        offset,
        directory,
      });
      offset += FILES_ROW_HEIGHT;
    }
  };
  visit([], 0);
  return { rows, height: offset };
}

export function createSandboxFilesVirtualListSignals(
  directories$: Computed<ReadonlyMap<string, FilesDirectory>>,
) {
  const scroll = createFixedVirtualScrollSignals(false);
  const focusedKey$ = state<string | null>(null);
  const rows$ = computed((get) => {
    return buildFilesRows(get(directories$));
  });
  const window$ = computed((get) => {
    const { rows, height } = get(rows$);
    const metrics = get(scroll.scrollMetrics$);
    const viewport = get(scroll.scrollViewport$);
    const range = getFixedVirtualRange({
      itemCount: rows.length,
      rowHeight: FILES_ROW_HEIGHT,
      scrollTop: metrics.scrollTop,
      viewportHeight:
        metrics.clientHeight || viewport?.clientHeight || FILES_ROW_HEIGHT * 12,
    });
    const focusedKey = get(focusedKey$);
    const visibleRows = rows.filter((row) => {
      return (
        (row.offset + FILES_ROW_HEIGHT > range.startIndex * FILES_ROW_HEIGHT &&
          row.offset < range.endIndex * FILES_ROW_HEIGHT) ||
        row.key === focusedKey
      );
    });
    return {
      height,
      rows: visibleRows,
      byKey: new Map(
        visibleRows.map((row) => {
          return [row.key, row];
        }),
      ),
    };
  });
  const reset$ = command(({ get, set }) => {
    const viewport = get(scroll.scrollViewport$);
    if (viewport) {
      viewport.scrollTop = 0;
    }
    set(scroll.setScrollMetrics$, {
      scrollTop: 0,
      clientHeight: viewport?.clientHeight ?? 0,
    });
    set(focusedKey$, null);
  });
  return {
    scroll,
    window$,
    reset$,
    restore$: command(
      (
        { get, set },
        scrollTop: number,
        focus: boolean,
        signal: AbortSignal,
      ) => {
        const rootId = get(directories$).get(filesDirectoryKey([]))?.id;
        const viewport = get(scroll.scrollViewport$);
        const initialScrollTop = get(scroll.scrollMetrics$).scrollTop;
        animationFrame(
          () => {
            if (
              !viewport ||
              viewport !== get(scroll.scrollViewport$) ||
              initialScrollTop !== get(scroll.scrollMetrics$).scrollTop ||
              rootId !== get(directories$).get(filesDirectoryKey([]))?.id
            ) {
              return;
            }
            viewport.scrollTop = scrollTop;
            set(scroll.setScrollMetrics$, {
              scrollTop: viewport.scrollTop,
              clientHeight: viewport.clientHeight,
            });
            if (
              focus &&
              (document.activeElement === document.body ||
                viewport.contains(document.activeElement))
            ) {
              viewport.focus({ preventScroll: true });
            }
          },
          { signal },
        );
      },
    ),
    focus$: command(({ set }, key: string | null) => {
      set(focusedKey$, key);
    }),
    reconcileFocus$: command(({ get, set }) => {
      const focusedKey = get(focusedKey$);
      if (
        !focusedKey ||
        get(rows$).rows.some((row) => {
          return row.key === focusedKey;
        })
      ) {
        return;
      }
      const viewport = get(scroll.scrollViewport$);
      if (viewport?.contains(document.activeElement)) {
        viewport.focus({ preventScroll: true });
      }
      set(focusedKey$, null);
    }),
  };
}
