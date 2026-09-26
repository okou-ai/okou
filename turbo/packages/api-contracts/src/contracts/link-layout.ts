import { z } from "zod";

/**
 * Artifact and hosted-site links live in one of two persisted R2/URL layouts.
 * Every new publication uses `current`. `legacy` is read-only: it keeps links
 * issued before the layout change resolving (legacy host and CDN origins, the
 * unprefixed `sites/` pointer namespace, and legacy-segment R2 keys). Records
 * derived from legacy content, such as a share of a legacy publication, inherit
 * the layout of the content they address.
 *
 * The layout is not product identity. It is resolved only from stored data:
 * a row's layout column, a stored policy marker, an R2 key segment, object
 * metadata, or the host a link was issued on.
 */
export type LinkLayout = "current" | "legacy";

export const CURRENT_LINK_LAYOUT: LinkLayout = "current";

/**
 * Frozen storage segments. They appear in R2 keys (for example
 * `artifact-shares/<segment>/<id>.json`), in the layout marker of stored R2
 * policies and manifests, in object metadata, and in the `link_layout_segment`
 * column of hosted-site, artifact-share and shared-thread rows. These strings are storage
 * identifiers and must never change.
 */
const LINK_LAYOUT_SEGMENTS = {
  current: "okou",
  legacy: "vm0",
} as const satisfies Record<LinkLayout, string>;

export type LinkLayoutSegment = (typeof LINK_LAYOUT_SEGMENTS)[LinkLayout];

/** Stored layout marker as persisted in R2 policies and manifests. */
export const linkLayoutSegmentSchema = z.enum([
  LINK_LAYOUT_SEGMENTS.current,
  LINK_LAYOUT_SEGMENTS.legacy,
]);

export function linkLayoutSegment(layout: LinkLayout): LinkLayoutSegment {
  return LINK_LAYOUT_SEGMENTS[layout];
}

export function linkLayoutFromSegment(segment: string): LinkLayout {
  if (segment === LINK_LAYOUT_SEGMENTS.current) {
    return "current";
  }
  if (segment === LINK_LAYOUT_SEGMENTS.legacy) {
    return "legacy";
  }
  throw new Error(`Unknown link layout segment: ${segment}`);
}

/** Validate a stored segment, such as a row's `link_layout_segment` value. */
export function storedLinkLayoutSegment(value: string): LinkLayoutSegment {
  return linkLayoutSegment(linkLayoutFromSegment(value));
}

/**
 * Hosted-site pointers, publications and deployment pointers are addressed
 * under this namespace. The legacy namespace is the unprefixed `sites/` root.
 */
export function hostedSitePointerNamespace(layout: LinkLayout): string {
  return layout === "current" ? "sites/brands/okou" : "sites";
}
