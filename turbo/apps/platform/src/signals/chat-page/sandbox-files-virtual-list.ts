import { command, computed, state, type Computed } from "ccstate";
import {
  createFixedVirtualScrollSignals,
  getFixedVirtualRange,
} from "../fixed-virtual-list.ts";
import type { FilesDirectory, FilesEntry } from "./sandbox-files-sidebar.ts";

export function filesDirectoryKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

export const FILES_ROW_HEIGHT = 44;
export type FilesVirtualRow = {
  readonly key: string;
  readonly path: readonly string[];
  readonly depth: number;
  readonly offset: number;
  readonly slots: number;
} & (
  | {
      readonly type: "entry";
      readonly entry: FilesEntry;
      readonly expanded: boolean;
    }
  | { readonly type: "status" | "more"; readonly directory: FilesDirectory }
);

export function createSandboxFilesVirtualListSignals(
  directories$: Computed<ReadonlyMap<string, FilesDirectory>>,
) {
  const scroll = createFixedVirtualScrollSignals(false);
  const focusedKey$ = state<string | null>(null);
  const rows$ = computed((get) => {
    const directories = get(directories$);
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
          slots: 1,
          entry,
          expanded,
        });
        offset += FILES_ROW_HEIGHT;
        if (expanded) {
          visit(childPath, depth + 1);
        }
      }
      if (
        directory.loading ||
        directory.error ||
        (directory.entries.length === 0 && !directory.cursor)
      ) {
        const slots = directory.error ? 5 : 1;
        rows.push({
          type: "status",
          key: `status:${directory.id}`,
          path: directory.path,
          depth,
          offset,
          slots,
          directory,
        });
        offset += slots * FILES_ROW_HEIGHT;
      }
      if (directory.cursor && !directory.error) {
        rows.push({
          type: "more",
          key: `more:${directory.id}`,
          path: directory.path,
          depth,
          offset,
          slots: 1,
          directory,
        });
        offset += FILES_ROW_HEIGHT;
      }
    };
    visit([], 0);
    return { rows, height: offset };
  });
  const window$ = computed((get) => {
    const { rows, height } = get(rows$);
    const metrics = get(scroll.scrollMetrics$);
    const viewport = get(scroll.scrollViewport$);
    const range = getFixedVirtualRange({
      itemCount: height / FILES_ROW_HEIGHT,
      rowHeight: FILES_ROW_HEIGHT,
      scrollTop: metrics.scrollTop,
      viewportHeight:
        metrics.clientHeight || viewport?.clientHeight || FILES_ROW_HEIGHT * 12,
    });
    const focusedKey = get(focusedKey$);
    return {
      height,
      rows: rows.filter((row) => {
        return (
          (row.offset + row.slots * FILES_ROW_HEIGHT >
            range.startIndex * FILES_ROW_HEIGHT &&
            row.offset < range.endIndex * FILES_ROW_HEIGHT) ||
          row.key === focusedKey
        );
      }),
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
    focus$: command(({ set }, key: string | null) => {
      set(focusedKey$, key);
    }),
  };
}
