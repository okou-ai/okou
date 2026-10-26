import { command, computed, state } from "ccstate";
import { array, boolean, object, string } from "zod";
import { delay } from "signal-timers";
import {
  halloweenContract,
  type HalloweenRound,
  type HalloweenPhase,
} from "@okouai/api-contracts/contracts/halloween";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { sessionStorageSignals } from "../external/session-storage.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { apiClientRuntime$ } from "../api-client-runtime.ts";
import { navigateTo$ } from "../route.ts";
import { rootSignal$ } from "../root-signal.ts";
import { detach, Reason, settle, jsonParseOr, setLoop } from "../utils.ts";

const pendingStorage = localStorageSignals("halloween_2026_pending");
const soundStorage = localStorageSignals("halloween_2026_sound");
const credentialSchema = object({
  id: string().uuid(),
  token: string().regex(/^[a-f0-9]{64}$/),
  terminal: boolean(),
});
type Credential = ReturnType<typeof credentialSchema.parse>;
const pendingSchema = array(credentialSchema);
const activeStorage = sessionStorageSignals("halloween_2026_active");
const returnStorage = sessionStorageSignals("halloween_2026_return");

function parsePending(raw: string | null): Credential[] {
  if (!raw) {
    return [];
  }
  const parsed = pendingSchema.safeParse(jsonParseOr(raw, []));
  return parsed.success ? parsed.data : [];
}

const roundState$ = state<HalloweenRound | null>(null);
const phaseState$ = state<HalloweenPhase>("upcoming");
const screenState$ = state<"start" | "question" | "result">("start");
const rulesState$ = state(false);
const linkState$ = state<"idle" | "saved" | "error">("idle");
const firstExposureState$ = state(false);
const ghostExpandedState$ = state(false);
const ghostGreetingIndex$ = state(-1);
const ghostGreetingLocked$ = state(false);
const bubbleTransitionState$ = state<number | null>(null);
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
    await set(navigateTo$, "/halloween", undefined, get(rootSignal$));
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

// The beacon is a best-effort optimization. The persisted credential carries
// interruption to the next visit/login if the browser drops its last request.
const interruptHalloweenVisit$ = command(({ get, set }) => {
  const id = set(activeStorage.readFresh$);
  if (!id) {
    return;
  }
  const pending = parsePending(set(pendingStorage.readFresh$));
  const credential = pending.find((record) => {
    return record.id === id;
  });
  if (!credential) {
    return;
  }
  set(
    pendingStorage.set$,
    JSON.stringify(
      pending.map((record) => {
        return record.id === id ? { ...record, terminal: true } : record;
      }),
    ),
  );
  set(activeStorage.clear$);
  const url = new URL(
    "/api/halloween/leave",
    get(apiClientRuntime$).apiBaseUrl,
  );
  navigator.sendBeacon?.(
    url.toString(),
    JSON.stringify({ id, token: credential.token, reason: "interrupted" }),
  );
});

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
export const halloweenLinkState$ = computed((get) => {
  return get(linkState$);
});
export const halloweenFirstExposure$ = computed((get) => {
  return get(firstExposureState$);
});
export const halloweenSound$ = computed((get) => {
  return get(soundStorage.get$) !== "off";
});
export const setHalloweenRulesOpen$ = command(({ set }, open: boolean) => {
  set(rulesState$, open);
});

const storeRound$ = command(({ set }, round: HalloweenRound) => {
  const pending = parsePending(set(pendingStorage.readFresh$));
  set(
    pendingStorage.set$,
    JSON.stringify(
      pending.map((record) => {
        return record.id === round.id
          ? { ...record, terminal: round.outcome !== "playing" }
          : record;
      }),
    ),
  );
  set(roundState$, round);
  if (round.outcome !== "playing") {
    set(activeStorage.clear$);
  }
});

const currentCredential$ = computed((get) => {
  const round = get(roundState$);
  const pending = parsePending(get(pendingStorage.get$));
  const credential = pending.find((record) => {
    return record.id === round?.id;
  });
  if (!credential) {
    throw new Error("The current game credential is unavailable");
  }
  return credential;
});

