import type { HalloweenRound } from "@okouai/api-contracts/contracts/halloween";
import { Button, cn } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ArrowRight, Check } from "lucide-react";
import {
  useHalloweenCopy,
  useLocalizedHalloweenRound,
} from "../../signals/halloween/halloween-content.ts";
import {
  focusHalloweenHeading$,
  playHalloweenClick$,
} from "../../signals/halloween/halloween-motion.ts";
import {
  answerHalloween$,
  halloweenRound$,
  nextHalloween$,
} from "../../signals/halloween/halloween.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { goldButton } from "./halloween-layout.tsx";
import { halloweenTypography as typography } from "./halloween-typography.ts";

function Progress({ round }: { readonly round: HalloweenRound }) {
  const copy = useHalloweenCopy();
  return (
    <aside className="order-first flex flex-wrap items-center justify-between gap-x-5 gap-y-3 rounded-surface border border-[#a9c1df1c] bg-[#091725b3] px-4 py-3 md:order-last md:flex-col md:items-stretch md:gap-4 md:py-5">
      <h2 className={cn("text-[#d5deea] md:px-2", typography.labelClassName)}>
        {copy.climb}
      </h2>
      <ol className="relative isolate hidden flex-col-reverse gap-1 before:absolute before:inset-y-6 before:left-[23px] before:-z-10 before:w-px before:bg-[#a9c1df24] md:flex">
        {copy.levels.map((level, index) => {
          const done = index < round.correct;
          const current = !done && index + 1 === round.questionNumber;
          return (
            <li
              key={level}
              aria-current={current ? "step" : undefined}
              className={cn(
                "flex min-h-12 items-center gap-3 rounded-xl border border-transparent px-2 py-2 text-[#a7b7cc]",
                current && "border-[#e8c68d33] bg-[#e8c68d0a] text-[#f0d7ae]",
                done && "text-[#c4cfdc]",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  typography.labelClassName,
                  "flex size-7 shrink-0 items-center justify-center rounded-full border border-[#a9c1df33] bg-[#132238] text-xs font-normal tabular-nums text-[#a7b7cc]",
                  current &&
                    "border-[#e8c68d] bg-[#e8c68d] font-medium text-[#30291e]",
                  done && "border-[#e8c68d40] bg-[#1d2a37] text-[#dfc394]",
                )}
              >
                {done ? (
                  <Check className="size-3.5" />
                ) : (
                  String(index + 1).padStart(2, "0")
                )}
              </span>
              <span
                className={cn(
                  typography.labelClassName,
                  "min-w-0",
                  !current && "font-normal",
                )}
              >
                {level}
              </span>
            </li>
          );
        })}
      </ol>
      <p
        className={cn(
          typography.labelClassName,
          "flex items-baseline justify-between gap-3 font-normal text-[#a7b7cc] md:border-t md:border-[#a9c1df1c] md:px-2 md:pt-4",
        )}
      >
        <span>{copy.correctAnswers}</span>
        <span className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
          <strong className="text-base font-medium leading-6 text-[#f0e7d8]">
            {round.correct}
          </strong>
          <span className="text-sm text-[#a7b7cc]">/ 5</span>
        </span>
      </p>
    </aside>
  );
}

