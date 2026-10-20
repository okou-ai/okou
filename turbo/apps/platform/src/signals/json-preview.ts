import { command, computed, state, type Computed } from "ccstate";
import {
  parseJsonPreview,
  type JsonPreviewNode,
  type JsonPreviewSource,
} from "../lib/json-preview.ts";

const PAGE_SIZE = 50;

export interface JsonPreviewPageSignals {
  readonly visible$: Computed<boolean>;
  readonly nodes$: Computed<readonly JsonPreviewNodeSignals[]>;
}

export interface JsonPreviewNodeSignals {
  readonly node: JsonPreviewNode;
  readonly expanded$: Computed<boolean | undefined>;
  readonly remaining$: Computed<number | undefined>;
  readonly pages$: Computed<readonly JsonPreviewPageSignals[]>;
}

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

interface JsonPreviewRowIndex {
  readonly nodes: ReadonlyMap<
    number,
    Extract<JsonPreviewRow, { kind: "node" }>
  >;
  readonly more: ReadonlyMap<number, Extract<JsonPreviewRow, { kind: "more" }>>;
}

function createNodeSignals(
  node: JsonPreviewNode,
  rowIndex$: Computed<JsonPreviewRowIndex>,
): JsonPreviewNodeSignals {
  return {
    node,
    expanded$: computed((get) => {
      return get(rowIndex$).nodes.get(node.offset)?.expanded;
    }),
    remaining$: computed((get) => {
      return get(rowIndex$).more.get(node.offset)?.remaining;
    }),
    pages$: computed(() => {
      const pages: JsonPreviewPageSignals[] = [];
      for (const [index, first] of node.children.entries()) {
        if (index % PAGE_SIZE === 0) {
          pages.push({
            visible$: computed((get) => {
              return get(rowIndex$).nodes.has(first.offset);
            }),
            nodes$: computed(() => {
              return node.children
                .slice(index, index + PAGE_SIZE)
                .map((child) => {
                  return createNodeSignals(child, rowIndex$);
                });
            }),
          });
        }
      }
      return pages;
    }),
  };
}

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
        pages.get(row.node.offset) ?? PAGE_SIZE,
      );
      if (row.node.children.length > PAGE_SIZE) {
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
  const rowIndex$ = computed((get) => {
    const nodes = new Map<number, Extract<JsonPreviewRow, { kind: "node" }>>();
    const more = new Map<number, Extract<JsonPreviewRow, { kind: "more" }>>();
    for (const row of get(rows$).rows) {
      if (row.kind === "node") {
        nodes.set(row.node.offset, row);
      } else {
        more.set(row.node.offset, row);
      }
    }
    return { nodes, more };
  });

  return {
    source,
    model$,
    rows$,
    rootNode$: computed((get) => {
      const model = get(model$);
      return model.status === "ready"
        ? createNodeSignals(model.root, rowIndex$)
        : undefined;
    }),
    limited$: computed((get) => {
      return get(rows$).limited;
    }),
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
        new Map(get(pages$)).set(
          offset,
          (get(pages$).get(offset) ?? PAGE_SIZE) + PAGE_SIZE,
        ),
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
