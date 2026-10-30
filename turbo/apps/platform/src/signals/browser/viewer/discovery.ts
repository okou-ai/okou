import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  createDeferredPromise,
  scheduleTimeout,
  setLoop,
} from "../../utils.ts";

import { CdpFault, isRecord } from "../cdp/errors.ts";
import { pageTarget, type TargetDirectory } from "../cdp/targets.ts";

import type { CdpEvent } from "../cdp/client.ts";
import type { ViewerSnapshot, ViewerTarget } from "./types.ts";
import {
  currentObservation,
  currentRound,
  inventoryExpiry,
  type InventoryEvent,
  type InventoryRound,
  type TargetInventory,
  type TargetObservation,
} from "./target-inventory.ts";

const selectedIntervalMs = 2000;
const selectedFreshnessMs = 12_000;
const inventoryIntervalMs = 10_000;
const inventoryRoundMs = 10_000;

interface Selected {
  readonly targetId: string;
  readonly order: number;
}

interface DiscoveryModel {
  readonly inventoryState$: Computed<TargetInventory>;
  readonly snapshot$: Computed<ViewerSnapshot>;
  readonly inventory$: Command<TargetInventory, [InventoryEvent]>;
}

interface DiscoveryOptions {
  readonly scoped: boolean;
  readonly changed$: Command<void, [AbortSignal]>;
  readonly failed$: Command<void, [unknown, AbortSignal]>;
}

type DiscoveryState = ReturnType<typeof createDiscoveryState>;
type DiscoveryFailure = ReturnType<typeof createDiscoveryFailure>;
type DiscoveryCommits = ReturnType<typeof createDiscoveryCommits>;
type DiscoveryObservations = ReturnType<typeof createDiscoveryObservations>;
type DiscoveryReaders = ReturnType<typeof createDiscoveryReaders>;
type DiscoveryRounds = ReturnType<typeof createDiscoveryRounds>;
type DiscoveryQueue = ReturnType<typeof createDiscoveryQueue>;
type DiscoveryDrain = ReturnType<typeof createDiscoveryDrain>;
type SelectedFreshness = ReturnType<typeof createSelectedFreshness>;
type SelectedReader = ReturnType<typeof createSelectedReader>;

function createDiscoveryState(model: DiscoveryModel) {
  const dirty$ = state<ReadonlySet<string>>(new Set());
  const scan$ = state<InventoryRound | null>(null);
  const scanDeadline$ = state<(() => void) | null>(null);
  const inventoryDeadline$ = state<(() => void) | null>(null);
  const selected$ = state<Selected | null>(null);
  const selectedDeadline$ = state<(() => void) | null>(null);
  const selectedVerifiedAt$ = state(0);
  const selectedFresh$ = state(false);
  const selectedPending$ = state<Selected | null>(null);
  const fullWanted$ = state(false);
  const running$ = state(false);
  const started$ = state(false);
  const closed$ = state(false);
  const aborted$ = state(false);
  const epoch$ = state<number | null>(null);
  const unwatchAbort$ = state<(() => void) | null>(null);
  // Subscribers bridge completion events, never opaque pending operations.
  const drainListeners$ = state<
    ReadonlySet<(result: PromiseSettledResult<void>) => void>
  >(new Set());

  const active$ = computed((get) => {
    return (
      get(started$) &&
      !get(closed$) &&
      !get(aborted$) &&
      get(epoch$) === get(model.inventoryState$).epoch
    );
  });
  const selectedTargetId$ = computed((get) => {
    const selected = get(selected$);
    return get(active$) &&
      selected &&
      get(selectedFresh$) &&
      performance.now() - get(selectedVerifiedAt$) < selectedFreshnessMs
      ? selected.targetId
      : null;
  });
  const wanted$ = computed((get) => {
    return get(fullWanted$) || get(dirty$).size > 0;
  });

  return {
    dirty$,
    scan$,
    scanDeadline$,
    inventoryDeadline$,
    selected$,
    selectedDeadline$,
    selectedVerifiedAt$,
    selectedFresh$,
    selectedPending$,
    fullWanted$,
    running$,
    started$,
    closed$,
    aborted$,
    epoch$,
    unwatchAbort$,
    drainListeners$,
    active$,
    selectedTargetId$,
    wanted$,
  };
}

