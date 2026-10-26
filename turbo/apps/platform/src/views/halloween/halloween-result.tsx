import { Button, cn } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ArrowRight, ArrowUpRight, RotateCcw } from "lucide-react";
import { HALLOWEEN_COPY as copy } from "../../signals/halloween/halloween-content.ts";
import { halloweenConfetti$ } from "../../signals/halloween/halloween-motion.ts";
import {
  halloweenPhase$,
  halloweenRound$,
  prepareHalloweenReturn$,
  replayHalloween$,
  setHalloweenRulesOpen$,
} from "../../signals/halloween/halloween.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { campaignButton } from "./halloween-layout.tsx";
import { HalloweenMark, HalloweenTaskArt } from "./halloween-art.tsx";

function Confetti() {
  const motion = useSet(halloweenConfetti$);
  const colors = [
    "bg-[#FFA500]",
    "bg-[#96D82D]",
    "bg-[#B4DEF5]",
    "bg-[#F9E840]",
  ];
  return (
    <div
      ref={motion}
      className="pointer-events-none absolute inset-0 z-30 flex justify-around overflow-hidden"
      aria-hidden="true"
    >
      {Array.from({ length: 42 }, (_, index) => {
        return (
          <span
            key={index}
            className={cn(
              "h-3 w-2 shrink-0 opacity-0",
              colors[index % colors.length],
            )}
          />
        );
      })}
    </div>
  );
}

function ResultTasks({ won }: { readonly won: boolean }) {
  const prepareReturn = useSet(prepareHalloweenReturn$);
  return (
    <section className="mt-8 w-full max-w-[820px] text-left">
      <div className="mb-5 flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1.5 text-center">
        {won ? (
          <>
            <h2 className="text-lg font-medium tracking-tight text-[#e9e8e5]">
              {copy.taskTitle}
            </h2>
            <p className="text-[13px] text-[#8e9fb6]">{copy.taskSub}</p>
          </>
        ) : (
          <p className="text-[13px] leading-relaxed text-[#8e9fb6]">
            {copy.optional}
          </p>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-3 md:gap-4">
        {copy.tasks.map((task, index) => {
          return (
            <Link
              key={task.title}
              pathname="/"
              options={{
                searchParams: task.prompt
                  ? new URLSearchParams({ prompt: task.prompt })
                  : undefined,
              }}
              onClick={() => {
                prepareReturn();
              }}
              className="group relative flex items-center gap-4 rounded-2xl border border-[#FAF5F3] bg-[#FAF5F3] p-4 pr-9 text-left transition-all duration-200 hover:border-[#FFA500] hover:bg-[#fffaf3] motion-safe:hover:-translate-y-0.5 md:flex-col md:items-start md:gap-4 md:rounded-3xl md:p-5"
            >
              <HalloweenTaskArt index={index} />
              <div>
                <h3 className="mb-1.5 text-sm font-semibold tracking-[-.015em] text-[#252121]">
                  {task.title}
                </h3>
                <p className="text-xs leading-relaxed text-[#706b68]">
                  {task.text}
                </p>
              </div>
              <ArrowUpRight className="absolute right-4 top-4 size-3.5 text-[#706b68] transition-colors group-hover:text-[#b75a00] md:right-5 md:top-5" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export function HalloweenResultScreen() {
  const round = useGet(halloweenRound$);
  const phase = useGet(halloweenPhase$);
  const signal = useGet(pageSignal$);
  const [operation, replay] = useLoadableSet(replayHalloween$);
  const prepareReturn = useSet(prepareHalloweenReturn$);
  const setRules = useSet(setHalloweenRulesOpen$);
  const won = round?.outcome === "success";
  return (
    <>
      {won && <Confetti />}
      <main className="relative z-10 mx-auto flex w-[calc(100%-40px)] max-w-[880px] flex-1 flex-col items-center justify-center py-10 pb-12 text-center md:w-[calc(100%-96px)]">
        <div className="mb-5 size-12 text-[#FFA500]" aria-hidden="true">
          <HalloweenMark />
        </div>
        <h1 className="mb-3 text-balance text-[35px] font-medium leading-[1.15] tracking-[-.04em] text-[#f4f1eb] md:text-[48px]">
          {won ? copy.won : copy.lost}
        </h1>
        <p className="text-sm leading-relaxed text-[#95a6be]">
          {won ? copy.wonSub : copy.lostSub}
        </p>
        <p
          className={cn(
            "text-[15px] leading-relaxed text-[#95a6be]",
            won ? "mt-5" : "mt-6",
          )}
        >
          <strong className="font-medium text-[#FFA500]">
            {copy.resultRewardEmphasis}
          </strong>
          {copy.resultRewardRest}
        </p>
        <ResultTasks won={won} />
        <div className="mt-7 flex w-full max-w-[360px] flex-col items-stretch gap-3 md:w-auto md:max-w-none md:flex-row">
          <Button
            nativeButton={false}
            render={<Link pathname="/" />}
            className={campaignButton}
            onClick={() => {
              prepareReturn();
            }}
          >
            {copy.magic}
            <ArrowRight className="size-4" />
          </Button>
          {phase === "open" && (
            <Button
              variant="quiet"
              className="h-auto min-h-12 gap-3 rounded-xl border border-[#b4c5dc26] bg-[#ffffff03] px-7 py-3.5 text-sm font-medium text-[#b9c5d6] transition-all duration-200 hover:border-[#FFA50066] hover:bg-[#ffffff07] hover:text-[#FFA500]"
              pending={operation.state === "loading"}
              onClick={() => {
                detach(replay(signal), Reason.DomCallback);
              }}
            >
              {copy.again}
              <RotateCcw className="size-4" />
            </Button>
          )}
        </div>
        <p className="mt-5 text-[11px] leading-relaxed text-[#7b8da5]">
          {copy.footerBefore}
          <Button
            variant="quiet"
            size="sm"
            className="h-auto rounded-none p-0 text-[11px] text-inherit underline decoration-[#7b8da560] underline-offset-4 hover:bg-transparent hover:text-[#FFA500]"
            onClick={() => {
              setRules(true);
            }}
          >
            {copy.footerLink}
          </Button>
          {copy.footerAfter}
        </p>
      </main>
    </>
  );
}
