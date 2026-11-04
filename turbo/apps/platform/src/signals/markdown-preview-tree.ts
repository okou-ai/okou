import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { computed, type Computed } from "ccstate";
import type { Root } from "hast";

import { createPlainMarkdownTree } from "../lib/markdown/plain-markdown.ts";
import { parseMarkdownTree } from "../lib/markdown/pipeline.ts";
import {
  createMermaidDiagramRegistry,
  embedMermaidSignals,
  type MermaidDiagramPreviewCommand,
} from "./mermaid-diagram.ts";
import type { TextPreviewComputed } from "./text-preview.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";

export type MarkdownPreviewTreeComputed = Computed<Promise<Root>>;

/** Derive one preview tree and its diagram graph from the current text. */
export function createMarkdownPreviewTree(
  text$: TextPreviewComputed,
  openDiagram$: MermaidDiagramPreviewCommand,
): MarkdownPreviewTreeComputed {
  return computed(async (get): Promise<Root> => {
    const cjkEmphasis =
      get(featureSwitch$)[FeatureSwitchKey.MarkdownCjkEmphasis] === true;
    const { text: source } = await get(text$);
    const plainTree = createPlainMarkdownTree(source, { mathEnabled: false });
    if (plainTree !== null) {
      return plainTree;
    }
    const tree = parseMarkdownTree(source, {
      mermaid: true,
      cjkEmphasis,
    });
    const diagrams = createMermaidDiagramRegistry(openDiagram$);
    embedMermaidSignals(tree, diagrams.register);
    return tree;
  });
}