function createDiscoveryFailure(
  model: DiscoveryModel,
  options: DiscoveryOptions,
  graph: DiscoveryState,
) {
  const {
    dirty$,
    scanDeadline$,
    inventoryDeadline$,
    selectedDeadline$,
    active$,
    fullWanted$,
    epoch$,
  } = graph;
  const forgetDirty$ = command(({ get, set }, targetId: string) => {
    const dirty = get(dirty$);
    if (dirty.has(targetId)) {
      const next = new Set(dirty);
      next.delete(targetId);
      set(dirty$, next);
    }
  });
  const cancelInventoryDeadlines$ = command(({ get, set }) => {
    get(scanDeadline$)?.();
    get(inventoryDeadline$)?.();
    set(scanDeadline$, null);
    set(inventoryDeadline$, null);
  });
  const cancelSelectedDeadline$ = command(({ get, set }) => {
    get(selectedDeadline$)?.();
    set(selectedDeadline$, null);
  });
  const fail$ = command(({ get, set }, error: unknown, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!get(active$)) {
      return;
    }
    set(cancelInventoryDeadlines$);
    set(fullWanted$, false);
    set(dirty$, new Set());
    set(epoch$, set(model.inventory$, { type: "reset" }).epoch);
    set(options.failed$, error, signal);
  });
  return {
    forgetDirty$,
    cancelInventoryDeadlines$,
    cancelSelectedDeadline$,
    fail$,
  };
}

