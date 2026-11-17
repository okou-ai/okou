import { CircleCheck } from "lucide-react";
import { useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { cn } from "@okouai/ui";
import { focusSuggestionTitleOnRef$ } from "../../signals/okou-page/agent-suggestion-session.ts";

const COMPLETION_DOTS = [
  "size-0.75 [--completion-dot-x:-48px] [--completion-dot-y:-19px] [--completion-dot-delay:180ms]",
  "size-1 [--completion-dot-x:-29px] [--completion-dot-y:-38px] [--completion-dot-delay:192ms]",
  "size-0.75 [--completion-dot-x:-6px] [--completion-dot-y:-48px] [--completion-dot-delay:204ms]",
  "size-1 [--completion-dot-x:24px] [--completion-dot-y:-39px] [--completion-dot-delay:216ms]",
  "size-0.75 [--completion-dot-x:45px] [--completion-dot-y:-21px] [--completion-dot-delay:228ms]",
  "size-1 [--completion-dot-x:49px] [--completion-dot-y:8px] [--completion-dot-delay:240ms]",
] as const;

export function SuggestionsComplete({
  className,
  celebrate = true,
}: {
  readonly className?: string;
  readonly celebrate?: boolean;
}) {
  const { t } = useTranslation();
  const focusTitle = useSet(focusSuggestionTitleOnRef$);
  return (
    <div
      className={cn(
        "relative flex min-h-72 flex-col items-center justify-center gap-5 overflow-hidden py-10 text-center sm:min-h-80",
        className,
      )}
    >
      <span aria-hidden className="pointer-events-none relative size-14">
        <CircleCheck
          strokeWidth={1.5}
          className="size-full text-muted-foreground"
        />
        {celebrate &&
          COMPLETION_DOTS.map((dot) => {
            return (
              <span
                key={dot}
                className={cn(
                  "absolute top-1/2 left-1/2 -translate-1/2 rounded-full bg-green-700/70 opacity-0 motion-safe:animate-completion-dot dark:bg-green-300/70",
                  dot,
                )}
              />
            );
          })}
      </span>
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
