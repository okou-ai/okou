import type { ReactNode } from "react";
import { useSet } from "ccstate-react";
import { cn } from "@okouai/ui";
import { focusSuggestionTitleOnRef$ } from "../../signals/okou-page/agent-suggestion-session.ts";

// The card's ground, a step back from white in light mode and a step below the
// white directions at night, so the directions standing on it show their
// outline. The fades below paint the same color.
export const FOR_YOU_CARD_GROUND = "bg-muted dark:bg-background";

// The heading scrolls on its own between the meta row and the actions, which
// stay put, so a long reason never moves the controls. Its ends fade into the
// card's ground only while more lies beyond them: each fade runs on the
// heading's own scroll, over its first and last stretch, and a heading that
// fits has no scroll to run on, so neither shows.
const HEADING_SCROLL = "[scroll-timeline:--for-you-heading_y]";
// When the card scrolls as one, its foot fades the same way above the
// feedback, which stands on the card's ground without a rule.
const CARD_SCROLL = "[scroll-timeline:--for-you-card_y]";
const CARD_FOOT_FADE = cn(
  "[timeline-scope:--for-you-card]",
  "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:z-20 after:h-6 after:bg-linear-to-t after:from-muted after:to-transparent after:opacity-0 dark:after:from-background",
  "after:animate-for-you-edge-below after:[animation-timeline:--for-you-card] after:[animation-range:calc(100%-1.5rem)_100%]",
);
const EDGE_FADES = cn(
  "[timeline-scope:--for-you-heading]",
  "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-10 before:h-4 before:bg-linear-to-b before:from-muted before:to-transparent before:opacity-0 dark:before:from-background",
  "before:animate-for-you-edge-above before:[animation-timeline:--for-you-heading] before:[animation-range:0_1rem]",
  "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:z-10 after:h-6 after:bg-linear-to-t after:from-muted after:to-transparent after:opacity-0 dark:after:from-background",
  "after:animate-for-you-edge-below after:[animation-timeline:--for-you-heading] after:[animation-range:calc(100%-1.5rem)_100%]",
);

/**
 * Every For you card keeps one shape: a meta row with where the card came
 * from and its dismissal, a heading that scrolls in place when it runs long,
 * the actions held at the bottom, and the feedback below them. The heading's
 * scrollbar runs along the card's edge, between the meta row and the actions.
 * When the actions leave the heading less than its least room, as with a long
 * direction on a short window, the card scrolls as one instead.
 */
export function ForYouCardLayout({
  id,
  title,
  description,
  source,
  dismiss,
  details,
  actions,
  footer,
  active,
}: {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly source: ReactNode;
  readonly dismiss?: ReactNode;
  readonly details?: ReactNode;
  readonly actions?: ReactNode;
  readonly footer: ReactNode;
  readonly active: boolean;
}) {
  const focusTitle = useSet(focusSuggestionTitleOnRef$);
  return (
    <>
      <div
        className={cn("relative flex min-h-0 flex-1 flex-col", CARD_FOOT_FADE)}
      >
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain",
            CARD_SCROLL,
          )}
        >
          <div className="flex h-13 shrink-0 items-end justify-between gap-4 px-8 @max-[30rem]/suggestion:h-11 @max-[30rem]/suggestion:px-5">
            <div className="flex h-7 min-w-0 items-center">{source}</div>
            {dismiss && (
              <div className="-mr-1.5 flex h-7 shrink-0 items-center">
                {dismiss}
              </div>
            )}
          </div>
          <div
            className={cn("relative flex min-h-24 flex-1 flex-col", EDGE_FADES)}
          >
            <div
              data-slot="for-you-card-heading"
              className={cn(
                "min-h-0 flex-1 overflow-y-auto overscroll-contain px-8 pt-3 pb-6 [scrollbar-width:thin] @max-[30rem]/suggestion:px-5",
                HEADING_SCROLL,
              )}
            >
              <h3
                id={`suggestion-title-${id}`}
                ref={active ? focusTitle : undefined}
                tabIndex={-1}
                className="text-xl leading-7 font-semibold tracking-[-0.012em] text-pretty text-foreground wrap-break-word focus:outline-none"
              >
                {title}
              </h3>
              {description && (
                <p className="mt-2 text-sm leading-[1.375rem] text-pretty text-muted-foreground wrap-break-word">
                  {description}
                </p>
              )}
              {details}
            </div>
          </div>
          {actions && (
            <div className="shrink-0 px-8 pb-1 @max-[30rem]/suggestion:px-5">
              {actions}
            </div>
          )}
        </div>
      </div>
      {/* Spacing alone sets the feedback apart from the actions: 8px between
          directions, 16px from the last one to the feedback. */}
      <footer className="shrink-0 px-6 pt-3 pb-3 @max-[30rem]/suggestion:px-3">
        {footer}
      </footer>
    </>
  );
}