function createDiscoveryCommits(
  model: DiscoveryModel,
  options: DiscoveryOptions,
  graph: DiscoveryState,
  failure: DiscoveryFailure,
) {
  const { active$, inventoryDeadline$ } = graph;
  const { fail$ } = failure;
  const inventoryExpired$ = command(
    ({ get, set }, deadline: () => void, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (get(active$) && get(inventoryDeadline$) === deadline) {
        set(
          fail$,
          new CdpFault(
            "scope",
            "Window inventory could not be verified in time.",
          ),
          signal,
        );
      }
    },
  );
  const expireInventory$ = command(({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!get(active$) || !options.scoped) {
      return;
    }
    get(inventoryDeadline$)?.();
    set(inventoryDeadline$, null);
    const expiresAt = inventoryExpiry(get(model.inventoryState$));
    if (expiresAt === null) {
      return;
    }
    const deadline = scheduleTimeout(
      () => {
        set(inventoryExpired$, deadline, signal);
      },
      Math.max(0, expiresAt - performance.now()),
      signal,
    );
    set(inventoryDeadline$, () => {
      return deadline;
    });
  });
  const publish$ = command(({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (get(active$) && get(model.inventoryState$).ready) {
      set(options.changed$, signal);
    }
  });
  const commit$ = command(
    (
      { get, set },
      event: InventoryEvent,
      notify: boolean,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      const targets = get(model.snapshot$).targets;
      const ready = get(model.inventoryState$).ready;
      set(model.inventory$, event);
      set(expireInventory$, signal);
      if (
        notify &&
        (targets !== get(model.snapshot$).targets ||
          (!ready && get(model.inventoryState$).ready))
      ) {
        set(publish$, signal);
      }
    },
  );
  return { commit$ };
}

function createDiscoveryObservations(
  model: DiscoveryModel,
  graph: DiscoveryState,
) {
  const { active$, selected$ } = graph;
  const observe$ = command(({ get, set }, id: string) => {
    if (!get(active$)) {
      return null;
    }
    const inventory = set(model.inventory$, { type: "order" });
    const entry = inventory.entries.get(id);
    return entry
      ? {
          id,
          epoch: inventory.epoch,
          generation: entry.generation,
          order: inventory.sequence,
          startedAt: performance.now(),
        }
      : null;
  });
  const roundCurrent$ = command(({ get }, round: InventoryRound) => {
    return get(active$) && currentRound(get(model.inventoryState$), round);
  });
  const acceptsMembership$ = command(
    ({ get }, observation: TargetObservation, round: InventoryRound | null) => {
      const selected = get(selected$);
      const inventory = get(model.inventoryState$);
      return (
        get(active$) &&
        (!round || currentRound(inventory, round)) &&
        currentObservation(inventory, observation) &&
        // A new selection performs fresh activation/attachment checks itself.
        !(
          selected?.targetId === observation.id &&
          observation.order <= selected.order
        )
      );
    },
  );
  return { observe$, roundCurrent$, acceptsMembership$ };
}

function createDiscoveryReaders(
  directory: TargetDirectory,
  model: DiscoveryModel,
  ports: DiscoveryObservations & DiscoveryCommits & DiscoveryFailure,
) {
  const { observe$, roundCurrent$, acceptsMembership$, commit$, fail$ } = ports;
  const readMembership$ = command(
    async (
      { get, set },
      observation: TargetObservation,
      round: InventoryRound | null,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const [result] = await Promise.allSettled([
        directory.contains(observation.id),
      ]);
      signal.throwIfAborted();
      let member = result.status === "fulfilled" && result.value;
      if (result.status === "rejected") {
        // A retired generation's response cannot revoke its replacement.
        if (!set(acceptsMembership$, observation, round)) {
          throw result.reason;
        }
        const error: unknown = result.reason;
        if (
          !(error instanceof CdpFault) ||
          error.kind !== "scope" ||
          get(model.snapshot$).selectedTargetId === observation.id
        ) {
          set(fail$, error, signal);
          throw error;
        }
        // An unverifiable background page loses admission, never gains it.
        member = false;
      }
      if (set(acceptsMembership$, observation, round)) {
        set(commit$, { type: "membership", observation, member }, true, signal);
      }
    },
  );
  const readRound$ = command(
    async (
      { set },
      round: InventoryRound,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const pages = await directory.read();
      signal.throwIfAborted();
      if (!set(roundCurrent$, round)) {
        return;
      }
      set(commit$, { type: "listed", round, targets: pages }, true, signal);
      if (!set(roundCurrent$, round)) {
        return;
      }
      for (let offset = 0; offset < pages.length; offset += 4) {
        const results = await Promise.allSettled(
          pages.slice(offset, offset + 4).map(async (target) => {
            const observation = set(observe$, target.id);
            if (observation) {
              await set(readMembership$, observation, round, signal);
            }
          }),
        );
        signal.throwIfAborted();
        const rejected = results.find((result) => {
          return result.status === "rejected";
        });
        if (rejected?.status === "rejected") {
          throw rejected.reason;
        }
        if (!set(roundCurrent$, round)) {
          return;
        }
      }
      set(commit$, { type: "complete-round", round }, true, signal);
    },
  );
  return { readMembership$, readRound$ };
}

function createDiscoveryRounds(
  model: DiscoveryModel,
  graph: DiscoveryState,
  failure: DiscoveryFailure,
  observations: DiscoveryObservations,
  readers: DiscoveryReaders,
) {
  const { scan$, scanDeadline$ } = graph;
  const { fail$ } = failure;
  const { roundCurrent$ } = observations;
  const { readRound$ } = readers;
  const roundExpired$ = command(
    ({ set }, round: InventoryRound, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (set(roundCurrent$, round)) {
        set(
          fail$,
          new CdpFault(
            "scope",
            "Window inventory could not be verified in time.",
          ),
          signal,
        );
      }
    },
  );
  const finishRound$ = command(
    ({ get, set }, round: InventoryRound, deadline: () => void) => {
      deadline();
      if (get(scan$) === round) {
        set(scan$, null);
        set(scanDeadline$, null);
      }
    },
  );
  const readFull$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const inventory = set(model.inventory$, {
        type: "begin-round",
        now: performance.now(),
      });
      const round = inventory.round!;
      set(scan$, round);
      const deadline = scheduleTimeout(
        () => {
          set(roundExpired$, round, signal);
        },
        inventoryRoundMs,
        signal,
      );
      set(scanDeadline$, () => {
        return deadline;
      });
      const [result] = await Promise.allSettled([
        set(readRound$, round, signal),
      ]);
      if (signal.aborted) {
        set(finishRound$, round, deadline);
        signal.throwIfAborted();
      }
      set(finishRound$, round, deadline);
      if (result.status === "rejected") {
        if (set(roundCurrent$, round)) {
          set(fail$, result.reason, signal);
        }
        throw result.reason;
      }
    },
  );
  return { readFull$ };
}

