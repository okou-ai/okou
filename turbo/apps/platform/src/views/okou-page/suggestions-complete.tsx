import { CircleCheck } from "lucide-react";
import { useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { focusSuggestionTitleOnRef$ } from "../../signals/okou-page/agent-suggestion-session.ts";

import { playSuggestionConfettiOnRef$ } from "../../signals/okou-page/suggestions-complete.ts";

export function SuggestionsComplete() {
  const { t } = useTranslation();
  const focusTitle = useSet(focusSuggestionTitleOnRef$);
  const playConfetti = useSet(playSuggestionConfettiOnRef$);
  return (
    <div className="relative flex min-h-72 flex-col items-center justify-center gap-5 overflow-hidden py-10 text-center sm:min-h-80">
      <canvas
        ref={playConfetti}
        aria-hidden
        width={1280}
        height={720}
        className="pointer-events-none absolute inset-0 size-full motion-reduce:hidden"
      />
      <CircleCheck
        aria-hidden
        strokeWidth={1.5}
        className="size-14 text-muted-foreground"
      />
      <h3
        ref={focusTitle}
        tabIndex={-1}
        className="text-xl font-medium focus:outline-none"
      >
        {t(($) => {
          return $.chat.agentSuggestions.homeCard.completeTitle;
        })}
      </h3>
    </div>
  );
}
