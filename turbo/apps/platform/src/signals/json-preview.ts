import { command, computed, state } from "ccstate";
import {
  parseJsonPreview,
  type JsonPreviewNode,
  type JsonPreviewSource,
} from "../lib/json-preview.ts";

export type JsonPreviewRow =
  | {
      readonly kind: "node";
      readonly node: JsonPreviewNode;
      readonly depth: number;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "more";
      readonly node: JsonPreviewNode;
      readonly depth: number;
      readonly remaining: number;
    };

/** One graph belongs to one memoized, loaded preview source; no keyed cache. */
export function createJsonPreviewSignals(source: JsonPreviewSource) {
  const model$ = computed(() => {
    return parseJsonPreview(source);
  });
  const sourceMode$ = state(false);
  const overrides$ = state<ReadonlyMap<number, boolean>>(new Map());
  const pages$ = state<ReadonlyMap<number, number>>(new Map());
  const collapsed$ = state(false);
  const rows$ = computed((get) => {
    const model = get(model$);
    const rows: JsonPreviewRow[] = [];
    if (model.status !== "ready") {
      return { rows, limited: false };
    }
    const overrides = get(overrides$);
    const pages = get(pages$);
    const collapsed = get(collapsed$);
    const stack: JsonPreviewRow[] = [
      { kind: "node", node: model.root, depth: 0, expanded: false },
    ];
    while (stack.length > 0 && rows.length < 512) {
      const row = stack.pop();
      if (!row) {
        break;
      }
      if (row.kind === "more") {
        rows.push(row);
        continue;
      }
      const expanded =
        overrides.get(row.node.offset) ?? (!collapsed && row.depth === 0);
      rows.push({ ...row, expanded });
      if (!expanded || row.node.children.length === 0) {
        continue;
      }
      const count = Math.min(
        row.node.children.length,
        pages.get(row.node.offset) ?? 50,
      );
      if (row.node.children.length > 50) {
        stack.push({
          kind: "more",
          node: row.node,
          depth: row.depth + 1,
          remaining: row.node.children.length - count,
        });
      }
      for (let index = count - 1; index >= 0; index--) {
        const child = row.node.children[index];
        if (child) {
          stack.push({
            kind: "node",
            node: child,
            depth: row.depth + 1,
            expanded: false,
          });
        }
      }
    }
    return { rows, limited: stack.length > 0 };
  });
  return {
    source,
    model$,
    rows$,
    sourceMode$: computed((get) => {
      return get(sourceMode$) || get(model$).status !== "ready";
    }),
    selectView$: command(({ set }, view: "source" | "tree") => {
      return set(sourceMode$, view === "source");
    }),
    toggleNode$: command(({ get, set }, offset: number, expanded: boolean) => {
      set(overrides$, new Map(get(overrides$)).set(offset, !expanded));
    }),
    showMore$: command(({ get, set }, offset: number) => {
      set(
        pages$,
        new Map(get(pages$)).set(offset, (get(pages$).get(offset) ?? 50) + 50),
      );
    }),
    collapseAll$: command(({ set }) => {
      set(collapsed$, true);
      set(overrides$, new Map());
      set(pages$, new Map());
    }),
  };
}

export type JsonPreviewSignals = ReturnType<typeof createJsonPreviewSignals>;
