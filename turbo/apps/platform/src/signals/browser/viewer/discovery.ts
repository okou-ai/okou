import { command, computed, state, type Command, type Computed } from "ccstate";
import { createDeferredPromise } from "../../utils.ts";
import { CdpFault, isRecord } from "../cdp/errors.ts";
import { pageTarget, type TargetDirectory } from "../cdp/targets.ts";
import type { CdpEvent } from "../cdp/client.ts";
import type { ViewerSnapshot, ViewerTarget } from "./types.ts";
import {
  currentObservation,
  currentRound,
  type InventoryEvent,
  type InventoryRound,
  type TargetInventory,
  type TargetObservation,
} from "./target-inventory.ts";

interface DiscoveryModel {
  readonly inventoryState$: Computed<TargetInventory>;
  readonly snapshot$: Computed<ViewerSnapshot>;
  readonly inventory$: Command<TargetInventory, [InventoryEvent]>;
}
interface DiscoveryOptions {
  readonly invalidated$: Command<void, [AbortSignal]>;
  readonly changed$: Command<void, [AbortSignal]>;
  readonly failed$: Command<void, [unknown, AbortSignal]>;
}

function createDiscoveryState(model: DiscoveryModel) {
  const dirty$ = state<ReadonlySet<string>>(new Set());
  const fullWanted$ = state(false);
  const running$ = state(false);
  const started$ = state(false);
  const closed$ = state(false);
  const initialized$ = state(false);
  const validating$ = state(true);
  const epoch$ = state<number | null>(null);
  const unwatchAbort$ = state<(() => void) | null>(null);
  const listeners$ = state<
    ReadonlySet<(result: PromiseSettledResult<void>) => void>
  >(new Set());
  const active$ = computed((get) => {
    return (
      get(started$) &&
      !get(closed$) &&
      get(epoch$) === get(model.inventoryState$).epoch
    );
  });
  const ready$ = computed((get) => {
    return (
      get(active$) && get(model.inventoryState$).ready && !get(validating$)
    );
  });
  const selectedTargetId$ = computed((get) => {
    const id = get(model.snapshot$).selectedTargetId;
    return get(ready$) &&
      id &&
      get(model.inventoryState$).entries.get(id)?.membership?.member
      ? id
      : null;
  });
  return {
    dirty$,
    fullWanted$,
    running$,
    started$,
    closed$,
    initialized$,
    validating$,
    epoch$,
    unwatchAbort$,
    listeners$,
    active$,
    ready$,
    selectedTargetId$,
  };
}
type DiscoveryState = ReturnType<typeof createDiscoveryState>;

function createDiscoveryLifecycle(
  nodes: DiscoveryState,
  model: DiscoveryModel,
  options: DiscoveryOptions,
) {
  const {
    closed$,
    unwatchAbort$,
    dirty$,
    fullWanted$,
    epoch$,
    active$,
    ready$,
    validating$,
  } = nodes;
  const close$ = command(({ get, set }) => {
    if (get(closed$)) {
      return;
    }
    set(closed$, true);
    get(unwatchAbort$)?.();
    set(unwatchAbort$, null);
    set(dirty$, new Set());
    set(fullWanted$, false);
    if (get(model.inventoryState$).epoch === get(epoch$)) {
      set(model.inventory$, { type: "reset" });
    }
  });
  const fail$ = command(({ get, set }, error: unknown, signal: AbortSignal) => {
    if (!get(active$) || signal.aborted) {
      return;
    }
    set(close$);
    set(options.failed$, error, signal);
  });
  const commit$ = command(
    ({ get, set }, event: InventoryEvent, signal: AbortSignal) => {
      set(model.inventory$, event);
      if (get(ready$)) {
        set(options.changed$, signal);
      }
    },
  );
  const observe$ = command(
    ({ get, set }, id: string): TargetObservation | null => {
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
          }
        : null;
    },
  );
  const accepts$ = command(
    ({ get }, observation: TargetObservation, round: InventoryRound | null) => {
      const inventory = get(model.inventoryState$);
      return (
        get(active$) &&
        (round ? currentRound(inventory, round) : !get(validating$)) &&
        currentObservation(inventory, observation)
      );
    },
  );
  const roundCurrent$ = command(({ get }, round: InventoryRound) => {
    return get(active$) && currentRound(get(model.inventoryState$), round);
  });
  return { close$, fail$, commit$, observe$, accepts$, roundCurrent$ };
}
type DiscoveryLifecycle = ReturnType<typeof createDiscoveryLifecycle>;

