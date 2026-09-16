import { command, computed, type Command, type Computed } from "ccstate";
import type { Element, Root } from "hast";
import { renderMermaidDiagramFile } from "../lib/mermaid-renderer.ts";

import { createObjectUrlResource } from "./object-url-resource.ts";
import { onRef } from "./utils.ts";

/**
 * A black-on-white SVG layout, independent of the app theme. Each mounted
 * image owns its own object URL.
 */
export interface MermaidDiagramImage {
  readonly file: File;
  readonly imageRef$: Command<
    (() => void) | undefined,
    [HTMLImageElement | null]
  >;
}

export interface MermaidDiagramSignals {
  readonly code: string;
  /** Resolves `null` when the source is not a supported Mermaid diagram. */
  readonly diagram$: Computed<Promise<MermaidDiagramImage | null>>;
}

// Declared here rather than in the parse pipeline: the pipeline emits only
// `data.mermaid` ({code}), and this field is written by the signals layer
// afterwards, by `embedMermaidSignals`.
declare module "hast" {
  interface Data {
    mermaidSignals?: MermaidDiagramSignals;
  }
}

/**
 * Resolve every mermaid marker in a freshly parsed tree to its diagram
 * signals and embed them on the node. Rendering then receives the signals
 * object from the tree, the same way cards do.
 */
export function embedMermaidSignals(
  tree: Root,
  resolve: (code: string) => MermaidDiagramSignals,
): void {
  const visitNode = (node: Root | Element): void => {
    for (const child of node.children) {
      if (child.type !== "element") {
        continue;
      }
      const mermaid = child.data?.mermaid;
      if (mermaid !== undefined) {
        child.data = { ...child.data, mermaidSignals: resolve(mermaid.code) };
        continue;
      }
      visitNode(child);
    }
  };
  visitNode(tree);
}

/** Constructed by the layout computed, before any mounted image needs a URL. */
function createDiagramImage(file: File): MermaidDiagramImage {
  const imageRef$ = onRef(
    command((_, element: HTMLImageElement, signal: AbortSignal) => {
      // A short URL keeps the SVG markup out of the image's src attribute.
      element.src = createObjectUrlResource(file, signal).url;
    }),
  );
  return { file, imageRef$ };
}

export interface MermaidDiagramRegistry {
  /** Get-or-create by source without starting layout or allocating a URL. */
  readonly register: (code: string) => MermaidDiagramSignals;
}

/**
 * A registry scoped to one surface. Source signals and their memoized files
 * live with this graph; there is no application-wide source cache. Each
 * mounted image owns a separate URL and releases it on ref cleanup.
 */
export function createMermaidDiagramRegistry(): MermaidDiagramRegistry {
  const signalsByCode = new Map<string, MermaidDiagramSignals>();

  const register = (code: string): MermaidDiagramSignals => {
    const existing = signalsByCode.get(code);
    if (existing !== undefined) {
      return existing;
    }
    const diagram$ = computed(async (): Promise<MermaidDiagramImage | null> => {
      const file = await renderMermaidDiagramFile(code);
      return file === null ? null : createDiagramImage(file);
    });
    const signals: MermaidDiagramSignals = { code, diagram$ };
    signalsByCode.set(code, signals);
    return signals;
  };

  return { register };
}
