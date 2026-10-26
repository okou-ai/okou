import type { HalloweenRound } from "@okouai/api-contracts/contracts/halloween";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  cn,
} from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Ghost,
  Image,
  Plug,
  RotateCcw,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { HALLOWEEN_COPY as copy } from "../../signals/halloween/halloween-content.ts";
import {
  focusHalloweenHeading$,
  playHalloweenClick$,
} from "../../signals/halloween/halloween-motion.ts";
import {
  answerHalloween$,
  halloweenPhase$,
  halloweenRound$,
  halloweenRulesOpen$,
  halloweenScreen$,
  halloweenSound$,
  leaveHalloween$,
  nextHalloween$,
  prepareHalloweenReturn$,
  replayHalloween$,
  setHalloweenRulesOpen$,
  startHalloween$,
  toggleHalloweenSound$,
} from "../../signals/halloween/halloween.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { ChatCard } from "../okou-page/components/chat-card.tsx";
import { Link } from "../router/link.tsx";

export function HalloweenGhost({ sad = false }: { readonly sad?: boolean }) {
  return (
    <svg viewBox="0 0 120 130" className="h-full w-full" aria-hidden="true">
      <ellipse
        cx="60"
        cy="121"
        rx="28"
        ry="5"
        fill="currentColor"
        opacity=".08"
      />
      <path
        d="M22 60c0-25 16-44 38-44s38 19 38 44v54l-10-8-9 9-9-9-10 9-9-9-9 9-10-8z"
        fill="hsl(var(--card))"
        stroke="hsl(var(--border))"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <ellipse cx="47" cy="58" rx="5.5" ry="7.5" fill="currentColor" />
      <ellipse cx="73" cy="58" rx="5.5" ry="7.5" fill="currentColor" />
      <ellipse
        cx="35"
        cy="74"
        rx="6"
        ry="3.6"
        fill="hsl(var(--primary))"
        opacity=".3"
      />
      <ellipse
        cx="85"
        cy="74"
        rx="6"
        ry="3.6"
        fill="hsl(var(--primary))"
        opacity=".3"
      />
      {sad ? (
        <path
          d="M52 84q8-7 16 0"
          stroke="currentColor"
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M53 79q7 8 14 0"
          stroke="currentColor"
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function HalloweenRules() {
  const open = useGet(halloweenRulesOpen$);
  const setOpen = useSet(setHalloweenRulesOpen$);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent maxWidth="xl">
        <DialogHeader>
          <DialogTitle>{copy.rules}</DialogTitle>
          <DialogDescription>
            {copy.reward} {copy.review}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6 py-3">
          {copy.ruleSections.map((section) => {
            return (
              <section key={section.title} className="space-y-2">
                <h3 className="font-semibold">{section.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {section.text}
                </p>
              </section>
            );
          })}
        </div>
        <Button
          onClick={() => {
            return setOpen(false);
          }}
        >
          {copy.backToGame}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function HalloweenHeader() {
  const sound = useGet(halloweenSound$);
  const toggle = useSet(toggleHalloweenSound$);
  const setRules = useSet(setHalloweenRulesOpen$);
  const playSound = useSet(playHalloweenClick$);
  const signal = useGet(pageSignal$);
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 px-5 py-5 sm:px-10">
      <Link
        pathname="/"
        className="rounded-lg transition-opacity hover:opacity-70"
      >
        <ProductBrandMark />
      </Link>
      <div className="flex items-center gap-1 sm:gap-3">
        <Button
          variant="quiet"
          size="sm"
          onClick={() => {
            return setRules(true);
          }}
        >
          {copy.rules}
        </Button>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => {
            toggle();
            detach(playSound(signal), Reason.DomCallback);
          }}
          aria-pressed={sound}
          aria-label={sound ? copy.soundOn : copy.soundOff}
        >
          {sound ? <Volume2 /> : <VolumeX />}
          <span className="hidden sm:inline">
            {sound ? copy.soundOn : copy.soundOff}
          </span>
        </Button>
      </div>
    </header>
  );
}

function StartScreen() {
  const phase = useGet(halloweenPhase$);
  const signal = useGet(pageSignal$);
  const [operation, start] = useLoadableSet(startHalloween$);
  const open = phase === "open";
  const title = open
    ? copy.title
    : phase === "ended"
      ? copy.ended
      : phase === "unavailable"
        ? copy.unavailable
        : copy.upcoming;
  const subtitle =
    phase === "ended"
      ? copy.endedSub
      : phase === "unavailable"
        ? copy.unavailableSub
        : copy.upcomingSub;
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 py-12 text-center sm:py-16">
      <div className="relative mb-6 h-36 w-36 sm:h-44 sm:w-44">
        <span className="absolute inset-0 rounded-full bg-primary/10" />
        <span className="absolute -right-4 top-0 rotate-12 text-brand-text">
          <Sparkles className="h-9 w-9" />
        </span>
        <div className="relative h-full w-full p-4">
          <HalloweenGhost sad={phase === "ended"} />
        </div>
      </div>
      <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-6xl">
        {title}
      </h1>
      {open ? (
        <>
          <p className="mt-3 text-2xl font-medium tracking-tight text-muted-foreground sm:text-4xl">
            {copy.subtitle}
          </p>
          <p className="mt-8 text-lg font-medium">{copy.reward}</p>
          <p className="mt-1 text-sm text-muted-foreground">{copy.review}</p>
          <p className="mt-7 text-sm text-muted-foreground">{copy.hint}</p>
          <Button
            size="lg"
            pending={operation.state === "loading"}
            onClick={() => {
              return detach(start(signal), Reason.DomCallback);
            }}
            className="relative mt-7 w-full max-w-xs bg-foreground text-background hover:bg-foreground/90"
          >
            <span>{copy.start}</span>
            <ArrowRight className="absolute right-5" />
          </Button>
          {operation.state === "hasError" && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {copy.error}
            </p>
          )}
        </>
      ) : (
        <p className="mt-5 max-w-lg text-base leading-relaxed text-muted-foreground">
          {subtitle}
        </p>
      )}
      <Link
        pathname="/"
        className="mt-5 rounded-lg px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
      >
        {copy.back}
        <span aria-hidden="true"> →</span>
      </Link>
    </main>
  );
}

function Progress({ correct }: { readonly correct: number }) {
  return (
    <ol
      aria-label={copy.correct}
      className="flex w-full justify-between gap-2 lg:w-44 lg:flex-col lg:gap-6"
    >
      {copy.levels.map((level, i) => {
        return (
          <li
            key={level}
            className={cn(
              "flex items-center gap-3",
              i < correct ? "text-brand-text" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                i < correct
                  ? "border-primary/30 bg-primary/10"
                  : "border-border bg-card",
              )}
            >
              {i < correct ? <Check className="h-4 w-4" /> : i + 1}
            </span>
            <span className="hidden text-xs font-semibold leading-relaxed lg:inline">
              {level}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function AnswerOptions({
  round,
  busy,
  onAnswer,
}: {
  round: HalloweenRound;
  busy: boolean;
  onAnswer: (optionId: string) => void;
}) {
  const signal = useGet(pageSignal$);
  const playSound = useSet(playHalloweenClick$);
  if (!round.question) {
    return null;
  }
  return (
    <div className="space-y-3">
      {round.question.options.map((option, i) => {
        const selected = round.feedback?.selectedId === option.id;
        return (
          <Button
            key={option.id}
            variant="neutral"
            disabled={busy || round.feedback !== null}
            onClick={() => {
              detach(playSound(signal), Reason.DomCallback);
              onAnswer(option.id);
            }}
            className={cn(
              "h-auto min-h-14 w-full justify-start gap-4 whitespace-normal rounded-xl px-4 py-4 text-left",
              selected &&
                (round.feedback?.correct
                  ? "border-primary bg-primary/10 text-foreground disabled:opacity-100"
                  : "border-destructive bg-destructive/10 text-destructive disabled:opacity-100"),
            )}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-current/15 text-xs">
              {selected ? (
                round.feedback?.correct ? (
                  <Check />
                ) : (
                  <X />
                )
              ) : (
                String.fromCharCode(65 + i)
              )}
            </span>
            <span className="min-w-0 flex-1">{option.text}</span>
          </Button>
        );
      })}
    </div>
  );
}

function QuestionScreen() {
  const round = useGet(halloweenRound$);
  const signal = useGet(pageSignal$);
  const [answerOperation, answer] = useLoadableSet(answerHalloween$);
  const [nextOperation, next] = useLoadableSet(nextHalloween$);
  const [leaveOperation, leave] = useLoadableSet(leaveHalloween$);
  const focusHeading = useSet(focusHalloweenHeading$);
  if (!round?.question) {
    return null;
  }
  const busy =
    answerOperation.state === "loading" ||
    nextOperation.state === "loading" ||
    leaveOperation.state === "loading";
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center gap-7 px-5 py-6 sm:px-8 sm:py-12">
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>
          {copy.question} {round.questionNumber} {copy.of} 5
        </span>
        <span>
          {copy.correct} {round.correct}/5
        </span>
      </div>
      <div className="lg:hidden">
        <Progress correct={round.correct} />
      </div>
      <div className="grid items-center gap-12 lg:grid-cols-[1fr_180px]">
        <ChatCard className="p-6 sm:p-10">
          <div className="mb-6 flex items-center gap-3 text-xs font-semibold text-brand-text">
            <Ghost className="h-5 w-5" />
            <span>
              {copy.round} {String(round.questionNumber).padStart(2, "0")} ·{" "}
              {copy.roundTitles[round.questionNumber - 1]}
            </span>
          </div>
          <h1
            key={round.question.id}
            ref={focusHeading}
            className="mb-8 text-2xl font-semibold leading-snug tracking-tight sm:text-3xl"
            tabIndex={-1}
          >
            {round.question.text}
          </h1>
          <AnswerOptions
            round={round}
            busy={busy}
            onAnswer={(optionId) => {
              detach(answer(optionId, signal), Reason.DomCallback);
            }}
          />
          {round.feedback && (
            <div
              role="status"
              className="mt-6 rounded-xl bg-muted/50 p-4 text-sm leading-relaxed"
            >
              <p
                className={cn(
                  "mb-1 font-semibold",
                  !round.feedback.correct && "text-destructive",
                )}
              >
                {round.feedback.correct ? copy.correct : copy.lost}
              </p>
              <p className="text-muted-foreground">
                {round.feedback.explanation}
              </p>
            </div>
          )}
          {round.feedback?.correct && (
            <Button
              size="lg"
              pending={nextOperation.state === "loading"}
              onClick={() => {
                return detach(next(signal), Reason.DomCallback);
              }}
              className="relative mt-5 w-full bg-foreground text-background hover:bg-foreground/90"
            >
              {round.questionNumber === 5 ? copy.result : copy.next}
              <ArrowRight className="absolute right-4" />
            </Button>
          )}
          {(answerOperation.state === "hasError" ||
            nextOperation.state === "hasError") && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {copy.error}
            </p>
          )}
        </ChatCard>
        <aside className="hidden lg:block">
          <Progress correct={round.correct} />
        </aside>
      </div>
      <Button
        variant="quiet"
        size="sm"
        pending={leaveOperation.state === "loading"}
        onClick={() => {
          return detach(leave(signal), Reason.DomCallback);
        }}
        className="self-start"
      >
        {copy.leave}
      </Button>
    </main>
  );
}

function ResultScreen() {
  const round = useGet(halloweenRound$);
  const phase = useGet(halloweenPhase$);
  const signal = useGet(pageSignal$);
  const [operation, replay] = useLoadableSet(replayHalloween$);
  const prepareReturn = useSet(prepareHalloweenReturn$);
  const setRules = useSet(setHalloweenRulesOpen$);
  const won = round?.outcome === "success";
  const icons = [Image, Plug, Sparkles];
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center px-5 py-10 text-center">
      <div className="mb-4 h-28 w-28">
        <HalloweenGhost sad={!won} />
      </div>
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
        {won ? copy.won : copy.lost}
      </h1>
      <p className="mt-3 text-lg text-muted-foreground">
        {won ? copy.wonSub : copy.lostSub}
      </p>
      <div className="mt-6 rounded-full border border-primary/20 bg-primary/10 px-5 py-3 text-sm">
        {copy.resultReward}
      </div>
      <div className="mt-10 w-full text-left">
        {won ? (
          <p className="mb-4 font-semibold">
            {copy.taskTitle}{" "}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {copy.taskSub}
            </span>
          </p>
        ) : (
          <p className="mb-4 text-sm text-muted-foreground">{copy.optional}</p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          {copy.tasks.map((task, i) => {
            const Icon = icons[i]!;
            return (
              <Link
                key={task.title}
                pathname="/"
                options={{
                  searchParams: task.prompt
                    ? new URLSearchParams({ prompt: task.prompt })
                    : undefined,
                }}
                onClick={prepareReturn}
                className="group rounded-2xl border border-border bg-card p-5 transition-colors hover:bg-state-hover"
              >
                <Icon className="mb-5 h-6 w-6 text-brand-text" />
                <span className="mb-2 flex items-start justify-between gap-2 text-sm font-semibold">
                  {task.title}
                  <ArrowUpRight className="h-4 w-4 shrink-0" />
                </span>
                <span className="block text-xs leading-relaxed text-muted-foreground">
                  {task.text}
                </span>
              </Link>
            );
          })}
        </div>
      </div>
      <div className="mt-8 flex w-full flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
        <Button
          size="lg"
          className="bg-foreground text-background hover:bg-foreground/90"
          render={<Link pathname="/" onClick={prepareReturn} />}
          nativeButton={false}
        >
          {copy.magic}
          <ArrowRight />
        </Button>
        {phase === "open" && (
          <Button
            size="lg"
            variant="neutral"
            pending={operation.state === "loading"}
            onClick={() => {
              return detach(replay(signal), Reason.DomCallback);
            }}
          >
            {copy.again}
            <RotateCcw />
          </Button>
        )}
      </div>
      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
        {copy.footerBefore}
        <button
          type="button"
          onClick={() => {
            return setRules(true);
          }}
          className="rounded underline underline-offset-2 hover:text-foreground"
        >
          {copy.footerLink}
        </button>
        {copy.footerAfter}
      </p>
    </main>
  );
}

export function HalloweenPage() {
  const screen = useGet(halloweenScreen$);
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background text-foreground">
      <HalloweenHeader />
      {screen === "question" ? (
        <QuestionScreen />
      ) : screen === "result" ? (
        <ResultScreen />
      ) : (
        <StartScreen />
      )}
      <HalloweenRules />
    </div>
  );
}