function createMembershipReader(
  directory: TargetDirectory,
  model: DiscoveryModel,
  lifecycle: DiscoveryLifecycle,
) {
  const { observe$, accepts$, commit$ } = lifecycle;
  return command(
    async (
      { get, set },
      id: string,
      round: InventoryRound | null,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const observation = set(observe$, id);
      if (!observation) {
        return;
      }
      const [result] = await Promise.allSettled([
        set(directory.contains$, id, signal),
      ]);
      signal.throwIfAborted();
      // N2: stale generations/rounds lose all authority before error classification.
      if (!set(accepts$, observation, round)) {
        return;
      }
      if (
        result.status === "rejected" &&
        (!(result.reason instanceof CdpFault) ||
          result.reason.kind !== "scope" ||
          get(model.snapshot$).selectedTargetId === id)
      ) {
        throw result.reason;
      }
      // Preserve main's background scope-fault classification as negative membership.
      // Native bridge/window validation remains fail-closed in assertWindow$/contains$.
      set(
        commit$,
        {
          type: "membership",
          observation,
          member: result.status === "fulfilled" && result.value,
        },
        signal,
      );
    },
  );
}
type MembershipReader = ReturnType<typeof createMembershipReader>;

function createMembershipReads(
  directory: TargetDirectory,
  model: DiscoveryModel,
  nodes: DiscoveryState,
  lifecycle: DiscoveryLifecycle,
  options: DiscoveryOptions,
) {
  const readMembership$ = createMembershipReader(directory, model, lifecycle);
  const { initialized$, validating$ } = nodes;
  const { roundCurrent$, commit$ } = lifecycle;
  const readRound$ = command(
    async (
      { get, set },
      round: InventoryRound,
      signal: AbortSignal,
    ): Promise<void> => {
      await set(directory.assertWindow$, signal);
      signal.throwIfAborted();
      if (!set(roundCurrent$, round)) {
        return;
      }
      if (!get(initialized$)) {
        const pages = await set(directory.read$, signal);
        signal.throwIfAborted();
        if (!set(roundCurrent$, round)) {
          return;
        }
        set(commit$, { type: "listed", round, targets: pages }, signal);
        set(initialized$, true);
      }
      const selected = get(model.snapshot$).selectedTargetId;
      const ids = [...get(model.inventoryState$).entries.keys()].sort(
        (a, b) => {
          return Number(b === selected) - Number(a === selected);
        },
      );
      for (let offset = 0; offset < ids.length; offset += 4) {
        const results = await Promise.allSettled(
          ids.slice(offset, offset + 4).map((id) => {
            return set(readMembership$, id, round, signal);
          }),
        );
        signal.throwIfAborted();
        if (!set(roundCurrent$, round)) {
          return;
        }
        const rejected = results.find((result) => {
          return result.status === "rejected";
        });
        if (rejected?.status === "rejected") {
          throw rejected.reason;
        }
      }
      if (!set(roundCurrent$, round)) {
        return;
      }
      set(model.inventory$, { type: "complete-round", round });
      set(validating$, false);
      set(options.changed$, signal);
    },
  );
  const readFull$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      const round = set(model.inventory$, { type: "begin-round" }).round!;
      const [result] = await Promise.allSettled([
        set(readRound$, round, signal),
      ]);
      signal.throwIfAborted();
      // Completion clears the round; only a still-current failed round may fail discovery.
      if (result.status === "rejected" && set(roundCurrent$, round)) {
        throw result.reason;
      }
    },
  );
  return { readMembership$, readFull$ };
}

