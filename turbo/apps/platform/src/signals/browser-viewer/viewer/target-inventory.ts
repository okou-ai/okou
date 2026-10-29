import { CdpFault } from "../cdp/errors.ts";
import type { ViewerTarget } from "./types.ts";

const inventoryFreshnessMs = 20_000;
// Retained UTF-16 text plus an allowance for each entry's bookkeeping. This is
// resource accounting, not a heap measurement or a browser target-count limit.
const inventoryBudgetBytes = 16 * 1024 * 1024;

interface Membership {
  readonly order: number;
  readonly startedAt: number;
  readonly member: boolean;
}

interface InventoryEntry {
  readonly generation: number;
  readonly target: ViewerTarget | null;
  readonly metadataOrder: number;
  readonly membership: Membership | null;
  readonly expiresAt: number;
}

export interface InventoryRound {
  readonly order: number;
  readonly epoch: number;
  readonly startedAt: number;
  readonly changed: ReadonlySet<string>;
  readonly changedBytes: number;
}

export interface TargetObservation {
  readonly id: string;
  readonly generation: number;
  readonly epoch: number;
  readonly order: number;
  readonly startedAt: number;
}

export interface TargetInventory {
  readonly sequence: number;
  readonly epoch: number;
  readonly entries: ReadonlyMap<string, InventoryEntry>;
  readonly round: InventoryRound | null;
  readonly ready: boolean;
  readonly startedAt: number | null;
}

export type InventoryEvent =
  | { readonly type: "reset" | "order" | "invalidate-round" }
  | { readonly type: "begin-round"; readonly now: number }
  | {
      readonly type: "listed";
      readonly round: InventoryRound;
      readonly targets: readonly ViewerTarget[];
    }
  | { readonly type: "complete-round"; readonly round: InventoryRound }
  | {
      readonly type: "metadata";
      readonly target: ViewerTarget;
      readonly now: number;
    }
  | { readonly type: "retired" | "closed"; readonly id: string }
  | {
      readonly type: "begin-creation";
      readonly id: string;
      readonly now: number;
    }
  | {
      readonly type: "membership";
      readonly observation: TargetObservation;
      readonly member: boolean;
    }
  | {
      readonly type: "created";
      readonly observation: TargetObservation;
      readonly target: ViewerTarget;
    };

export function initialInventory(): TargetInventory {
  return {
    sequence: 0,
    epoch: 0,
    entries: new Map(),
    round: null,
    ready: false,
    startedAt: null,
  };
}

export function currentRound(
  state: TargetInventory,
  round: InventoryRound,
): boolean {
  return state.epoch === round.epoch && state.round?.order === round.order;
}

export function currentObservation(
  state: TargetInventory,
  observation: TargetObservation,
): boolean {
  const entry = state.entries.get(observation.id);
  return (
    state.epoch === observation.epoch &&
    entry?.generation === observation.generation &&
    (entry.membership?.order ?? -1) <= observation.order
  );
}

export function inventoryTargets(
  state: TargetInventory,
): readonly ViewerTarget[] {
  if (!state.ready) {
    return Object.freeze([]);
  }
  return Object.freeze(
    [...state.entries.values()].flatMap((entry) => {
      return entry.target && entry.membership?.member ? [entry.target] : [];
    }),
  );
}

export function inventoryExpiry(state: TargetInventory): number | null {
  if (state.startedAt === null) {
    return null;
  }
  let expiry = state.startedAt + inventoryFreshnessMs;
  for (const entry of state.entries.values()) {
    expiry = Math.min(expiry, entry.expiresAt);
  }
  return expiry;
}

function journal(state: TargetInventory, id: string): InventoryRound | null {
  const round = state.round;
  if (!round || round.changed.has(id)) {
    return round;
  }
  const changedBytes = round.changedBytes + 64 + id.length * 2;
  if (changedBytes > inventoryBudgetBytes) {
    throw new CdpFault(
      "protocol",
      "Browser target changes exceed the discovery memory budget.",
    );
  }
  return { ...round, changed: new Set(round.changed).add(id), changedBytes };
}

function bounded(entries: ReadonlyMap<string, InventoryEntry>): void {
  let bytes = 0;
  for (const [id, entry] of entries) {
    bytes += 256 + (id.length + (entry.target?.title.length ?? 0)) * 2;
    if (bytes > inventoryBudgetBytes) {
      throw new CdpFault(
        "protocol",
        "Browser target inventory exceeds the discovery memory budget.",
      );
    }
  }
}

