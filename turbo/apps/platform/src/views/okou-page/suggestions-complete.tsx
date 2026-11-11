import { useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { playSuggestionFireworksOnRef$ } from "../../signals/okou-page/suggestions-complete.ts";

/** Completion stays on home rather than keeping the review open. */
export function SuggestionsComplete() {
  const { t } = useTranslation();
  const playFireworks = useSet(playSuggestionFireworksOnRef$);
  return (
    <>
      <canvas
        ref={playFireworks}
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 size-full rounded-[inherit] motion-reduce:hidden"
      />
      <span
        data-suggestion-copy
        className="relative z-10 flex min-w-0 flex-col"
      >
        <span className="text-xs leading-4 text-muted-foreground">
          {t(($) => {
            return $.chat.agentSuggestions.label;
          })}
        </span>
        <p
          role="status"
          className="text-sm font-medium leading-5 text-foreground"
        >
          {t(($) => {
            return $.chat.agentSuggestions.homeCard.completeTitle;
          })}
        </p>
      </span>
    </>
  );
}