function createDrainObservation(nodes: DiscoveryState) {
  const { running$, listeners$ } = nodes;
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
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
    set(listeners$, new Set(get(listeners$)).add(listener));
    using _listener = {
      [Symbol.dispose]: () => {
        const listeners = new Set(get(listeners$));
        listeners.delete(listener);
        set(listeners$, listeners);
      },
    };
    await event.promise;
    signal.throwIfAborted();
  });
}

function createDiscoveryDrain(
  nodes: DiscoveryState,
  lifecycle: DiscoveryLifecycle,
  readFull$: Command<Promise<void>, [AbortSignal]>,
  readMembership$: MembershipReader,
  waitForDrain$: Command<Promise<void>, [AbortSignal]>,
) {
  const { active$, fullWanted$, dirty$, running$, listeners$ } = nodes;
  const readWanted$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      while (get(active$) && (get(fullWanted$) || get(dirty$).size)) {
        signal.throwIfAborted();
        if (get(fullWanted$)) {
          set(fullWanted$, false);
          await set(readFull$, signal);
        } else {
          const dirty = new Set(get(dirty$));
          const ids = [...dirty].slice(0, 4);
          for (const id of ids) {
            dirty.delete(id);
          }
          set(dirty$, dirty);
          await Promise.all(
            ids.map((id) => {
              return set(readMembership$, id, null, signal);
            }),
          );
          signal.throwIfAborted();
        }
      }
    },
  );
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    if (get(running$)) {
      await set(waitForDrain$, signal);
      return;
    }
    if (!get(active$)) {
      return;
    }
    set(running$, true);
    let result: PromiseSettledResult<void> | null = null;
    using _drain = {
      [Symbol.dispose]: () => {
        // Settle original-wire observers even when cancellation exits this command.
        set(running$, false);
        const listeners = get(listeners$);
        set(listeners$, new Set());
        const completion: PromiseSettledResult<void> = result ?? {
          status: "rejected",
          reason: signal.reason,
        };
        for (const listener of listeners) {
          listener(completion);
        }
      },
    };
    [result] = await Promise.allSettled([set(readWanted$, signal)]);
    signal.throwIfAborted();
    if (result.status === "rejected") {
      set(lifecycle.fail$, result.reason, signal);
      throw result.reason;
    }
  });
}

function createDiscoveryRefresh(
  nodes: DiscoveryState,
  model: DiscoveryModel,
  options: DiscoveryOptions,
  drain$: Command<Promise<void>, [AbortSignal]>,
) {
  const { active$, validating$, fullWanted$ } = nodes;
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    if (!get(active$)) {
      return;
    }
    set(model.inventory$, { type: "invalidate-round" });
    if (!get(validating$)) {
      set(validating$, true);
      set(options.invalidated$, signal);
    }
    if (!get(active$)) {
      return;
    }
    set(fullWanted$, true);
    await set(drain$, signal);
  });
}

function createDiscoveryStart(
  nodes: DiscoveryState,
  model: DiscoveryModel,
  lifecycle: DiscoveryLifecycle,
  refresh$: Command<Promise<void>, [AbortSignal]>,
  waitForDrain$: Command<Promise<void>, [AbortSignal]>,
) {
  const { closed$, started$, epoch$, unwatchAbort$ } = nodes;
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    if (get(closed$)) {
      throw new CdpFault("connection", "Target discovery is closed.");
    }
    if (get(started$)) {
      await set(waitForDrain$, signal);
      return;
    }
    set(started$, true);
    set(epoch$, set(model.inventory$, { type: "reset" }).epoch);
    const abort = () => {
      set(lifecycle.close$);
    };
    signal.addEventListener("abort", abort, { once: true });
    set(unwatchAbort$, () => {
      return () => {
        signal.removeEventListener("abort", abort);
      };
    });
    await set(refresh$, signal);
  });
}

