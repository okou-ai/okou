/** Which edges of a scroller still have content under them. */
export type ScrollFade = "none" | "start" | "end" | "both";

/**
 * A scroller whose content is clipped by a hard edge reads as a mistake: half a
 * pill, or a card sliced flat. This masks the scroller on whichever edge still
 * has content under it, and on neither edge when nothing overflows — the state
 * comes from `ScrollFade` above.
 *
 * A mask rather than an overlay, because the scroller sits on a surface other
 * layers slide over: an opaque gradient strip would show its own colour against
 * whatever ends up behind it.
 */
export const SCROLL_FADE_X =
  "data-[fade=end]:[mask-image:linear-gradient(to_right,#000_calc(100%-24px),transparent)] data-[fade=start]:[mask-image:linear-gradient(to_right,transparent,#000_24px)] data-[fade=both]:[mask-image:linear-gradient(to_right,transparent,#000_24px,#000_calc(100%-24px),transparent)]";

/**
 * The bottom edge of a vertical scroller, for the reason `SCROLL_FADE_X`
 * records: content cut flat on the viewport's edge reads as a rendering fault
 * rather than as "there is more below". Unconditional, because both consumers
 * scroll from the top and only ever have content under their bottom edge.
 *
 * A mask rather than a gradient overlay. The transcript ends where the composer
 * begins, and the softening belongs to the transcript rather than the surface
 * below it: a solid gradient painted over the pane can only fade toward one
 * flat colour, and the workspace canvas is not one under a gradient palette —
 * a `--background` gradient over a `--card` canvas ended in a visible band
 * across the pane's full width. Fading the content itself leaves whatever the
 * canvas paints untouched, so every theme keeps its own backdrop.
 *
 * The transcript, the shared thread and the Get started connector picker all
 * take it from here, so the distance cannot drift between them. The prefixed
 * property is spelled beside the standard one for the same reason
 * `composer-rail.tsx` spells it.
 */
export const SCROLL_FADE_Y_END = [
  "[-webkit-mask-image:linear-gradient(to_bottom,#000_calc(100%_-_20px),transparent_100%)]",
  "[mask-image:linear-gradient(to_bottom,#000_calc(100%_-_20px),transparent_100%)]",
].join(" ");

/** Hides the native scrollbar; the fade is what states there is more to see. */
export const SCROLLBAR_HIDDEN =
  "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