const refreshHalloweenPhase$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const result = await accept(
      get(apiClient$)(halloweenContract).status({ fetchOptions: { signal } }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    set(phaseState$, result.body.phase);
    return result.body.changesInMs;
  },
);

const watchHalloweenBoundary$ = command(
  ({ get, set }, remaining: number | null, signal: AbortSignal) => {
    setLoop(
      async () => {
        if (remaining === null) {
          return true;
        }
        await delay(Math.max(1, remaining), { signal });
        signal.throwIfAborted();
        if (get(phaseState$) === "open") {
          set(phaseState$, "ended");
        }
        remaining = await set(refreshHalloweenPhase$, signal);
        return remaining === null;
      },
      0,
      signal,
    );
  },
);

const watchHalloweenPhase$ = command(async ({ set }, signal: AbortSignal) => {
  const remaining = await set(refreshHalloweenPhase$, signal);
  set(watchHalloweenBoundary$, remaining, signal);
  window.addEventListener(
    "focus",
    () => {
      detach(set(refreshHalloweenPhase$, signal), Reason.DomCallback);
    },
    { signal },
  );
});

export const initializeHalloween$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(roundState$, null);
    set(screenState$, "start");
    set(rulesState$, window.location.hash === "#rules");
    const active = set(activeStorage.readFresh$);
    if (active) {
      const pending = parsePending(set(pendingStorage.readFresh$));
      set(
        pendingStorage.set$,
        JSON.stringify(
          pending.map((record) => {
            return record.id === active
              ? { ...record, terminal: true }
              : record;
          }),
        ),
      );
      const credential = parsePending(set(pendingStorage.readFresh$)).find(
        (record) => {
          return record.id === active;
        },
      );
      if (credential) {
        const result = await settle(
          accept(
            get(apiClient$)(halloweenContract).leave({
              body: {
                id: credential.id,
                token: credential.token,
                reason: "interrupted",
              },
              fetchOptions: { signal },
            }),
            [200],
            signal,
            { showErrorToast: false },
          ),
        );
        signal.throwIfAborted();
        if (result.ok) {
          set(storeRound$, result.value.body);
        }
      }
      set(activeStorage.clear$);
      set(roundState$, null);
    }
    await set(watchHalloweenPhase$, signal);
    window.addEventListener(
      "pagehide",
      () => {
        set(interruptHalloweenVisit$);
      },
      { signal },
    );
    signal.addEventListener(
      "abort",
      () => {
        set(interruptHalloweenVisit$);
      },
      { once: true },
    );
    window.addEventListener(
      "pageshow",
      (event) => {
        if (event.persisted) {
          set(roundState$, null);
          set(screenState$, "start");
          detach(set(refreshHalloweenPhase$, signal), Reason.DomCallback);
        }
      },
      { signal },
    );
    window.addEventListener(
      "hashchange",
      () => {
        set(rulesState$, window.location.hash === "#rules");
      },
      { signal },
    );
  },
);

