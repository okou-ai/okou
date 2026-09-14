import type { SharedMessage } from "@okouai/api-contracts/contracts/shared-threads";
import { command, computed, state, type Command, type Computed } from "ccstate";
import type { Root } from "hast";

import { parseMarkdownTree } from "../../lib/markdown/pipeline.ts";
import {
  createImageLoadSignals,
  embedImageLoadSignals,
} from "../image-load.ts";
import {
  createMermaidDiagramSignals,
  embedMermaidSignals,
} from "../mermaid-diagram.ts";

export interface SharedThreadRichContentSignals {
  readonly trees$: Computed<Promise<ReadonlyMap<number, Root>>>;
  readonly retry$: Command<void, []>;
}

function createScopedResolver<Key, Value>(
  createValue: (key: Key) => Value,
): (key: Key) => Value {
  const values = new Map<Key, Value>();
  return (key) => {
    const existing = values.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const value = createValue(key);
    values.set(key, value);
    return value;
  };
}

/**
 * Derives the rich bodies of one immutable shared thread when the view consumes
 * `trees$`. Its resource resolvers are bounded by those message bodies and keep
 * diagram and image signal identities stable if the user retries preparation.
 */
export function createSharedThreadRichContentSignals(
  messages: readonly SharedMessage[],
  ownerSignal: AbortSignal,
): SharedThreadRichContentSignals {
  const resolveMermaidDiagram = createScopedResolver((code: string) => {
    return createMermaidDiagramSignals(code, ownerSignal);
  });
  const resolveImageLoad = createScopedResolver(() => {
    return createImageLoadSignals();
  });
  const internalRevision$ = state(0);
  const trees$ = computed(async (get) => {
    get(internalRevision$);
    // Let the page shell and plain bodies render before rich parsing begins.
    await Promise.resolve();
    const trees = new Map<number, Root>();
    for (const message of messages) {
      const tree = parseMarkdownTree(message.content, {
        math: true,
        mermaid: true,
      });
      embedMermaidSignals(tree, resolveMermaidDiagram);
      embedImageLoadSignals(tree, resolveImageLoad);
      trees.set(message.messageIndex, tree);
    }
    return trees;
  });

  const retry$ = command(({ set }) => {
    set(internalRevision$, (revision) => {
      return revision + 1;
    });
  });

  return { retry$, trees$ };
}
