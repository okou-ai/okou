import { cn } from "@okouai/ui/lib/utils";

/** Descendant boundary recipes read this rail's width, not the viewport's. */
export const RAIL_ROOT_CLASS =
  "relative min-w-0 w-full [container-type:inline-size]";

/**
 * The root receives intrinsic content width (including track gutters) and
 * fractional scroll offset from JavaScript. Resolve these inputs on each
 * scroller or pager so `100cqw` measures the root, rounded like `clientWidth`.
 * Back deliberately keeps the raw `scrollLeft > 1` predicate, even without
 * overflow; only forward depends on the content's remaining width.
 */
export const RAIL_BOUNDARY_INPUTS = cn(
  "[--rail-can-back:clamp(0,sign(var(--rail-scroll-offset,0px)_-_1px),1)]",
  "[--rail-can-forward:clamp(0,sign(var(--rail-content-width,0px)_-_round(nearest,100cqw,1px)_-_var(--rail-scroll-offset,0px)_-_1px),1)]",
);

/** Pointer-returned focus keeps the fade; keyboard focus lifts both masks. */
const RAIL_FADE_OFF = cn(
  "has-[:focus-visible]:[-webkit-mask-image:none]",
  "has-[:focus-visible]:[mask-image:none]",
);

/** Four stops collapse each unavailable side to an opaque, unfaded edge. */
export const COMPOSER_RAIL_FADE = cn(
  RAIL_BOUNDARY_INPUTS,
  "[-webkit-mask-image:linear-gradient(to_right,transparent_0,#000_calc(56px_*_var(--rail-can-back,0)),#000_calc(100%_-_56px_*_var(--rail-can-forward,0)),transparent_100%)]",
  "[mask-image:linear-gradient(to_right,transparent_0,#000_calc(56px_*_var(--rail-can-back,0)),#000_calc(100%_-_56px_*_var(--rail-can-forward,0)),transparent_100%)]",
  RAIL_FADE_OFF,
);

/** The category rail's pager and gutter use a narrower, 48px dissolve. */
export const CATEGORY_RAIL_FADE = cn(
  RAIL_BOUNDARY_INPUTS,
  "[-webkit-mask-image:linear-gradient(to_right,transparent_0,#000_calc(48px_*_var(--rail-can-back,0)),#000_calc(100%_-_48px_*_var(--rail-can-forward,0)),transparent_100%)]",
  "[mask-image:linear-gradient(to_right,transparent_0,#000_calc(48px_*_var(--rail-can-back,0)),#000_calc(100%_-_48px_*_var(--rail-can-forward,0)),transparent_100%)]",
  RAIL_FADE_OFF,
);