function createDiscoveryQueue(
  graph: DiscoveryState,
  ports: DiscoveryReaders & DiscoveryRounds & DiscoveryObservations,
) {
  const { dirty$, active$, wanted$, fullWanted$ } = graph;
  const { observe$, readMembership$, readFull$ } = ports;
  const readDirty$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const remaining = new Set(get(dirty$));
      const batch: string[] = [];
      for (const id of remaining) {
        batch.push(id);
        remaining.delete(id);
        if (batch.length === 4) {
          break;
        }
      }
      set(dirty$, remaining);
      const results = await Promise.allSettled(
        batch.map(async (id) => {
          const observation = set(observe$, id);
          if (observation) {
            await set(readMembership$, observation, null, signal);
          }
        }),
      );
      signal.throwIfAborted();
      const rejected = results.find((result) => {
        return result.status === "rejected";
      });
      if (rejected?.status === "rejected") {
        throw rejected.reason;
      }
    },
  );
  const readWanted$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      while (get(active$) && get(wanted$)) {
        if (get(fullWanted$)) {
          set(fullWanted$, false);
          await set(readFull$, signal);
        } else {
          await set(readDirty$, signal);
        }
        signal.throwIfAborted();
      }
    },
  );
  return { readWanted$ };
}

function createDiscoveryDrain(graph: DiscoveryState, queue: DiscoveryQueue) {
  const { drainListeners$, running$, active$, wanted$, fullWanted$ } = graph;
  const { readWanted$ } = queue;
  const drained$ = command(
    ({ get, set }, result: PromiseSettledResult<void>) => {
      const listeners = get(drainListeners$);
      set(drainListeners$, new Set());
      for (const listener of listeners) {
        listener(result);
      }
    },
  );
  const unwatchDrain$ = command(
    ({ get, set }, listener: (result: PromiseSettledResult<void>) => void) => {
      const listeners = new Set(get(drainListeners$));
      listeners.delete(listener);
      set(drainListeners$, listeners);
    },
  );
  const waitForDrain$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (!get(running$)) {
        return;
      }
      const event = createDeferredPromise<void>(signal);
      const listener = (result: PromiseSettledResult<void>) => {
        if (event.settled()) {
          return;
        }
        if (result.status === "fulfilled") {
          event.resolve();
        } else {
          event.reject(result.reason);
        }
      };
      set(drainListeners$, new Set(get(drainListeners$)).add(listener));
      const [result] = await Promise.allSettled([event.promise]);
      if (signal.aborted) {
        set(unwatchDrain$, listener);
        signal.throwIfAborted();
      }
      set(unwatchDrain$, listener);
      if (result.status === "rejected") {
        throw result.reason;
      }
    },
  );
  const drain$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (get(running$)) {
        // Requests update desired state first, then join the one active reader.
        await set(waitForDrain$, signal);
        return;
      }
      if (!get(active$) || !get(wanted$)) {
        return;
      }
      set(running$, true);
      const [result] = await Promise.allSettled([set(readWanted$, signal)]);
      if (signal.aborted) {
        set(running$, false);
        set(drained$, { status: "rejected", reason: signal.reason });
        signal.throwIfAborted();
      }
      set(running$, false);
      set(drained$, result);
      if (result.status === "rejected") {
        throw result.reason;
      }
    },
  );
  const reconcile$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (!get(active$)) {
        return;
      }
      set(fullWanted$, true);
      await set(drain$, signal);
    },
  );

  return { drain$, reconcile$ };
}

function createSelectedFreshness(
  graph: DiscoveryState,
  failure: DiscoveryFailure,
) {
  const {
    active$,
    selected$,
    selectedFresh$,
    selectedDeadline$,
    selectedVerifiedAt$,
  } = graph;
  const { fail$ } = failure;
  const staleSelected$ = command(
    ({ get, set }, selected: Selected, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (get(active$) && get(selected$) === selected) {
        set(selectedFresh$, false);
        set(
          fail$,
          new CdpFault(
            "scope",
            "Selected window membership could not be verified in time.",
          ),
          signal,
        );
      }
    },
  );
  const selectedExpired$ = command(
    (
      { get, set },
      selected: Selected,
      deadline: () => void,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      if (get(selectedDeadline$) === deadline) {
        set(staleSelected$, selected, signal);
      }
    },
  );
  const expireSelected$ = command(
    ({ get, set }, selected: Selected, signal: AbortSignal) => {
      signal.throwIfAborted();
      const deadline = scheduleTimeout(
        () => {
          set(selectedExpired$, selected, deadline, signal);
        },
        Math.max(
          0,
          get(selectedVerifiedAt$) + selectedFreshnessMs - performance.now(),
        ),
        signal,
      );
      set(selectedDeadline$, () => {
        return deadline;
      });
    },
  );
  return { staleSelected$, expireSelected$ };
}

