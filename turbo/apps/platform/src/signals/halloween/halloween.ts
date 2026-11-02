import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { delay } from "signal-timers";
import { halloweenContract } from "@okouai/api-contracts/client/halloween";
import type {
  HalloweenRound,
  HalloweenPhase,
} from "@okouai/api-contracts/contracts/halloween";
import { accept } from "../../lib/accept.ts";
import { ensureHalloweenI18nResources } from "../../i18n/index.ts";
import { apiClient$ } from "../api-client.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { locale$ } from "../locale.ts";
import {
  hash$,
  historyState$,
  replaceSearchParams$,
  searchParams$,
} from "../route.ts";
import { detach, Reason, resetSignal } from "../utils.ts";

const soundStorage = localStorageSignals("halloween_2026_sound");
const homeAnimationStorage = localStorageSignals(
  "halloween_2026_home_animation_seen",
);

const roundState$ = state<HalloweenRound | null>(null);
const phaseState$ = state<HalloweenPhase>("unavailable");
const screenState$ = state<"start" | "question" | "result">("start");
const rulesState$ = state(false);
const homeAnimationVisibleState$ = state(false);
const ghostExpandedState$ = state(false);
const ghostGreetingIndex$ = state(-1);
const ghostGreetingLocked$ = state(false);
const bubbleTransitionState$ = state<number | null>(null);
const modalOpenState$ = state(false);
const modalAnchorState$ = state<DOMRect | null>(null);
const resetHalloweenAction$ = resetSignal();

export const halloweenModalOpen$ = computed((get) => {
  return get(modalOpenState$);
});
export const halloweenModalAnchor$ = computed((get) => {
  return get(modalAnchorState$);
});
export const setHalloweenModalAnchor$ = command(
  ({ set }, anchor: DOMRect | null) => {
    set(modalAnchorState$, anchor);
  },
);
export const openHalloweenModal$ = command(({ get, set }) => {
  const round = get(roundState$);
  set(
    screenState$,
    round ? (round.outcome === "playing" ? "question" : "result") : "start",
  );
  set(rulesState$, false);
  set(modalOpenState$, true);
});

export const closeHalloweenModal$ = command(({ set }) => {
  set(resetHalloweenAction$);
  set(modalOpenState$, false);
  set(rulesState$, false);
});
export const halloweenBubbleTransition$ = computed((get) => {
  return get(bubbleTransitionState$);
});
export const enterHalloweenFromBubble$ = command(
  async ({ get, set }, index: number, signal: AbortSignal) => {
    if (get(bubbleTransitionState$) !== null) {
      return;
    }
    set(bubbleTransitionState$, index);
    await delay(750, { signal });
    signal.throwIfAborted();
    set(modalAnchorState$, null);
    set(openHalloweenModal$);
    set(bubbleTransitionState$, null);
  },
);

export const halloweenGhostExpanded$ = computed((get) => {
  return get(ghostExpandedState$);
});
export const halloweenGhostGreetingIndex$ = computed((get) => {
  return Math.max(0, get(ghostGreetingIndex$)) % 3;
});
export const expandHalloweenGhost$ = command(({ get, set }) => {
  if (!get(ghostExpandedState$)) {
    set(ghostGreetingIndex$, get(ghostGreetingIndex$) + 1);
    set(ghostExpandedState$, true);
  }
});
export const collapseHalloweenGhost$ = command(
  ({ get, set }, force = false) => {
    if (force || !get(ghostGreetingLocked$)) {
      set(ghostExpandedState$, false);
    }
  },
);

export const halloweenRound$ = computed((get) => {
  return get(roundState$);
});
export const halloweenPhase$ = computed((get) => {
  return get(phaseState$);
});
export const halloweenScreen$ = computed((get) => {
  return get(screenState$);
});
export const halloweenRulesOpen$ = computed((get) => {
  return get(rulesState$);
});
export const halloweenHomeAnimationVisible$ = computed((get) => {
  return get(homeAnimationVisibleState$);
});
export const halloweenSound$ = computed((get) => {
  return get(soundStorage.get$) !== "off";
});
export const setHalloweenRulesOpen$ = command(({ set }, open: boolean) => {
  set(rulesState$, open);
});

const storeRound$ = command(({ set }, round: HalloweenRound) => {
  set(roundState$, round);
});

const showRound$ = command(({ set }, round: HalloweenRound) => {
  set(storeRound$, round);
  set(screenState$, round.outcome === "playing" ? "question" : "result");
});

const loadCurrentHalloweenRound$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const result = await accept(
      get(apiClient$)(halloweenContract).current({
        fetchOptions: { signal },
      }),
      [200, 404],
      signal,
    );
    signal.throwIfAborted();
    if (result.status === 200) {
      set(showRound$, result.body);
    } else {
      set(roundState$, null);
      set(screenState$, "start");
    }
  },
);

