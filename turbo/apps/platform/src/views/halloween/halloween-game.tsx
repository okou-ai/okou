import type { HalloweenRound } from "@okouai/api-contracts/contracts/halloween";
import { Button, cn } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ArrowRight, Check, Diamond } from "lucide-react";
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
    <aside className="order-first flex items-center justify-between gap-5 rounded-2xl border border-[#a9c1df1c] bg-[linear-gradient(150deg,#ffffff05,#ffffff01)] px-4 py-3 md:order-last md:rounded-3xl md:flex-col md:items-stretch md:p-5">
      <h2 className={cn("text-[#b2bfd0] md:mb-1", typography.labelClassName)}>
        {copy.climb}
      </h2>
      <ol className="hidden flex-col-reverse gap-1.5 md:flex">
        {copy.levels.map((level, index) => {
          const done = index < round.correct;
          const current = !done && index + 1 === round.questionNumber;
          return (
            <li
              key={level}
              className={cn(
                "flex h-11 items-center gap-3 rounded-lg border border-transparent px-3 text-[#8090a7]",
                current &&
                  "border-[#eed2a0] bg-[linear-gradient(120deg,#e7c793,#d5ad70)] text-[#30291e]",
                done && "border-[#e6c58e14] bg-[#e6c58e07] text-[#c9b28a]",
              )}
            >
              <span
                className={cn(
                  "min-w-[17px] tabular-nums opacity-70",
                  typography.labelClassName,
                )}
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className={typography.labelClassName}>{level}</span>
              {done && <Check className="ml-auto size-[11px] shrink-0" />}
              {current && (
                <Diamond className="ml-auto size-2 shrink-0 fill-current" />
              )}
            </li>
          );
        })}
      </ol>
      <p
        className={cn(
          "text-[#8fa0b7] md:border-t md:border-[#a9c1df14] md:pt-4",
          typography.labelClassName,
        )}
      >
        {copy.correct}{" "}
        <strong
          className={cn(
            "ml-1 tabular-nums text-[#ead0a7]",
            typography.labelClassName,
          )}
        >
          {round.correct}
        </strong>{" "}
        / 5
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
    <div className="mx-auto flex w-full max-w-[540px] flex-col gap-3">
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
                "absolute left-6 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md bg-[#ffffff06] text-[#dbc39d]",
                typography.labelClassName,
              )}
            >
              {String.fromCharCode(65 + index)}
            </span>
            <span>{option.text}</span>
            {selected && round.feedback?.correct && (
              <Check className="absolute right-6 size-4 text-[#e8c68d]" />
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
    <main
      className={cn(
        "relative z-10 mx-auto grid w-[calc(100%-40px)] max-w-[1064px] flex-1 content-center items-center gap-8 py-8 pb-12 md:w-[calc(100%-96px)] md:grid-cols-[minmax(0,1fr)_224px] md:gap-14 md:py-14",
        "gap-6 py-6 pb-8 md:py-10",
      )}
    >
      <div className="min-w-0 text-center">
        <p className={cn("mb-5 text-[#b5a07e]", typography.labelClassName)}>
          {copy.roundProgress(
            String(round.questionNumber).padStart(2, "0"),
            copy.roundTitles[round.questionNumber - 1] ?? "",
          )}
        </p>
        <h1
          key={round.question.id}
          ref={focusHeading}
          tabIndex={-1}
          className={cn(
            "mx-auto mb-9 max-w-[640px] text-balance text-[#f4f1eb] outline-none",
            typography.titleClassName,
            "mb-7 text-[32px] leading-10 md:text-[40px] md:leading-[48px]",
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
            className="mx-auto mt-6 w-full max-w-[540px] border-t border-[#a9c1df1c] pt-5"
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
                className={cn(
                  goldButton,
                  "mx-auto min-h-11 min-w-[188px] px-6 py-3",
                )}
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
