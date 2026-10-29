import { Button, buttonVariants, cn, DialogClose } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ArrowUpRight, Command, Sparkle, Zap } from "lucide-react";
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
    <section className="min-w-0">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm leading-5">
        {won ? (
          <>
            <h2 className="font-medium text-[#e9e8e5]">{copy.taskTitle}</h2>
            <p className="text-[#8e9fb6]">{copy.taskSub}</p>
          </>
        ) : (
          <p className="text-[#8e9fb6]">{copy.lostTaskTitle}</p>
        )}
      </div>
      <div className="grid gap-3">
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
                  className="group grid min-h-[84px] min-w-0 grid-cols-[2.25rem_minmax(0,1fr)_1rem] items-center gap-4 rounded-2xl border border-[#b6cae21c] bg-[#ffffff03] px-5 py-4 text-left transition-colors duration-200 hover:border-[#d8b77f66] hover:bg-[#ffffff07]"
                />
              }
            >
              <span className="flex size-9 items-center justify-center rounded-xl border border-[#e8c68d1a] bg-[#e8c68d08] text-[#dbbc89]">
                <Icon className="size-[18px]" />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-medium leading-5 text-[#e4e8ef] transition-colors group-hover:text-[#e8c68d]">
                  {task.title}
                </h3>
                <p className="mt-1 text-sm leading-5 text-[#92a3bb]">
                  {task.text}
                </p>
              </div>
              <ArrowUpRight className="size-4 text-[#71849e] transition-colors group-hover:text-[#e8c68d]" />
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
      <main className="relative z-10 flex w-full flex-1 flex-col">
        <div className="grid flex-1 gap-10 px-6 py-8 md:grid-cols-[minmax(0,.9fr)_minmax(0,1.1fr)] md:items-start md:gap-12 md:px-10 md:py-12">
          <section className="min-w-0">
            <h1
              className={cn(
                "text-balance text-[#f4f1eb]",
                typography.titleClassName,
                "text-[32px] leading-10 md:text-[40px] md:leading-[48px]",
              )}
            >
              {won ? copy.won : copy.lost}
            </h1>
            <p className={cn("mt-2 text-[#95a6be]", typography.bodyClassName)}>
              {won ? copy.wonSub : copy.lostSub}
            </p>
            <p className="mt-6 text-sm leading-6 text-[#95a6be]">
              <strong className="font-medium text-[#e8c68d]">
                {won ? copy.resultRewardEmphasis : copy.lostRewardEmphasis}
              </strong>
              <br />
              {won ? copy.resultRewardRest : copy.lostRewardRest}
            </p>
            <div className="mt-7 flex flex-wrap items-stretch gap-3">
              {won && (
                <a
                  href="mailto:contact@okou.ai?subject=Halloween%20reward%20redemption"
                  className={cn(
                    buttonVariants({ size: "lg" }),
                    goldButton,
                    "h-10 min-h-10 whitespace-normal px-5 py-2",
                  )}
                >
                  {copy.redeem}
                </a>
              )}
              {phase === "open" && (
                <Button
                  variant={won ? "quiet" : "default"}
                  size="lg"
                  className={cn(
                    won
                      ? "rounded-xl border border-[#b4c5dc26] bg-[#ffffff03] text-[#b9c5d6] transition-colors duration-200 hover:border-[#e8c68d66] hover:bg-[#ffffff07] hover:text-[#e8c68d]"
                      : goldButton,
                    typography.labelClassName,
                    "h-auto min-h-10 whitespace-normal px-5 py-2",
                  )}
                  pending={operation.state === "loading"}
                  onClick={() => {
                    detach(replay(signal), Reason.DomCallback);
                  }}
                >
                  {copy.again}
                </Button>
              )}
            </div>
          </section>
          <ResultTasks won={won} />
        </div>
        <p className="border-t border-[#c0d1e512] px-6 py-5 text-center text-sm leading-5 text-[#7b8da5] md:px-10">
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
