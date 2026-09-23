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

/**
 * The same fade, drawn only while the scroller really does have more below.
 *
 * `SCROLL_FADE_Y_END` is unconditional because its first consumers always
 * overflow. A list that can be filtered does not: once the Get started
 * connector search narrows the catalog to one row, an unconditional mask fades
 * the bottom of the only row on screen and states an overflow that is not
 * there -- the same lie as a hard cut, told the other way round.
 *
 * Base UI's `ScrollArea.Root` already publishes the answer as
 * `data-overflow-y-end`, so this reads it off the ancestor instead of measuring
 * the box a second time. The root has to carry `group` for the variant to see
 * it.
 *
 * The 20px is spelled a second time because Tailwind scans for literal class
 * names and cannot read it out of the constant above. The two are one
 * decision; change them together.
 */
export const SCROLL_FADE_Y_END_WHEN_OVERFLOWING = [
  "group-data-[overflow-y-end]:[-webkit-mask-image:linear-gradient(to_bottom,#000_calc(100%_-_20px),transparent_100%)]",
  "group-data-[overflow-y-end]:[mask-image:linear-gradient(to_bottom,#000_calc(100%_-_20px),transparent_100%)]",
].join(" ");

/**
 * The same fade at the *top* edge, for a scroller whose first row can be cut in
 * half once it has been scrolled.
 *
 * The bottom edge of a list has a second way to say "there is more": whatever
 * the list sits above -- a rule, a footer -- already draws the boundary, so the
 * mask there is a choice. The top edge has none: a row sliced flat against
 * nothing is the rendering fault `SCROLL_FADE_X` describes, and it is the only
 * thing between the list and the words that introduce it.
 *
 * Conditional on `data-overflow-y-start` for the reason the end fade is
 * conditional on its own attribute: at rest the first row starts exactly at the
 * edge, and fading it there would state a hidden row that does not exist. The
 * 20px matches the end fade, and is spelled literally because Tailwind scans
 * for class names rather than resolving constants.
 */
export const SCROLL_FADE_Y_START_WHEN_OVERFLOWING = [
  "group-data-[overflow-y-start]:[-webkit-mask-image:linear-gradient(to_bottom,transparent_0,#000_20px)]",
  "group-data-[overflow-y-start]:[mask-image:linear-gradient(to_bottom,transparent_0,#000_20px)]",
].join(" ");

/** Hides the native scrollbar; the fade is what states there is more to see. */
export const SCROLLBAR_HIDDEN =
  "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