function createSelectedReader(
  directory: TargetDirectory,
  model: DiscoveryModel,
  graph: DiscoveryState,
  ports: DiscoveryObservations &
    DiscoveryCommits &
    DiscoveryFailure &
    SelectedFreshness,
) {
  const {
    active$,
    selected$,
    selectedFresh$,
    selectedVerifiedAt$,
    selectedPending$,
  } = graph;
  const {
    observe$,
    fail$,
    staleSelected$,
    commit$,
    cancelSelectedDeadline$,
    expireSelected$,
  } = ports;
  const readSelected$ = command(
    async (
      { get, set },
      selected: Selected,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const observation = set(observe$, selected.targetId);
      if (!observation) {
        return;
      }
      const [result] = await Promise.allSettled([
        directory.contains(selected.targetId),
      ]);
      signal.throwIfAborted();
      if (result.status === "rejected") {
        if (
          get(active$) &&
          get(selected$) === selected &&
          currentObservation(get(model.inventoryState$), observation)
        ) {
          set(fail$, result.reason, signal);
        }
        throw result.reason;
      }
      const member = result.value;
      if (!get(active$) || get(selected$) !== selected) {
        return;
      }
      if (
        !get(selectedFresh$) ||
        performance.now() - get(selectedVerifiedAt$) >= selectedFreshnessMs
      ) {
        set(staleSelected$, selected, signal);
        return;
      }
      set(commit$, { type: "membership", observation, member }, true, signal);
      if (get(selected$) !== selected) {
        return;
      }
      const entry = get(model.inventoryState$).entries.get(selected.targetId);
      if (
        entry?.generation === observation.generation &&
        entry.membership?.member
      ) {
        set(selectedVerifiedAt$, (verifiedAt) => {
          return Math.max(verifiedAt, entry.membership!.startedAt);
        });
        set(cancelSelectedDeadline$);
        set(expireSelected$, selected, signal);
      }
    },
  );
  const finishSelected$ = command(({ get, set }, selected: Selected) => {
    if (get(selectedPending$) === selected) {
      set(selectedPending$, null);
    }
  });
  const checkSelected$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const selected = get(selected$);
      if (!get(active$) || !selected || get(selectedPending$) === selected) {
        return;
      }
      if (
        !get(selectedFresh$) ||
        performance.now() - get(selectedVerifiedAt$) >= selectedFreshnessMs
      ) {
        set(staleSelected$, selected, signal);
        return;
      }
      set(selectedPending$, selected);
      const [result] = await Promise.allSettled([
        set(readSelected$, selected, signal),
      ]);
      if (signal.aborted) {
        set(finishSelected$, selected);
        signal.throwIfAborted();
      }
      set(finishSelected$, selected);
      if (result.status === "rejected") {
        throw result.reason;
      }
    },
  );
  return { checkSelected$ };
}

