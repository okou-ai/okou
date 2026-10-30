import { Button, cn, DialogBody, DialogClose } from "@okouai/ui";
import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ArrowRight } from "lucide-react";
import { useHalloweenCopy } from "../../signals/halloween/halloween-content.ts";
import {
  halloweenPhase$,
  halloweenScreen$,
  startHalloween$,
} from "../../signals/halloween/halloween.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { HalloweenStage } from "./halloween-art.tsx";
import { HalloweenQuestionScreen } from "./halloween-game.tsx";
import {
  goldButton,
  HalloweenFooter,
  HalloweenHeader,
  HalloweenRules,
} from "./halloween-layout.tsx";
import { HalloweenResultScreen } from "./halloween-result.tsx";
import { halloweenTypography as typography } from "./halloween-typography.ts";

function StartScreen() {
  const copy = useHalloweenCopy();
  const phase = useGet(halloweenPhase$);
  const signal = useGet(pageSignal$);
  const [operation, start] = useLoadableSet(startHalloween$);
  const open = phase === "open";
  return (
    <main className="relative z-10 flex min-h-0 flex-1 flex-col text-center lg:items-center lg:justify-center lg:px-6 lg:py-20 lg:pb-24">
      <DialogBody className="flex flex-col px-5 py-6 lg:contents">
        <div className="my-auto shrink-0 lg:contents">
          <h1
            className={cn(
              "mb-6 max-w-[900px] text-balance text-[#f6f3ed] lg:mb-9",
              typography.titleClassName,
              "text-[28px] leading-9 lg:text-[40px] lg:leading-[48px]",
            )}
          >
            {open ? (
              <>
                {copy.title}
                <span className="mt-2 block text-[#e8c68d]">
                  {copy.subtitle}
                </span>
              </>
            ) : (
              copy.unavailable
            )}
          </h1>
          {open ? (
            <p
              className={cn("text-[#96a5b9] lg:mb-8", typography.bodyClassName)}
            >
              {copy.intro}
              <br />
              <strong
                className={cn("text-[#e8cfaa]", typography.bodyClassName)}
              >
                {copy.rewardQuestion}
              </strong>
              <br />
              {copy.hint}
            </p>
          ) : (
            <p
              className={cn(
                "mb-8 max-w-[560px] text-[#a9b8ca]",
                typography.bodyClassName,
              )}
            >
              {copy.unavailableSub}
            </p>
          )}
        </div>
      </DialogBody>
      <div className="shrink-0 border-t border-[#c0d1e512] bg-[#091426] px-5 py-4 lg:contents">
        {open ? (
          <Button
            className={cn(goldButton, "w-full min-w-[184px] lg:w-auto")}
            pending={operation.state === "loading"}
            onClick={() => {
              detach(start(signal), Reason.DomCallback);
            }}
          >
            {copy.start}
            <ArrowRight className="size-4" />
          </Button>
        ) : (
          <DialogClose
            render={<Button className={cn(goldButton, "w-full lg:w-auto")} />}
          >
            {copy.back}
            <ArrowRight className="size-4" />
          </DialogClose>
        )}
        {open && (
          <p
            className={cn(
              "mx-auto mt-3 max-w-[420px] text-[#8292a9] lg:mt-6",
              typography.labelClassName,
            )}
          >
            {copy.review}
          </p>
        )}
      </div>
      {operation.state === "hasError" && (
        <p
          role="alert"
          className={cn("mt-4 text-[#ffccde]", typography.bodyClassName)}
        >
          {copy.error}
        </p>
      )}
    </main>
  );
}

export function HalloweenPage() {
  const screen = useGet(halloweenScreen$);
  return (
    <div
      className={cn(
        "relative isolate flex min-h-0 w-full flex-1 flex-col overflow-hidden text-[#f6f3ed] antialiased lg:min-h-full",
        typography.bodyClassName,
        screen === "result"
          ? "bg-[radial-gradient(ellipse_at_50%_25%,#172c48,#091426_58%,#060d19)]"
          : "bg-[radial-gradient(ellipse_at_50%_42%,#183452_0,#0c1d34_42%,#060d19_85%)]",
      )}
    >
      {screen !== "result" && <HalloweenStage />}
      <HalloweenHeader />
      {screen === "question" ? (
        <HalloweenQuestionScreen />
      ) : screen === "result" ? (
        <HalloweenResultScreen />
      ) : (
        <StartScreen />
      )}
      {screen !== "result" && <HalloweenFooter />}
      <HalloweenRules />
    </div>
  );
}
