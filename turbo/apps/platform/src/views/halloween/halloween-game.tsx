import type { HalloweenRound } from "@okouai/api-contracts/contracts/halloween";
import { Button, cn } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ArrowRight, Check, Diamond } from "lucide-react";
import { HALLOWEEN_COPY as copy } from "../../signals/halloween/halloween-content.ts";
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

function Progress({ round }: { readonly round: HalloweenRound }) {
  return (
    <aside className="order-first flex items-center justify-between gap-[15px] rounded-lg border border-[#8faace42] bg-[linear-gradient(160deg,#122a50bf,#07142ed9)] px-[14px] py-[10px] shadow-[0_12px_35px_#0003] md:order-last md:flex-col md:items-stretch md:py-5">
      <h2 className="text-center text-[9px] font-bold tracking-[.23em] text-[#acbbd5]">
        {copy.climb}
      </h2>
      <ol className="hidden flex-col-reverse gap-2 md:flex">
        {copy.levels.map((level, index) => {
          const done = index < round.correct;
          const current = !done && index + 1 === round.questionNumber;
          return (
            <li
              key={level}
              className={cn(
                "flex h-9 items-center gap-[10px] rounded-[3px_10px_3px_10px] border border-[#6b86b14a] bg-[#0a1734] px-[10px] text-[#6e87b1]",
                current && "border-[#e2bf7a] bg-[#183560] text-[#f5d9a1]",
                done &&
                  "border-[#ebcd94] bg-[linear-gradient(110deg,#93723b,#d9bc81)] text-[#17233b]",
              )}
            >
              <span className="min-w-[17px] text-xs font-bold">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="text-[9px] leading-tight tracking-[.08em]">
                {level}
              </span>
              {done && <Check className="ml-auto size-[11px] shrink-0" />}
              {current && (
                <Diamond className="ml-auto size-2 shrink-0 fill-current" />
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-center text-xs text-[#8fa8cf] md:border-t md:border-[#8faace25] md:pt-[5px] md:text-[10px]">
        {copy.correct}{" "}
        <strong className="text-[15px] text-[#f1d39a]">{round.correct}</strong>{" "}
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
    <div className="mx-auto flex w-fit min-w-[min(300px,100%)] max-w-full flex-col gap-[10px] md:max-w-[520px]">
      {round.question?.options.map((option, index) => {
        const selected = round.feedback?.selectedId === option.id;
        return (
          <Button
            key={option.id}
            variant="quiet"
            disabled={busy || Boolean(round.feedback)}
            aria-pressed={selected}
            className={cn(
              "relative isolate h-auto min-h-[45px] w-full whitespace-normal rounded-none border-0 bg-[#93afd1] px-12 py-3 text-center text-sm font-normal text-[#dce7ff] [clip-path:polygon(20px_0,calc(100%-20px)_0,100%_50%,calc(100%-20px)_100%,20px_100%,0_50%)] before:absolute before:inset-px before:-z-10 before:bg-[linear-gradient(100deg,#0d2046,#142c57_50%,#0d2046)] before:[clip-path:polygon(19px_0,calc(100%-19px)_0,100%_50%,calc(100%-19px)_100%,19px_100%,0_50%)] hover:-translate-y-px hover:bg-[#e6c78e] hover:text-[#dce7ff] hover:before:bg-[linear-gradient(100deg,#19315e,#25477b,#19315e)] focus-visible:brightness-125 disabled:opacity-100",
              selected &&
                round.feedback?.correct &&
                "bg-[#ffe2a5] text-[#fff8e5] before:bg-[linear-gradient(110deg,#775b25,#d1b16e,#775b25)]",
              selected &&
                !round.feedback?.correct &&
                "bg-[#c886a3] text-[#ffe7ef] before:bg-[#572841] before:bg-none",
            )}
            onClick={() => {
              detach(playSound(signal), Reason.DomCallback);
              onAnswer(option.id);
            }}
          >
            <span className="absolute left-[22px] top-1/2 -translate-y-1/2 text-xs font-bold text-[#eac382]">
              {String.fromCharCode(65 + index)}
            </span>
            <span>{option.text}</span>
          </Button>
        );
      })}
    </div>
  );
}

export function HalloweenQuestionScreen() {
  const round = useGet(halloweenRound$);
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
    <main className="relative z-10 mx-auto grid w-[calc(100%-40px)] max-w-[1080px] flex-1 content-center items-center gap-5 py-6 pb-[38px] md:w-[calc(100%-70px)] md:grid-cols-[minmax(0,1fr)_220px] md:gap-[50px]">
      <div className="min-w-0 text-center">
        <p className="mb-[13px] text-[9px] tracking-[.2em] text-[#b49a6c]">
          {copy.round} {String(round.questionNumber).padStart(2, "0")} ·{" "}
          {copy.roundTitles[round.questionNumber - 1]}
        </p>
        <h1
          key={round.question.id}
          ref={focusHeading}
          tabIndex={-1}
          className="mx-auto mb-6 w-fit max-w-[680px] border-y border-[#abc4ed38] bg-[linear-gradient(90deg,transparent,#0b1b3d8c,transparent)] px-[6px] py-4 text-[25px] font-bold leading-[1.3] tracking-tight text-[#f1f5ff] outline-none md:px-[25px] md:text-[32px]"
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
            className="mx-auto mt-[18px] w-full max-w-[580px] border-t border-[#a2b9df26] pt-[14px]"
          >
            <p
              className={cn(
                "mb-1 text-sm font-semibold",
                round.feedback.correct ? "text-[#e5ca91]" : "text-[#ffccde]",
              )}
            >
              {round.feedback.correct ? copy.correct : copy.lost}
            </p>
            <p className="mb-3 text-xs leading-relaxed text-[#9eb5d9]">
              {round.feedback.explanation}
            </p>
            {round.feedback.correct && (
              <Button
                className={cn(
                  goldButton,
                  "mx-auto min-h-10 min-w-[180px] px-[42px] py-[11px] text-[13.5px]",
                )}
                pending={nextOperation.state === "loading"}
                onClick={() => {
                  detach(next(signal), Reason.DomCallback);
                }}
              >
                {round.questionNumber === 5 ? copy.result : copy.next}
                <ArrowRight className="absolute right-[14px] size-4" />
              </Button>
            )}
          </div>
        )}
        {(answerOperation.state === "hasError" ||
          nextOperation.state === "hasError") && (
          <p role="alert" className="mt-4 text-sm text-[#ffccde]">
            {copy.error}
          </p>
        )}
      </div>
      <Progress round={round} />
    </main>
  );
}
