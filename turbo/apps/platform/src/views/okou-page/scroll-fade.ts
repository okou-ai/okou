/**
 * A scroller whose content is clipped by a hard edge reads as a mistake: half a
 * pill, or a card sliced flat. These mask the scroller on whichever edge still
 * has content under it, and on neither edge when nothing overflows — the state
 * comes from `ScrollFade` in the picker's signals.
 *
 * A mask rather than an overlay, because both scrollers sit on surfaces the
 * options layer slides over: an opaque gradient strip would show its own colour
 * against whatever ends up behind it.
 */
export const SCROLL_FADE_X =
  "data-[fade=end]:[mask-image:linear-gradient(to_right,#000_calc(100%-24px),transparent)] data-[fade=start]:[mask-image:linear-gradient(to_right,transparent,#000_24px)] data-[fade=both]:[mask-image:linear-gradient(to_right,transparent,#000_24px,#000_calc(100%-24px),transparent)]";

export const SCROLL_FADE_Y =
  "data-[fade=end]:[mask-image:linear-gradient(to_bottom,#000_calc(100%-28px),transparent)] data-[fade=start]:[mask-image:linear-gradient(to_bottom,transparent,#000_28px)] data-[fade=both]:[mask-image:linear-gradient(to_bottom,transparent,#000_28px,#000_calc(100%-28px),transparent)]";

/** Hides the native scrollbar; the fade is what states there is more to see. */
export const SCROLLBAR_HIDDEN =
  "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
