import { command, computed, state, type Command, type Computed } from "ccstate";

import type { ComposerSignals } from "../okou-page/composer-signals.ts";

export type BrowserController = "agent" | "member" | null;

export interface BrowserPresenceSignals {
  /** Who drives the thread's cloud browser right now, if anyone. */
  readonly controller$: Computed<BrowserController>;
  /** Stop the live Run so the member can use the browser themselves. */
  readonly takeOver$: Command<Promise<void>, [AbortSignal]>;
  /** Draft the follow-up that hands the browser back to the agent. */
  readonly handBack$: Command<void, [string]>;
}

/**
 * Taking over stops the live Run, so the member keeps control until a newer
 * Run starts. Handing back drafts the message that starts it.
 */
export function createBrowserPresenceSignals({
  latestRunId$,
  liveRunId$,
  composer,
}: {
  readonly latestRunId$: Computed<string | null>;
  readonly liveRunId$: Computed<string | null>;
  readonly composer: Pick<ComposerSignals, "submission" | "editor">;
}): BrowserPresenceSignals {
  const takeoverRunId$ = state<string | null>(null);

  const controller$ = computed((get): BrowserController => {
    const takeoverRunId = get(takeoverRunId$);
    if (takeoverRunId !== null && takeoverRunId === get(latestRunId$)) {
      return "member";
    }
    return get(liveRunId$) === null ? null : "agent";
  });

  const takeOver$ = command(async ({ get, set }, signal: AbortSignal) => {
    const runId = get(liveRunId$);
    if (runId === null) {
      return;
    }
    // Control moves only once the Run has stopped; a failed stop leaves it
    // with the agent.
    await set(composer.submission.activatePrimaryAction$, "stop", signal);
    set(takeoverRunId$, runId);
  });

  const handBack$ = command(({ set }, message: string) => {
    set(composer.editor.selectOrAppendText$, message);
    set(takeoverRunId$, null);
  });

  return { controller$, takeOver$, handBack$ };
}
