import type { HalloweenRound } from "@okouai/api-contracts/contracts/halloween";
import { Button, cn, DialogBody, useMediaQuery } from "@okouai/ui";
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
    <aside className="order-first flex shrink-0 flex-wrap items-center justify-between gap-x-5 gap-y-3 rounded-surface border border-[#a9c1df1c] bg-[#091725b3] px-4 py-2 md:order-last md:flex-col md:items-stretch md:gap-4 md:py-5">
      <h2
        className={cn(
          "hidden text-[#d5deea] md:block md:px-2",
          typography.labelClassName,
        )}
      >
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
          "flex w-full items-baseline justify-between gap-3 font-normal text-[#a7b7cc] md:border-t md:border-[#a9c1df1c] md:px-2 md:pt-4",
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
    <div className="mx-auto flex w-full max-w-[540px] flex-col gap-2.5 md:gap-3">
      {round.question?.options.map((option, index) => {
        const selected = round.feedback?.selectedId === option.id;
        return (
          <Button
            key={option.id}
            variant="quiet"
            disabled={busy || Boolean(round.feedback)}
            aria-pressed={selected}
            className={cn(
              "relative isolate h-auto min-h-14 w-full whitespace-normal rounded-none border-0 bg-[#8ba6c34d] px-16 py-3.5 text-center text-[#dce4ef] transition-all duration-200 [clip-path:polygon(16px_0,calc(100%-16px)_0,100%_50%,calc(100%-16px)_100%,16px_100%,0_50%)] before:absolute before:inset-px before:-z-10 before:bg-[linear-gradient(110deg,#10243b,#142b45_50%,#10243b)] before:[clip-path:polygon(15px_0,calc(100%-15px)_0,100%_50%,calc(100%-15px)_100%,15px_100%,0_50%)] hover:bg-[#d8b77f] hover:text-[#f3eadb] hover:before:bg-[linear-gradient(110deg,#1d3147,#263e58,#1d3147)] focus-visible:brightness-125 disabled:opacity-100",
              typography.bodyClassName,
              "min-h-12 px-12 py-3 md:min-h-14 md:px-16 md:py-3.5",
              selected &&
                round.feedback?.correct &&
                "bg-[#dfc089] text-[#f7e5c5] before:bg-[linear-gradient(110deg,#343225,#4b4130,#343225)]",
              selected &&
                !round.feedback?.correct &&
                "bg-[#b57b8f] text-[#f5dce5] before:bg-[#432b3b] before:bg-none",
            )}
            onClick={() => {
              detach(playSound(signal), Reason.DomCallback);
              onAnswer(option.id);
            }}
          >
            <span
              className={cn(
                "absolute left-4 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md bg-[#ffffff06] text-[#dbc39d] md:left-6",
                typography.labelClassName,
              )}
            >
              {String.fromCharCode(65 + index)}
            </span>
            <span>{option.text}</span>
            {selected && round.feedback?.correct && (
              <Check className="absolute right-4 size-4 text-[#e8c68d] md:right-6" />
            )}
          </Button>
        );
      })}
    </div>
  );
}

export function HalloweenQuestionScreen() {
  const isDesktop = useMediaQuery("(min-width: 768px)");
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
  const nextAction = round.feedback?.correct && (
    <Button
      className={cn(
        goldButton,
        "mx-auto min-h-12 w-full px-6 py-3 md:min-h-11 md:w-auto md:min-w-[188px]",
      )}
      pending={nextOperation.state === "loading"}
      onClick={() => {
        detach(next(signal), Reason.DomCallback);
      }}
    >
      {round.questionNumber === 5 ? copy.result : copy.next}
      <ArrowRight className="size-4" />
    </Button>
  );
  return (
    <main className="relative z-10 mx-auto flex min-h-0 w-full max-w-[1064px] flex-1 flex-col md:grid md:w-[calc(100%-96px)] md:grid-cols-[minmax(0,1fr)_224px] md:content-center md:items-center md:gap-14 md:py-10">
      <DialogBody className="flex flex-col gap-4 px-4 py-4 md:contents">
        <div className="min-w-0 shrink-0 text-center">
          <p
            className={cn(
              "mb-3 text-[#b5a07e] md:mb-5",
              typography.labelClassName,
            )}
          >
            {copy.roundProgress(
              String(round.questionNumber).padStart(2, "0"),
              copy.roundTitles[round.questionNumber - 1]!,
            )}
          </p>
          <h1
            key={round.question.id}
            ref={focusHeading}
            tabIndex={-1}
            className={cn(
              "mx-auto mb-9 max-w-[640px] text-balance text-[#f4f1eb] outline-none",
              typography.titleClassName,
              "mb-5 text-2xl leading-8 md:mb-7 md:text-[40px] md:leading-[48px]",
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
              className="mx-auto mt-4 w-full max-w-[540px] border-t border-[#a9c1df1c] pt-4 md:mt-6 md:pt-5"
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
              <p
                className={cn(
                  "text-[#9aabc1] md:mb-5",
                  typography.bodyClassName,
                )}
              >
                {round.feedback.explanation}
              </p>
              {isDesktop && nextAction}
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
      </DialogBody>
      {!isDesktop && nextAction && (
        <div className="shrink-0 border-t border-[#c0d1e512] bg-[#091426] px-4 py-3">
          {nextAction}
        </div>
      )}
    </main>
  );
}