const refreshHalloweenPhase$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const result = await accept(
      get(apiClient$)(halloweenContract).status({ fetchOptions: { signal } }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    if (result.body.phase === "open") {
      await ensureHalloweenI18nResources(get(locale$), signal);
      signal.throwIfAborted();
    }
    set(phaseState$, result.body.phase);
  },
);

const watchHalloweenPhase$ = command(async ({ set }, signal: AbortSignal) => {
  await set(refreshHalloweenPhase$, signal);
  window.addEventListener(
    "focus",
    () => {
      detach(set(refreshHalloweenPhase$, signal), Reason.DomCallback);
    },
    { signal },
  );
});

const requestHalloweenRound$ = command(
  async ({ get, set }, restart: boolean, parentSignal: AbortSignal) => {
    const signal = set(resetHalloweenAction$, parentSignal);
    await set(refreshHalloweenPhase$, signal);
    if (get(phaseState$) !== "open") {
      return;
    }
    const result = await accept(
      get(apiClient$)(halloweenContract).start({
        body: { restart },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    set(showRound$, result.body);
  },
);

export const startHalloween$ = command(async ({ set }, signal: AbortSignal) => {
  await set(requestHalloweenRound$, false, signal);
});

export const answerHalloween$ = command(
  async ({ get, set }, optionId: string, parentSignal: AbortSignal) => {
    const signal = set(resetHalloweenAction$, parentSignal);
    const round = get(roundState$);
    if (!round?.question || round.feedback) {
      return;
    }
    const result = await accept(
      get(apiClient$)(halloweenContract).answer({
        body: {
          id: round.id,
          questionId: round.question.id,
          optionId,
        },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    if (get(roundState$)?.id !== round.id) {
      return;
    }
    set(storeRound$, {
      ...result.body,
      question: result.body.question ?? round.question,
    });
    if (result.body.outcome === "wrong") {
      await delay(1100, { signal });
      signal.throwIfAborted();
      if (
        get(roundState$)?.id !== round.id ||
        get(screenState$) !== "question"
      ) {
        return;
      }
      set(screenState$, "result");
      await set(refreshHalloweenPhase$, signal);
    }
  },
);

export const nextHalloween$ = command(
  async ({ get, set }, parentSignal: AbortSignal) => {
    const signal = set(resetHalloweenAction$, parentSignal);
    const round = get(roundState$);
    if (!round?.question || !round.feedback?.correct) {
      return;
    }
    const result = await accept(
      get(apiClient$)(halloweenContract).next({
        body: {
          id: round.id,
          questionId: round.question.id,
        },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    if (get(roundState$)?.id !== round.id) {
      return;
    }
    set(storeRound$, result.body);
    if (result.body.outcome !== "playing") {
      set(screenState$, "result");
      await set(refreshHalloweenPhase$, signal);
    }
  },
);

export const replayHalloween$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(requestHalloweenRound$, true, signal);
  },
);

export const initializeHalloweenHome$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(resetHalloweenAction$);
    set(modalOpenState$, false);
    set(roundState$, null);
    set(screenState$, "start");
    set(rulesState$, false);
    set(phaseState$, "unavailable");
    set(homeAnimationVisibleState$, false);
    set(bubbleTransitionState$, null);
    set(ghostExpandedState$, false);
    set(ghostGreetingLocked$, false);
    const { switches } = await get(featureSwitches$);
    signal.throwIfAborted();
    if (!switches[FeatureSwitchKey.HalloweenQuiz]) {
      return;
    }
    await set(watchHalloweenPhase$, signal);
    if (get(phaseState$) !== "open") {
      return;
    }
    await set(loadCurrentHalloweenRound$, signal);
    const params = new URLSearchParams(get(searchParams$));
    if (params.get("halloween") === "1") {
      params.delete("halloween");
      set(replaceSearchParams$, params, get(historyState$), get(hash$));
      set(homeAnimationStorage.set$, "seen");
      set(modalAnchorState$, null);
      set(openHalloweenModal$);
      return;
    }
    const first = set(homeAnimationStorage.readFresh$) === null;
    set(homeAnimationStorage.set$, "seen");
    set(homeAnimationVisibleState$, first);
    if (first) {
      set(expandHalloweenGhost$);
      set(ghostGreetingLocked$, true);
      await delay(
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 6000
          : 19_137,
        { signal },
      );
      signal.throwIfAborted();
      set(ghostGreetingLocked$, false);
      set(collapseHalloweenGhost$);
    }
  },
);

export const toggleHalloweenSound$ = command(({ get, set }) => {
  set(soundStorage.set$, get(halloweenSound$) ? "off" : "on");
});