function createDiscoveryLifecycle(
  model: DiscoveryModel,
  options: DiscoveryOptions,
  graph: DiscoveryState,
  ports: DiscoveryFailure & DiscoveryDrain & SelectedFreshness & SelectedReader,
) {
  const {
    aborted$,
    selectedFresh$,
    closed$,
    started$,
    epoch$,
    unwatchAbort$,
    active$,
    selected$,
    selectedPending$,
    selectedVerifiedAt$,
  } = graph;
  const {
    cancelSelectedDeadline$,
    cancelInventoryDeadlines$,
    drain$,
    reconcile$,
    checkSelected$,
    expireSelected$,
  } = ports;
  const abort$ = command(({ set }) => {
    set(aborted$, true);
    set(selectedFresh$, false);
    set(cancelSelectedDeadline$);
    set(cancelInventoryDeadlines$);
  });

  const start$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (get(closed$) || get(aborted$)) {
        throw new CdpFault("connection", "Target discovery is closed.");
      }
      if (get(started$)) {
        await set(drain$, signal);
        signal.throwIfAborted();
        return;
      }
      const onAbort = () => {
        set(abort$);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      set(unwatchAbort$, () => {
        return () => {
          signal.removeEventListener("abort", onAbort);
        };
      });
      set(started$, true);
      set(epoch$, set(model.inventory$, { type: "reset" }).epoch);
      signal.throwIfAborted();
      if (options.scoped) {
        setLoop(
          async (loopSignal) => {
            await set(reconcile$, loopSignal);
            return !get(active$);
          },
          inventoryIntervalMs,
          signal,
          { testIntervalMs: inventoryIntervalMs },
        );
        setLoop(
          async (loopSignal) => {
            await set(checkSelected$, loopSignal);
            return !get(active$);
          },
          selectedIntervalMs,
          signal,
          { testIntervalMs: selectedIntervalMs },
        );
        // The first loop body starts synchronously. Join its finite initial read.
        await set(drain$, signal);
      } else {
        await set(reconcile$, signal);
      }
      signal.throwIfAborted();
    },
  );
  const watch$ = command(
    ({ get, set }, targetId: string | null, signal: AbortSignal) => {
      signal.throwIfAborted();
      set(cancelSelectedDeadline$);
      set(selected$, null);
      set(selectedFresh$, false);
      set(selectedPending$, null);
      if (targetId && options.scoped && get(active$)) {
        const selected: Selected = {
          targetId,
          order: get(model.inventoryState$).sequence,
        };
        set(selected$, selected);
        set(selectedVerifiedAt$, performance.now());
        set(selectedFresh$, true);
        set(expireSelected$, selected, signal);
      }
    },
  );
  return { start$, watch$ };
}

function createDiscoveryEvents(
  model: DiscoveryModel,
  graph: DiscoveryState,
  ports: DiscoveryCommits & DiscoveryDrain & DiscoveryFailure,
) {
  const { active$, scanDeadline$ } = graph;
  const { commit$, forgetDirty$, reconcile$ } = ports;
  const refresh$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (!get(active$)) {
        return;
      }
      set(model.inventory$, { type: "invalidate-round" });
      get(scanDeadline$)?.();
      set(scanDeadline$, null);
      await set(reconcile$, signal);
    },
  );
  const removed$ = command(
    async (
      { get, set },
      targetId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (!get(active$)) {
        return;
      }
      get(scanDeadline$)?.();
      set(scanDeadline$, null);
      set(forgetDirty$, targetId);
      set(commit$, { type: "closed", id: targetId }, true, signal);
      await set(reconcile$, signal);
    },
  );
  return { refresh$, removed$ };
}

function createDiscoveryCreation(
  model: DiscoveryModel,
  graph: DiscoveryState,
  ports: DiscoveryCommits & DiscoveryFailure,
) {
  const { active$, scan$, scanDeadline$, running$, fullWanted$ } = graph;
  const { commit$, forgetDirty$ } = ports;
  const beginCreation$ = command(({ get, set }, targetId: string) => {
    if (!get(active$)) {
      throw new CdpFault("tab", "The tab action is no longer current.");
    }
    const startedAt = performance.now();
    const inventory = set(model.inventory$, {
      type: "begin-creation",
      id: targetId,
      now: startedAt,
    });
    return {
      id: targetId,
      epoch: inventory.epoch,
      generation: inventory.entries.get(targetId)!.generation,
      order: inventory.sequence,
      startedAt,
    };
  });
  const created$ = command(
    (
      { get, set },
      target: ViewerTarget,
      observation: TargetObservation,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      if (!get(active$)) {
        return false;
      }
      set(forgetDirty$, target.id);
      set(commit$, { type: "created", target, observation }, true, signal);
      const scan = get(scan$);
      if (scan && !currentRound(get(model.inventoryState$), scan)) {
        get(scanDeadline$)?.();
        set(scanDeadline$, null);
        if (get(running$)) {
          set(fullWanted$, true);
        }
      }
      return get(model.snapshot$).targets.some((value) => {
        return value.id === target.id;
      });
    },
  );
  return { beginCreation$, created$ };
}

