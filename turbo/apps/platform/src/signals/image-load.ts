import { command, computed, state, type Command, type Computed } from "ccstate";
import type { Element, Root } from "hast";

import { isSafeMediaUrl } from "../lib/media-url.ts";

/**
 * Load state of one presented image. The owner that prepares an image for
 * rendering — a parsed tree, a card's signals, a composer attachment — creates
 * or registers the signals and hands them to the view; the view only reports
 * the `<img>` element's load events back and renders from `status$`. There is
 * no keyed lookup anywhere.
 */
export type ImageLoadStatus = "loading" | "loaded" | "error";

export interface ImageLoadSignals {
  readonly status$: Computed<ImageLoadStatus>;
  readonly loaded$: Command<void, []>;
  readonly failed$: Command<void, []>;
}

export function createImageLoadSignals(): ImageLoadSignals {
  const internalStatus$ = state<ImageLoadStatus>("loading");
  return {
    status$: computed((get) => {
      return get(internalStatus$);
    }),
    loaded$: command(({ set }) => {
      set(internalStatus$, "loaded");
    }),
    failed$: command(({ set }) => {
      set(internalStatus$, "error");
    }),
  };
}

export interface ImageLoadRegistry {
  /** Get-or-create by source URL; idempotent per URL. */
  readonly register$: Command<ImageLoadSignals, [string]>;
}

/**
 * A per-surface registry of load signals keyed by source URL. Copies of the
 * same image share one entry, and an entry survives the re-parses of a
 * streaming message — the reused `<img>` element never refires its load event,
 * so fresh signals would strand a loaded image behind its placeholder. The map
 * is a `state` written only by `register$` and never leaves the registry: the
 * command that parses a tree embeds each entry on its node.
 */
export function createImageLoadRegistry(): ImageLoadRegistry {
  const internalByUrl$ = state<ReadonlyMap<string, ImageLoadSignals>>(
    new Map(),
  );
  const register$ = command(({ get, set }, url: string): ImageLoadSignals => {
    const current = get(internalByUrl$);
    const existing = current.get(url);
    if (existing !== undefined) {
      return existing;
    }
    const signals = createImageLoadSignals();
    const next = new Map(current);
    next.set(url, signals);
    set(internalByUrl$, next);
    return signals;
  });
  return { register$ };
}

// Written by the tree-preparing command alongside `mermaidSignals`; the parse
// pipeline itself never produces it.
declare module "hast" {
  interface Data {
    imageLoadSignals?: ImageLoadSignals;
    /** An enclosing Markdown link already owns this image's destination. */
    imageInsideLink?: boolean;
  }
}

function mediaImageUrl(node: Element): string | undefined {
  if (node.tagName === "img") {
    const src = node.properties.src;
    return typeof src === "string" && isSafeMediaUrl(src) ? src : undefined;
  }
  return undefined;
}

/**
 * Attach load signals to image nodes on surfaces without artifact signals.
 */
export function embedImageLoadSignals(
  tree: Root,
  resolve: (url: string) => ImageLoadSignals,
): void {
  const visitNode = (node: Root | Element, insideLink: boolean): void => {
    for (const child of node.children) {
      if (
        child.type !== "element" ||
        child.data?.card ||
        child.data?.hostedSite
      ) {
        continue;
      }
      const url = mediaImageUrl(child);
      if (url !== undefined) {
        child.data = {
          ...child.data,
          imageLoadSignals: resolve(url),
          imageInsideLink: insideLink,
        };
      }
      visitNode(child, insideLink || child.tagName === "a");
    }
  };
  visitNode(tree, false);
}