export const startHalloween$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await set(refreshHalloweenPhase$, signal);
    if (get(phaseState$) !== "open") {
      return;
    }
    const pending = parsePending(set(pendingStorage.readFresh$));
    const activeId = set(activeStorage.readFresh$);
    let credential = pending.find((record) => {
      return record.id === activeId;
    });
    if (!credential) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      credential = {
        id: crypto.randomUUID(),
        token: Array.from(bytes, (b) => {
          return b.toString(16).padStart(2, "0");
        }).join(""),
        terminal: false,
      };
      set(pendingStorage.set$, JSON.stringify([...pending, credential]));
      set(activeStorage.set$, credential.id);
    }
    const result = await accept(
      get(apiClient$)(halloweenContract).start({
        body: { id: credential.id, token: credential.token },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    set(storeRound$, result.body);
    set(
      screenState$,
      result.body.outcome === "playing" ? "question" : "result",
    );
  },
);

export const answerHalloween$ = command(
  async ({ get, set }, optionId: string, signal: AbortSignal) => {
    const round = get(roundState$);
    if (!round?.question || round.feedback) {
      return;
    }
    const credential = get(currentCredential$);
    const result = await accept(
      get(apiClient$)(halloweenContract).answer({
        body: {
          id: credential.id,
          token: credential.token,
          questionId: round.question.id,
          optionId,
        },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    set(storeRound$, {
      ...result.body,
      question: result.body.question ?? round.question,
    });
    if (result.body.outcome === "wrong") {
      await delay(1100, { signal });
      signal.throwIfAborted();
      set(screenState$, "result");
      await set(refreshHalloweenPhase$, signal);
    }
  },
);

export const nextHalloween$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const round = get(roundState$);
    if (!round?.question || !round.feedback?.correct) {
      return;
    }
    const credential = get(currentCredential$);
    const result = await accept(
      get(apiClient$)(halloweenContract).next({
        body: {
          id: credential.id,
          token: credential.token,
          questionId: round.question.id,
        },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    set(storeRound$, result.body);
    if (result.body.outcome !== "playing") {
      set(screenState$, "result");
      await set(refreshHalloweenPhase$, signal);
    }
  },
);

export const leaveHalloween$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const round = get(roundState$);
    if (round?.outcome === "playing") {
      const credential = get(currentCredential$);
      // Leave immediately. A lost request is retried as an interruption when
      // this credential is next associated; the user never resumes the round.
      const pending = parsePending(set(pendingStorage.readFresh$));
      set(
        pendingStorage.set$,
        JSON.stringify(
          pending.map((record) => {
            return record.id === credential.id
              ? { ...record, terminal: true }
              : record;
          }),
        ),
      );
      set(activeStorage.clear$);
      set(screenState$, "start");
      set(roundState$, null);
      await settle(
        accept(
          get(apiClient$)(halloweenContract).leave({
            body: {
              id: credential.id,
              token: credential.token,
              reason: "left",
            },
            fetchOptions: { signal },
          }),
          [200],
          signal,
          { showErrorToast: false },
        ),
      );
      signal.throwIfAborted();
    }
    set(screenState$, "start");
    set(roundState$, null);
    await set(refreshHalloweenPhase$, signal);
  },
);

export const replayHalloween$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(roundState$, null);
    set(screenState$, "start");
    await set(refreshHalloweenPhase$, signal);
  },
);

export const prepareHalloweenReturn$ = command(({ get, set }) => {
  const round = get(roundState$);
  if (round && round.outcome !== "playing") {
    set(returnStorage.set$, round.id);
  }
});

export const linkHalloweenResults$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const currentId = set(returnStorage.readFresh$);
    const pending = parsePending(set(pendingStorage.readFresh$));
    for (const credential of pending) {
      const result = await settle(
        accept(
          get(apiClient$)(halloweenContract).link({
            body: {
              id: credential.id,
              token: credential.token,
              interrupted: credential.terminal,
            },
            fetchOptions: { signal },
          }),
          [200],
          signal,
          { showErrorToast: false },
        ),
      );
      signal.throwIfAborted();
      if (result.ok) {
        const latest = parsePending(set(pendingStorage.readFresh$));
        // A round still playing in another tab retains its bearer credential.
        if (result.value.body.outcome !== "playing") {
          set(
            pendingStorage.set$,
            JSON.stringify(
              latest.filter((record) => {
                return record.id !== credential.id;
              }),
            ),
          );
        }
        if (credential.id === currentId) {
          set(linkState$, "saved");
          set(returnStorage.clear$);
        }
      } else if (credential.id === currentId) {
        set(linkState$, "error");
      }
    }
    if (get(linkState$) === "saved") {
      await delay(6000, { signal });
      set(linkState$, "idle");
    }
  },
);

export const initializeHalloweenHome$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(linkState$, "idle");
    set(firstExposureState$, false);
    set(bubbleTransitionState$, null);
    set(ghostExpandedState$, false);
    set(ghostGreetingLocked$, false);
    detach(
      set(linkHalloweenResults$, signal),
      Reason.Daemon,
      "link pending Halloween results",
    );
    await set(watchHalloweenPhase$, signal);
    if (get(phaseState$) !== "open") {
      return;
    }
    const result = await accept(
      get(apiClient$)(halloweenContract).exposure({
        body: {},
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    set(firstExposureState$, result.body.first);
    if (result.body.first) {
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