/** Pure transitions: titles, target lifetimes and scope proofs have separate authority. */
export function transitionInventory(
  state: TargetInventory,
  event: InventoryEvent,
): TargetInventory {
  const order = state.sequence + 1;
  switch (event.type) {
    case "reset": {
      return { ...initialInventory(), sequence: order, epoch: state.epoch + 1 };
    }
    case "order": {
      return { ...state, sequence: order };
    }
    case "invalidate-round": {
      return { ...state, sequence: order, round: null };
    }
    case "begin-round": {
      return {
        ...state,
        sequence: order,
        round: {
          order,
          epoch: state.epoch,
          startedAt: event.now,
          changed: new Set(),
          changedBytes: 0,
        },
      };
    }
    case "metadata": {
      return updateInventoryMetadata(state, event);
    }
    case "begin-creation": {
      return beginCreation(state, event);
    }
    case "retired":
    case "closed": {
      const entries = new Map(state.entries);
      entries.delete(event.id);
      return {
        ...state,
        sequence: order,
        entries,
        round: event.type === "closed" ? null : journal(state, event.id),
      };
    }
    case "listed": {
      return listInventory(state, event);
    }
    case "complete-round": {
      return currentRound(state, event.round)
        ? {
            ...state,
            sequence: order,
            round: null,
            ready: true,
            startedAt: event.round.startedAt,
          }
        : state;
    }
    case "membership":
    case "created": {
      return updateInventoryMembership(state, event);
    }
  }
}

function updateInventoryMetadata(
  state: TargetInventory,
  event: Extract<InventoryEvent, { type: "metadata" }>,
): TargetInventory {
  const order = state.sequence + 1;
  const previous = state.entries.get(event.target.id);
  const entries = new Map(state.entries);
  entries.set(event.target.id, {
    generation: previous?.generation ?? order,
    target: event.target,
    metadataOrder: order,
    membership: previous?.membership ?? null,
    expiresAt: previous?.expiresAt ?? event.now + inventoryFreshnessMs,
  });
  bounded(entries);
  return {
    ...state,
    sequence: order,
    entries,
    round: previous ? state.round : journal(state, event.target.id),
  };
}

function beginCreation(
  state: TargetInventory,
  event: Extract<InventoryEvent, { type: "begin-creation" }>,
): TargetInventory {
  const order = state.sequence + 1;
  if (state.entries.has(event.id)) {
    return { ...state, sequence: order, round: journal(state, event.id) };
  }
  const entries = new Map(state.entries);
  entries.set(event.id, {
    generation: order,
    target: null,
    metadataOrder: 0,
    membership: null,
    expiresAt: event.now + inventoryFreshnessMs,
  });
  bounded(entries);
  return {
    ...state,
    sequence: order,
    entries,
    round: journal(state, event.id),
  };
}

function listInventory(
  state: TargetInventory,
  event: Extract<InventoryEvent, { type: "listed" }>,
): TargetInventory {
  const order = state.sequence + 1;
  if (!currentRound(state, event.round)) {
    return state;
  }
  const entries = new Map(state.entries);
  const ids = new Set(
    event.targets.map((target) => {
      return target.id;
    }),
  );
  const changed = state.round!.changed;
  removeMissingInventory(entries, ids, event.round);
  let sequence = order;
  for (const target of event.targets) {
    const previous = entries.get(target.id);
    if (!previous && changed.has(target.id)) {
      continue;
    }
    entries.set(target.id, {
      generation: previous?.generation ?? ++sequence,
      target:
        previous && previous.metadataOrder > event.round.order
          ? previous.target
          : target,
      metadataOrder: Math.max(previous?.metadataOrder ?? 0, event.round.order),
      membership: previous?.membership ?? null,
      expiresAt:
        previous?.expiresAt ?? event.round.startedAt + inventoryFreshnessMs,
    });
  }
  bounded(entries);
  return { ...state, sequence, entries };
}

function updateInventoryMembership(
  state: TargetInventory,
  event: Extract<InventoryEvent, { type: "membership" | "created" }>,
): TargetInventory {
  const order = state.sequence + 1;
  const observation = event.observation;
  const previous = state.entries.get(observation.id);
  if (
    state.epoch !== observation.epoch ||
    previous?.generation !== observation.generation
  ) {
    return state;
  }
  const current = currentObservation(state, observation);
  if (event.type === "membership" && !current) {
    return state;
  }
  const entries = new Map(state.entries);
  entries.set(observation.id, {
    ...previous,
    target:
      event.type === "created" && previous.metadataOrder <= observation.order
        ? event.target
        : previous.target,
    metadataOrder:
      event.type === "created"
        ? Math.max(previous.metadataOrder, observation.order)
        : previous.metadataOrder,
    membership: current
      ? {
          order: observation.order,
          startedAt: observation.startedAt,
          member: event.type === "created" || event.member,
        }
      : previous.membership,
    expiresAt: current
      ? observation.startedAt + inventoryFreshnessMs
      : previous.expiresAt,
  });
  if (event.type === "created") {
    bounded(entries);
  }
  return {
    ...state,
    sequence: order,
    entries,
    round: event.type === "created" ? null : state.round,
  };
}

function removeMissingInventory(
  entries: Map<string, InventoryEntry>,
  ids: ReadonlySet<string>,
  round: InventoryRound,
): void {
  const changed = round.changed;
  for (const [id, entry] of entries) {
    if (
      !ids.has(id) &&
      !changed.has(id) &&
      entry.metadataOrder <= round.order &&
      (entry.membership?.order ?? 0) <= round.order
    ) {
      entries.delete(id);
    }
  }
}
