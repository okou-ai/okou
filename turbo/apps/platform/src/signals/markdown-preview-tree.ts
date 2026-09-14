import { computed, type Computed } from "ccstate";
import type { Root } from "hast";

import { createPlainMarkdownTree } from "../lib/markdown/plain-markdown.ts";
import { parseMarkdownTree } from "../lib/markdown/pipeline.ts";
import {
  createMermaidDiagramRegistry,
  embedMermaidSignals,
} from "./mermaid-diagram.ts";
import type { TextPreviewComputed } from "./text-preview.ts";

export type MarkdownPreviewTreeComputed = Computed<Promise<Root>>;

/** Derive one preview tree and its diagram graph from the current text. */
export function createMarkdownPreviewTree(
  text$: TextPreviewComputed,
): MarkdownPreviewTreeComputed {
  return computed(async (get): Promise<Root> => {
    const source = await get(text$);
    const plainTree = createPlainMarkdownTree(source, { mathEnabled: false });
    if (plainTree !== null) {
      return plainTree;
    }
    const tree = parseMarkdownTree(source, {
      mermaid: true,
    });
    const diagrams = createMermaidDiagramRegistry();
    embedMermaidSignals(tree, diagrams.register);
    return tree;
  });
}