function createDiscoveryTargets(
  nodes: DiscoveryState,
  model: DiscoveryModel,
  lifecycle: DiscoveryLifecycle,
) {
  const { active$, dirty$, validating$, fullWanted$ } = nodes;
  const removed$ = command(
    ({ get, set }, id: string, signal: AbortSignal): void => {
      signal.throwIfAborted();
      if (!get(active$)) {
        return;
      }
      const dirty = new Set(get(dirty$));
      dirty.delete(id);
      set(dirty$, dirty);
      set(lifecycle.commit$, { type: "retired", id }, signal);
    },
  );
  const beginCreation$ = command(
    ({ get, set }, id: string): TargetObservation => {
      if (!get(active$)) {
        throw new CdpFault("tab", "The tab action is no longer current.");
      }
      const inventory = set(model.inventory$, { type: "begin-creation", id });
      return {
        id,
        epoch: inventory.epoch,
        generation: inventory.entries.get(id)!.generation,
        order: inventory.sequence,
      };
    },
  );
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
      const dirty = new Set(get(dirty$));
      dirty.delete(target.id);
      set(dirty$, dirty);
      set(lifecycle.commit$, { type: "created", target, observation }, signal);
      if (get(validating$)) {
        set(fullWanted$, true);
      }
      return (
        get(model.inventoryState$).entries.get(target.id)?.membership
          ?.member === true
      );
    },
  );
  return { removed$, beginCreation$, created$ };
}

function createDiscoveryEvents(
  nodes: DiscoveryState,
  model: DiscoveryModel,
  lifecycle: DiscoveryLifecycle,
  removed$: Command<void, [string, AbortSignal]>,
  drain$: Command<Promise<void>, [AbortSignal]>,
) {
  const { active$, dirty$ } = nodes;
  return command(
    async (
      { get, set },
      event: CdpEvent,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (!get(active$) || event.sessionId !== undefined) {
        return;
      }
      const info = event.params.targetInfo;
      const id =
        event.method === "Target.targetDestroyed"
          ? event.params.targetId
          : isRecord(info)
            ? info.targetId
            : undefined;
      if (typeof id !== "string" || !id) {
        return;
      }
      const target =
        event.method === "Target.targetDestroyed" ? null : pageTarget(info);
      const inventory = get(model.inventoryState$);
      const present = inventory.entries.has(id);
      if (!target) {
        if (!present && !inventory.round) {
          return;
        }
        set(removed$, id, signal);
      } else {
        set(lifecycle.commit$, { type: "metadata", target }, signal);
        if (!present) {
          set(dirty$, new Set(get(dirty$)).add(id));
          await set(drain$, signal);
        }
      }
    },
  );
}

/** One cold snapshot, owning target events, and bounded native invalidations. */
export function createTargetDiscovery(
  directory: TargetDirectory,
  model: DiscoveryModel,
  options: DiscoveryOptions,
) {
  const nodes = createDiscoveryState(model);
  const lifecycle = createDiscoveryLifecycle(nodes, model, options);
  const { readMembership$, readFull$ } = createMembershipReads(
    directory,
    model,
    nodes,
    lifecycle,
    options,
  );
  const waitForDrain$ = createDrainObservation(nodes);
  const drain$ = createDiscoveryDrain(
    nodes,
    lifecycle,
    readFull$,
    readMembership$,
    waitForDrain$,
  );
  const refresh$ = createDiscoveryRefresh(nodes, model, options, drain$);
  const start$ = createDiscoveryStart(
    nodes,
    model,
    lifecycle,
    refresh$,
    waitForDrain$,
  );
  const targets = createDiscoveryTargets(nodes, model, lifecycle);
  const event$ = createDiscoveryEvents(
    nodes,
    model,
    lifecycle,
    targets.removed$,
    drain$,
  );
  return {
    active$: nodes.active$,
    ready$: nodes.ready$,
    selectedTargetId$: nodes.selectedTargetId$,
    start$,
    refresh$,
    ...targets,
    event$,
    close$: lifecycle.close$,
  };
}
