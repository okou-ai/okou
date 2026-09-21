import type { SharedMessage } from "@okouai/api-contracts/contracts/shared-threads";
import { command, computed, type Command, type Computed } from "ccstate";
import type { Root } from "hast";
import { visit } from "unist-util-visit";

import { parseMarkdownTree } from "../../lib/markdown/pipeline.ts";
import {
  createArtifactSignals,
  type ArtifactDescriptor,
  type ArtifactSignals,
} from "../chat-page/artifact-card-signals.ts";
import {
  classifyChatAttachment,
  isPreviewableChatUrl,
  previewAttachmentFromUrl,
} from "../chat-page/parse-body-blocks.ts";
import { embedHostedSiteCards } from "../hosted-site-card.ts";
import {
  createImageLoadSignals,
  embedImageLoadSignals,
} from "../image-load.ts";
import {
  createMermaidDiagramRegistry,
  embedMermaidSignals,
} from "../mermaid-diagram.ts";
import type { PublicArtifactPreviewSignals } from "../public-artifact-preview.ts";

export interface SharedThreadRichContentSignals {
  readonly trees$: Computed<Promise<ReadonlyMap<number, Root>>>;
}

export interface SharedThreadArtifactSignals extends ArtifactSignals {
  readonly openPreview$: Command<void, [label: string, signal: AbortSignal]>;
}

export function createSharedThreadArtifactSignals(
  descriptor: ArtifactDescriptor,
  viewer: PublicArtifactPreviewSignals,
): SharedThreadArtifactSignals {
  const previewImageUrlsByUrl$ = computed(() => {
    return Promise.resolve(new Map<string, string>());
  });
  const artifact = createArtifactSignals(descriptor, previewImageUrlsByUrl$);
  return {
    ...artifact,
    openPreview$: command(({ set }, label: string, signal: AbortSignal) => {
      set(viewer.open$, artifact, label, signal);
    }),
  };
}

declare module "hast" {
  interface Data {
    /** A snapshot preview whose navigation keeps the stable artifact reference. */
    linkedArtifact?: SharedThreadArtifactSignals;
  }
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

/** Derive the rich bodies and resource graphs of one immutable shared thread. */
export function createSharedThreadRichContentSignals(
  messages: readonly SharedMessage[],
  viewer: PublicArtifactPreviewSignals,
): SharedThreadRichContentSignals {
  const trees$ = computed(async (): Promise<ReadonlyMap<number, Root>> => {
    // Let the page shell and plain bodies render before rich parsing begins.
    await Promise.resolve();
    const diagrams = createMermaidDiagramRegistry(viewer.openDiagram$);
    const resolveImageLoad = createScopedResolver(() => {
      return createImageLoadSignals();
    });
    const resolveArtifact = createScopedResolver((url: string) => {
      const attachment = previewAttachmentFromUrl(url);
      return createSharedThreadArtifactSignals(
        { ...attachment, kind: classifyChatAttachment(attachment) },
        viewer,
      );
    });
    const trees = new Map<number, Root>();
    for (const message of messages) {
      const tree = parseMarkdownTree(message.content, {
        math: true,
        mermaid: true,
      });
      embedMermaidSignals(tree, diagrams.register);
      embedHostedSiteCards(tree);
      embedImageLoadSignals(tree, resolveImageLoad);
      visit(tree, "element", (node) => {
        // A resource this page can resolve is presented in its own dialog,
        // whether the body embeds it as an image or links to it by name.
        const source =
          node.tagName === "img"
            ? node.properties.src
            : node.tagName === "a"
              ? node.properties.href
              : undefined;
        if (typeof source === "string" && isPreviewableChatUrl(source)) {
          node.data = { ...node.data, linkedArtifact: resolveArtifact(source) };
        }
      });
      trees.set(message.messageIndex, tree);
    }
    return trees;
  });

  return { trees$ };
}
