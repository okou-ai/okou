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

/** Hides the native scrollbar; the fade is what states there is more to see. */
export const SCROLLBAR_HIDDEN =
  "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
