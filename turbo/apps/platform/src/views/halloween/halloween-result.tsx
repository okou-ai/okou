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
import { goldButton } from "./halloween-layout.tsx";
import { halloweenTypography as typography } from "./halloween-typography.ts";

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
    <section className="mt-8 w-full max-w-[820px] text-left">
      <div className="mb-5 flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1.5 text-center">
        {won ? (
          <>
            <h2 className={cn("text-[#e9e8e5]", typography.label)}>
              {copy.taskTitle}
            </h2>
            <p className={cn("text-[#8e9fb6]", typography.label)}>
              {copy.taskSub}
            </p>
          </>
        ) : (
          <p className={cn("text-[#8e9fb6]", typography.label)}>
            {copy.optional}
          </p>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-3 md:gap-4">
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
              className="group relative flex items-center gap-4 rounded-2xl border border-[#b6cae21c] bg-[linear-gradient(145deg,#ffffff07,#ffffff02)] p-4 pr-9 text-left transition-all duration-200 hover:border-[#d8b77f66] hover:bg-[#ffffff07] motion-safe:hover:-translate-y-0.5 md:flex-col md:items-start md:gap-4 md:rounded-3xl md:p-5"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-[#e8c68d1a] bg-[#e8c68d08] text-[#dbbc89]">
                <Icon className="size-[18px]" />
              </span>
              <div>
                <h3
                  className={cn(
                    "mb-1.5 text-[#e4e8ef] transition-colors group-hover:text-[#e8c68d]",
                    typography.label,
                  )}
                >
                  {task.title}
                </h3>
                <p className={cn("text-[#92a3bb]", typography.body)}>
                  {task.text}
                </p>
              </div>
              <ArrowUpRight className="absolute right-4 top-4 size-3.5 text-[#71849e] transition-colors group-hover:text-[#e8c68d] md:right-5 md:top-5" />
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
        <div
          className="mb-6 flex size-14 items-center justify-center rounded-full border border-[#e8c68d33] bg-[radial-gradient(circle_at_50%_0,#e8c68d15,#e8c68d03)] text-[#e8c68d] shadow-[0_0_40px_#e8c68d08]"
          aria-hidden="true"
        >
          {won ? (
            <Sparkle className="size-6" />
          ) : (
            <RotateCcw className="size-5" />
          )}
        </div>
        <h1
          className={cn("mb-3 text-balance text-[#f4f1eb]", typography.title)}
        >
          {won ? copy.won : copy.lost}
        </h1>
        <p className={cn("text-[#95a6be]", typography.body)}>
          {won ? copy.wonSub : copy.lostSub}
        </p>
        <p
          className={cn(
            "text-[#95a6be]",
            typography.body,
            won ? "mt-5" : "mt-6",
          )}
        >
          <strong className={cn("text-[#e8c68d]", typography.body)}>
            {copy.resultRewardEmphasis}
          </strong>
          {copy.resultRewardRest}
        </p>
        <ResultTasks won={won} />
        <div className="mt-7 flex w-full max-w-[360px] flex-col items-stretch gap-3 md:w-auto md:max-w-none md:flex-row">
          <Button
            nativeButton={false}
            render={<Link pathname="/" />}
            className={goldButton}
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
              className={cn(
                "h-auto min-h-12 gap-3 rounded-xl border border-[#b4c5dc26] bg-[#ffffff03] px-7 py-3.5 text-[#b9c5d6] transition-all duration-200 hover:border-[#e8c68d66] hover:bg-[#ffffff07] hover:text-[#e8c68d]",
                typography.label,
              )}
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
        <p className={cn("mt-5 text-[#7b8da5]", typography.label)}>
          {copy.footerBefore}
          <Button
            variant="quiet"
            size="sm"
            className={cn(
              "h-auto rounded-none p-0 text-inherit underline decoration-[#7b8da560] underline-offset-4 hover:bg-transparent hover:text-[#e8c68d]",
              typography.label,
            )}
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
