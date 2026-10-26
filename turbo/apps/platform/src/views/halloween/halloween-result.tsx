import { Button, cn } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  ArrowRight,
  ArrowUpRight,
  Command,
  RotateCcw,
  Sparkle,
  Zap,
} from "lucide-react";
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

function Confetti() {
  const motion = useSet(halloweenConfetti$);
  const colors = [
    "bg-[#ffb640]",
    "bg-[#a9f2d0]",
    "bg-[#dba5ff]",
    "bg-[#ffedb0]",
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
  const icons = [Sparkle, Command, Zap];
  return (
    <section className="mt-[22px] w-full max-w-[800px] text-left">
      <div className="mb-5 flex flex-wrap items-baseline justify-center gap-x-[10px] gap-y-[6px] text-center">
        {won ? (
          <>
            <h2 className="text-xl font-bold text-[#fff0d4]">
              {copy.taskTitle}
            </h2>
            <p className="text-xs text-[#acbfd8]">{copy.taskSub}</p>
          </>
        ) : (
          <p className="text-xs leading-relaxed text-[#acbfd8]">
            {copy.optional}
          </p>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {copy.tasks.map((task, index) => {
          const Icon = icons[index]!;
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
              className="flex items-start gap-3 rounded-[14px] border border-[#ffffff23] bg-[#ffffff06] p-[14px] text-left transition-all hover:-translate-y-px hover:border-[#eac58a] hover:bg-[#ffffff12] md:flex-col md:px-4 md:py-5"
            >
              <Icon className="size-6 shrink-0 text-[#ffd280]" />
              <div>
                <h3 className="mb-1 flex items-center gap-1 text-[13px] font-semibold text-[#ffe0a0]">
                  {task.title}
                  <ArrowUpRight className="size-3 shrink-0" />
                </h3>
                <p className="text-[11px] leading-relaxed text-[#acbfd8]">
                  {task.text}
                </p>
              </div>
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
      <main className="relative z-10 mx-auto flex w-[calc(100%-36px)] max-w-[880px] flex-1 flex-col items-center justify-center py-[55px] pb-[45px] text-center md:w-[calc(100%-88px)]">
        <h1 className="mb-3 text-[34px] font-extrabold leading-[1.15] tracking-[-.035em] text-[#f0d29a] md:text-[46px]">
          {won ? copy.won : copy.lost}
        </h1>
        <p className="text-[15px] leading-[1.7] text-[#b3c6e7]">
          {won ? copy.wonSub : copy.lostSub}
        </p>
        <p
          className={cn(
            "text-[17px] leading-relaxed text-[#b3c6e7]",
            won ? "mt-5" : "mb-2 mt-8",
          )}
        >
          <strong className="text-[#ffd280]">
            {copy.resultRewardEmphasis}
          </strong>
          {copy.resultRewardRest}
        </p>
        <ResultTasks won={won} />
        <div className="mt-6 flex w-full max-w-[360px] flex-col items-stretch gap-3 md:w-auto md:max-w-none md:flex-row">
          <Button
            nativeButton={false}
            render={<Link pathname="/" />}
            className="h-auto min-h-[50px] gap-2 rounded-xl bg-[#f6a21b] px-[26px] py-[15px] text-[15px] font-semibold text-white shadow-[0_8px_20px_#f6a21b42] hover:-translate-y-px hover:bg-[#f79e0e] hover:shadow-[0_12px_26px_#f6a21b52]"
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
              className="h-auto min-h-[50px] gap-2 rounded-xl border border-[#ffffff30] bg-[#ffffff06] px-[26px] py-[15px] text-[15px] font-semibold text-[#d9e5ff] hover:border-[#eac58a] hover:bg-[#ffffff12] hover:text-[#d9e5ff]"
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
        <p className="mt-[14px] text-xs text-[#7d94ba]">
          {copy.footerBefore}
          <Button
            variant="quiet"
            size="sm"
            className="h-auto rounded-none p-0 text-xs text-inherit underline underline-offset-[3px] hover:bg-transparent hover:text-[#edc987]"
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