function createDiscoveryNativeEvents(
  model: DiscoveryModel,
  graph: DiscoveryState,
  ports: DiscoveryCommits & DiscoveryFailure & DiscoveryDrain,
) {
  const { active$, dirty$, fullWanted$ } = graph;
  const { reconcile$, forgetDirty$, commit$, drain$ } = ports;
  const event$ = command(
    async (
      { get, set },
      event: CdpEvent,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (!get(active$)) {
        return;
      }
      const info = event.params.targetInfo;
      const id =
        event.method === "Target.targetDestroyed"
          ? event.params.targetId
          : isRecord(info)
            ? info.targetId
            : undefined;
      if (
        typeof id !== "string" ||
        !id ||
        (event.method !== "Target.targetDestroyed" &&
          (!isRecord(info) || typeof info.type !== "string"))
      ) {
        await set(reconcile$, signal);
        return;
      }
      const target =
        event.method === "Target.targetDestroyed" ? null : pageTarget(info);
      const inventory = get(model.inventoryState$);
      const present = inventory.entries.has(id);
      if (!target) {
        if (
          !present &&
          (event.method !== "Target.targetDestroyed" || !inventory.round)
        ) {
          return;
        }
        set(forgetDirty$, id);
        set(commit$, { type: "retired", id }, present, signal);
      } else {
        set(
          commit$,
          { type: "metadata", target, now: performance.now() },
          true,
          signal,
        );
        set(dirty$, (dirty) => {
          return new Set(dirty).add(id);
        });
        if (!get(model.inventoryState$).ready) {
          set(fullWanted$, true);
        }
        await set(drain$, signal);
      }
    },
  );
  return { event$ };
}

function createDiscoveryClose(
  model: DiscoveryModel,
  graph: DiscoveryState,
  failure: DiscoveryFailure,
) {
  const {
    closed$,
    unwatchAbort$,
    dirty$,
    selected$,
    selectedFresh$,
    fullWanted$,
    epoch$,
  } = graph;
  const { cancelSelectedDeadline$, cancelInventoryDeadlines$ } = failure;
  const close$ = command(({ get, set }) => {
    if (get(closed$)) {
      return;
    }
    set(closed$, true);
    set(cancelSelectedDeadline$);
    set(cancelInventoryDeadlines$);
    get(unwatchAbort$)?.();
    set(unwatchAbort$, null);
    set(dirty$, new Set());
    set(selected$, null);
    set(selectedFresh$, false);
    set(fullWanted$, false);
    if (get(model.inventoryState$).epoch === get(epoch$)) {
      set(model.inventory$, { type: "reset" });
    }
  });

  return { close$ };
}

/** Connection-owned IO; construction captures identity and graph nodes only. */
export function createTargetDiscovery(
  directory: TargetDirectory,
  model: DiscoveryModel,
  options: DiscoveryOptions,
) {
  const graph = createDiscoveryState(model);
  const failure = createDiscoveryFailure(model, options, graph);
  const commits = createDiscoveryCommits(model, options, graph, failure);
  const observations = createDiscoveryObservations(model, graph);
  const readers = createDiscoveryReaders(directory, model, {
    ...observations,
    ...commits,
    ...failure,
  });
  const rounds = createDiscoveryRounds(
    model,
    graph,
    failure,
    observations,
    readers,
  );
  const queue = createDiscoveryQueue(graph, {
    ...readers,
    ...rounds,
    ...observations,
  });
  const drain = createDiscoveryDrain(graph, queue);
  const freshness = createSelectedFreshness(graph, failure);
  const selected = createSelectedReader(directory, model, graph, {
    ...observations,
    ...commits,
    ...failure,
    ...freshness,
  });
  const lifecycle = createDiscoveryLifecycle(model, options, graph, {
    ...failure,
    ...drain,
    ...freshness,
    ...selected,
  });
  const events = createDiscoveryEvents(model, graph, {
    ...commits,
    ...drain,
    ...failure,
  });
  const creation = createDiscoveryCreation(model, graph, {
    ...commits,
    ...failure,
  });
  const nativeEvents = createDiscoveryNativeEvents(model, graph, {
    ...commits,
    ...failure,
    ...drain,
  });
  const closing = createDiscoveryClose(model, graph, failure);
  return {
    active$: graph.active$,
    selectedTargetId$: graph.selectedTargetId$,
    ...lifecycle,
    ...events,
    ...creation,
    ...nativeEvents,
    ...closing,
  };
}
