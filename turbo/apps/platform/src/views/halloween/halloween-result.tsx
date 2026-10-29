import { Button, cn, DialogClose } from "@okouai/ui";
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
import { useHalloweenCopy } from "../../signals/halloween/halloween-content.ts";
import { halloweenConfetti$ } from "../../signals/halloween/halloween-motion.ts";
import {
  halloweenPhase$,
  halloweenRound$,
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
  const copy = useHalloweenCopy();
  const icons = [Sparkle, Command, Zap];
  return (
    <section className="mt-6 w-full border-t border-[#b6cae21c] pt-6 text-left">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {won ? (
          <>
            <h2 className={cn("text-[#e9e8e5]", typography.labelClassName)}>
              {copy.taskTitle}
            </h2>
            <p className={cn("text-[#8e9fb6]", typography.labelClassName)}>
              {copy.taskSub}
            </p>
          </>
        ) : (
          <p className={cn("text-[#8e9fb6]", typography.labelClassName)}>
            {copy.optional}
          </p>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-3 md:gap-x-4">
        {copy.tasks.map((task, index) => {
          const Icon = icons[index]!;
          return (
            <DialogClose
              key={task.title}
              nativeButton={false}
              render={
                <Link
                  pathname="/"
                  options={{
                    searchParams: task.prompt
                      ? new URLSearchParams({ prompt: task.prompt })
                      : undefined,
                  }}
                  className="group relative grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 rounded-2xl border border-[#b6cae21c] bg-[linear-gradient(145deg,#ffffff07,#ffffff02)] p-4 pr-9 text-left transition-colors duration-200 hover:border-[#d8b77f66] hover:bg-[#ffffff07] md:row-span-3 md:grid-cols-1 md:grid-rows-subgrid md:gap-y-3 md:p-5"
                />
              }
            >
              <span className="row-span-2 flex size-9 shrink-0 items-center justify-center rounded-xl border border-[#e8c68d1a] bg-[#e8c68d08] text-[#dbbc89] md:row-span-1">
                <Icon className="size-[18px]" />
              </span>
              <h3
                className={cn(
                  "text-[#e4e8ef] transition-colors group-hover:text-[#e8c68d]",
                  typography.labelClassName,
                )}
              >
                {task.title}
              </h3>
              <p className="col-start-2 text-sm leading-5 text-[#92a3bb] md:col-start-auto">
                {task.text}
              </p>
              <ArrowUpRight className="absolute right-4 top-4 size-3.5 text-[#71849e] transition-colors group-hover:text-[#e8c68d] md:right-5 md:top-5" />
            </DialogClose>
          );
        })}
      </div>
    </section>
  );
}

export function HalloweenResultScreen() {
  const copy = useHalloweenCopy();
  const round = useGet(halloweenRound$);
  const phase = useGet(halloweenPhase$);
  const signal = useGet(pageSignal$);
  const [operation, replay] = useLoadableSet(replayHalloween$);
  const setRules = useSet(setHalloweenRulesOpen$);
  const won = round?.outcome === "success";
  return (
    <>
      {won && <Confetti />}
      <main className="relative z-10 mx-auto flex w-full max-w-[896px] flex-1 flex-col items-center justify-center px-5 py-6 text-center md:px-8 md:py-8">
        <div className="flex max-w-full flex-col items-center gap-3 sm:flex-row sm:gap-4 sm:text-left">
          <div
            className="flex size-12 shrink-0 items-center justify-center rounded-full border border-[#e8c68d33] bg-[radial-gradient(circle_at_50%_0,#e8c68d15,#e8c68d03)] text-[#e8c68d]"
            aria-hidden="true"
          >
            {won ? (
              <Sparkle className="size-6" />
            ) : (
              <RotateCcw className="size-5" />
            )}
          </div>
          <div className="min-w-0">
            <h1
              className={cn(
                "text-balance text-[#f4f1eb]",
                typography.titleClassName,
                "text-[32px] leading-10 md:text-[40px] md:leading-[48px]",
              )}
            >
              {won ? copy.won : copy.lost}
            </h1>
            <p className={cn("mt-1 text-[#95a6be]", typography.bodyClassName)}>
              {won ? copy.wonSub : copy.lostSub}
            </p>
          </div>
        </div>
        <p className="mt-4 max-w-full rounded-xl border border-[#e8c68d1a] bg-[#e8c68d08] px-4 py-3 text-sm leading-5 text-[#95a6be]">
          <strong className="font-medium text-[#e8c68d]">
            {copy.resultRewardEmphasis}
          </strong>
          {copy.resultRewardRest}
        </p>
        <div className="mt-5 flex w-full flex-col items-stretch justify-center gap-3 sm:w-auto sm:flex-row sm:flex-wrap">
          <DialogClose
            render={<Button className={cn(goldButton, "whitespace-normal")} />}
          >
            {copy.magic}
            <ArrowRight className="size-4" />
          </DialogClose>
          {phase === "open" && (
            <Button
              variant="quiet"
              className={cn(
                "h-auto min-h-12 gap-3 whitespace-normal rounded-xl border border-[#b4c5dc26] bg-[#ffffff03] px-7 py-3.5 text-[#b9c5d6] transition-colors duration-200 hover:border-[#e8c68d66] hover:bg-[#ffffff07] hover:text-[#e8c68d]",
                typography.labelClassName,
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
        <ResultTasks won={won} />
        <p className={cn("mt-4 text-[#7b8da5]", typography.labelClassName)}>
          {copy.footerBefore}
          <Button
            variant="quiet"
            size="sm"
            className={cn(
              "h-auto rounded-none p-0 text-inherit underline decoration-[#7b8da560] underline-offset-4 hover:bg-transparent hover:text-[#e8c68d]",
              typography.labelClassName,
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
