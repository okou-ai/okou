import type { Root } from "hast";
import { SKIP, visit } from "unist-util-visit";

import { isHostedSiteUrl } from "./chat-page/parse-body-blocks.ts";

/** A Markdown image whose destination is a hosted site, not an image file. */
export interface HostedSiteCard {
  readonly url: string;
  /** The image's Markdown label; empty when the author wrote none. */
  readonly title: string;
}

// Written by the tree-preparing caller alongside `imageLoadSignals`; the parse
// pipeline itself never produces it.
declare module "hast" {
  interface Data {
    hostedSite?: HostedSiteCard;
  }
}

/**
 * Mark the hosted sites a body embeds as Markdown images. An `<img>` cannot
 * present a site, so surfaces without artifact signals — a public conversation
 * above all — render these nodes as site cards instead of a broken image.
 */
export function embedHostedSiteCards(tree: Root): void {
  visit(tree, "element", (node) => {
    if (node.data?.card || node.tagName !== "img") {
      return undefined;
    }
    const src = node.properties.src;
    const alt = node.properties.alt;
    if (typeof src !== "string" || !isHostedSiteUrl(src)) {
      return undefined;
    }
    node.data = {
      ...node.data,
      hostedSite: { url: src, title: typeof alt === "string" ? alt : "" },
    };
    return SKIP;
  });
}
