import type { SharedMessage } from "@okouai/api-contracts/contracts/shared-threads";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
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
import type { SharedThreadArtifactPreviewSignals } from "./shared-thread-artifact-preview.ts";

export interface SharedThreadRichContentSignals {
  readonly trees$: Computed<Promise<ReadonlyMap<number, Root>>>;
}

export interface SharedThreadArtifactSignals extends ArtifactSignals {
  readonly openPreview$: Command<void, [label: string, signal: AbortSignal]>;
}

export function createSharedThreadArtifactSignals(
  descriptor: ArtifactDescriptor,
  viewer: SharedThreadArtifactPreviewSignals,
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
  viewer: SharedThreadArtifactPreviewSignals,
): SharedThreadRichContentSignals {
  const trees$ = computed(async (): Promise<ReadonlyMap<number, Root>> => {
    // Let the page shell and plain bodies render before rich parsing begins.
    await Promise.resolve();
    const diagrams = createMermaidDiagramRegistry();
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
        const src = node.properties.src;
        if (
          node.tagName === "img" &&
          typeof src === "string" &&
          (parseArtifactReference(src, location.origin) ||
            (isPreviewableChatUrl(src) &&
              ["html", "video"].includes(
                classifyChatAttachment(previewAttachmentFromUrl(src)),
              )))
        ) {
          node.data = { ...node.data, linkedArtifact: resolveArtifact(src) };
        }
      });
      trees.set(message.messageIndex, tree);
    }
    return trees;
  });

  return { trees$ };
}
