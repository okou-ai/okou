/**
 * A horizontal scroller whose content is clipped by a hard edge reads as a
 * mistake: half a pill, cut flat against nothing. This masks the scroller on
 * whichever side still holds content, and on neither when nothing overflows —
 * the state comes from `ScrollFade` in the picker's signals.
 *
 * A fade belongs to an edge that has nothing else terminating it. A rule, a
 * border or the surface's own edge already ends the content, and fading there
 * dims content for no reason; `docs/styles.md` states the rule. A vertical
 * scroller under a rule-less header takes the 24px `from-card` wash the
 * workflow tab draws instead, because the surface behind it is known.
 */
export const SCROLL_FADE_X =
  "data-[fade=end]:[mask-image:linear-gradient(to_right,#000_calc(100%-24px),transparent)] data-[fade=start]:[mask-image:linear-gradient(to_right,transparent,#000_24px)] data-[fade=both]:[mask-image:linear-gradient(to_right,transparent,#000_24px,#000_calc(100%-24px),transparent)]";

/** Hides the native scrollbar; the fade is what states there is more to see. */
export const SCROLLBAR_HIDDEN =
  "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