function AnswerOptions({
  round,
  busy,
  onAnswer,
}: {
  readonly round: HalloweenRound;
  readonly busy: boolean;
  readonly onAnswer: (optionId: string) => void;
}) {
  const signal = useGet(pageSignal$);
  const playSound = useSet(playHalloweenClick$);
  return (
    <div className="flex w-full flex-col gap-3">
      {round.question?.options.map((option, index) => {
        const selected = round.feedback?.selectedId === option.id;
        return (
          <Button
            key={option.id}
            variant="quiet"
            disabled={busy || Boolean(round.feedback)}
            aria-pressed={selected}
            className={cn(
              "h-auto min-h-16 w-full justify-start gap-4 whitespace-normal rounded-xl border border-[#a9c1df40] bg-[#11253b] px-4 py-4 text-left text-[#dce4ef] transition-colors duration-150 hover:border-[#e8c68d80] hover:bg-[#1b3047] hover:text-[#f4f1eb] disabled:opacity-100",
              typography.bodyClassName,
              selected &&
                round.feedback?.correct &&
                "border-[#dfc089] bg-[#343225] text-[#f7e5c5]",
              selected &&
                !round.feedback?.correct &&
                "border-[#b57b8f] bg-[#432b3b] text-[#f5dce5]",
            )}
            onClick={() => {
              detach(playSound(signal), Reason.DomCallback);
              onAnswer(option.id);
            }}
          >
            <span
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-md bg-[#ffffff06] text-[#b8c6d8]",
                typography.labelClassName,
              )}
            >
              {String.fromCharCode(65 + index)}
            </span>
            <span className="min-w-0 flex-1">{option.text}</span>
            {selected && round.feedback?.correct && (
              <Check aria-hidden className="size-4 shrink-0 text-[#e8c68d]" />
            )}
          </Button>
        );
      })}
    </div>
  );
}

export function HalloweenQuestionScreen() {
  const copy = useHalloweenCopy();
  const storedRound = useGet(halloweenRound$);
  const round = useLocalizedHalloweenRound(storedRound);
  const signal = useGet(pageSignal$);
  const [answerOperation, answer] = useLoadableSet(answerHalloween$);
  const [nextOperation, next] = useLoadableSet(nextHalloween$);
  const focusHeading = useSet(focusHalloweenHeading$);
  if (!round?.question) {
    return null;
  }
  const busy =
    answerOperation.state === "loading" || nextOperation.state === "loading";
  return (
    <main className="relative z-10 mx-auto grid w-[calc(100%-40px)] max-w-[1064px] flex-1 content-start items-start gap-6 py-8 md:w-[calc(100%-96px)] md:grid-cols-[minmax(0,1fr)_224px] md:gap-12 md:py-12">
      <div className="min-w-0 text-left md:pt-5">
        <p
          className={cn(
            typography.labelClassName,
            "mb-4 font-normal text-[#b8c6d8]",
          )}
        >
          {copy.questionProgress(round.questionNumber, 5)}
        </p>
        <h1
          key={round.question.id}
          ref={focusHeading}
          tabIndex={-1}
          className={cn(
            "mb-8 min-h-18 text-balance text-[#f4f1eb] outline-none md:min-h-20",
            typography.titleClassName,
          )}
        >
          {round.question.text}
        </h1>
        <AnswerOptions
          round={round}
          busy={busy}
          onAnswer={(id) => {
            detach(answer(id, signal), Reason.DomCallback);
          }}
        />
        {round.feedback && (
          <div
            role="status"
            className="mt-6 w-full border-t border-[#a9c1df1c] pt-5"
          >
            <p
              className={cn(
                "mb-1.5",
                typography.labelClassName,
                round.feedback.correct ? "text-[#e8c68d]" : "text-[#e8afc5]",
              )}
            >
              {round.feedback.correct ? copy.correct : copy.lost}
            </p>
            <p className={cn("mb-5 text-[#9aabc1]", typography.bodyClassName)}>
              {round.feedback.explanation}
            </p>
            {round.feedback.correct && (
              <Button
                className={cn(goldButton, "min-h-11 min-w-[188px] px-6 py-3")}
                pending={nextOperation.state === "loading"}
                onClick={() => {
                  detach(next(signal), Reason.DomCallback);
                }}
              >
                {round.questionNumber === 5 ? copy.result : copy.next}
                <ArrowRight className="size-4" />
              </Button>
            )}
          </div>
        )}
        {(answerOperation.state === "hasError" ||
          nextOperation.state === "hasError") && (
          <p
            role="alert"
            className={cn("mt-4 text-[#ffccde]", typography.bodyClassName)}
          >
            {copy.error}
          </p>
        )}
      </div>
      <Progress round={round} />
    </main>
  );
}
