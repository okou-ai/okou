import type { ReactNode } from "react";
import { useSet } from "ccstate-react";
import { cn } from "@okouai/ui";
import { focusSuggestionTitleOnRef$ } from "../../signals/okou-page/agent-suggestion-session.ts";

// The card's ground, a step back from white in light mode and a step below the
// white directions at night, so the directions standing on it show their
// outline. The fades below paint the same color.
export const FOR_YOU_CARD_GROUND = "bg-muted dark:bg-background";

// Content scrolling past the meta row or into the actions fades out over the
// card's ground instead of being cut at an edge.
const META_FADE =
  "after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-3 after:bg-linear-to-b after:from-muted after:to-transparent dark:after:from-background";
const ACTIONS_FADE =
  "bg-[linear-gradient(transparent,var(--color-muted)_1.5rem)] dark:bg-[linear-gradient(transparent,var(--color-background)_1.5rem)]";

/**
 * Every For you card keeps one shape: a meta row with where the card came
 * from and its dismissal, a heading that scrolls when it runs long, the
 * actions held at the bottom, and a footer band. The scroll area spans the
 * card, so its scrollbar sits on the card's edge, and the meta row and the
 * actions stay in place as the heading scrolls under them.
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
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-8 @max-[30rem]/suggestion:px-5">
        <div
          className={cn(
            "sticky top-0 z-10 -mx-8 flex h-13 shrink-0 items-end justify-between gap-4 px-8 @max-[30rem]/suggestion:-mx-5 @max-[30rem]/suggestion:h-11 @max-[30rem]/suggestion:px-5",
            FOR_YOU_CARD_GROUND,
            META_FADE,
          )}
        >
          <div className="flex h-7 min-w-0 items-center">{source}</div>
          {dismiss && (
            <div className="-mr-1.5 flex h-7 shrink-0 items-center">
              {dismiss}
            </div>
          )}
        </div>
        <div className="mt-3 flex-1">
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
        <div
          className={cn(
            "sticky bottom-0 z-10 -mx-8 shrink-0 px-8 pt-6 @max-[30rem]/suggestion:-mx-5 @max-[30rem]/suggestion:px-5",
            ACTIONS_FADE,
          )}
        >
          {actions}
        </div>
      </div>
      <footer className="shrink-0 border-t border-border px-6 py-3 @max-[30rem]/suggestion:px-3">
        {footer}
      </footer>
    </>
  );
}
