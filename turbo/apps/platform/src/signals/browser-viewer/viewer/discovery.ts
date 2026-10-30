import { createStore } from "ccstate";
import { timeout } from "signal-timers";
import { resetSignal, setLoop, detach, Reason } from "../../utils.ts";

import { CdpFault, isRecord } from "../cdp/errors.ts";
import { pageTarget, type TargetDirectory } from "../cdp/targets.ts";

import type { CdpEvent } from "../cdp/client.ts";
import type { ViewerModel } from "./model.ts";
import type { ViewerTarget } from "./types.ts";
import {
  currentObservation,
  currentRound,
  inventoryExpiry,
  type InventoryEvent,
  type InventoryRound,
  type TargetObservation,
} from "./target-inventory.ts";

const selectedIntervalMs = 2000;
const selectedFreshnessMs = 12_000;
const inventoryIntervalMs = 10_000;
const inventoryRoundMs = 10_000;

const resetScan$ = resetSignal();
const resetInventoryExpiry$ = resetSignal();
const resetSelectedExpiry$ = resetSignal();

interface Scan {
  readonly round: InventoryRound;
  readonly signal: AbortSignal;
}

interface Selected {
  readonly targetId: string;
  readonly order: number;
  verifiedAt: number;
  pending: boolean;
}

interface DiscoveryOptions {
  readonly signal: AbortSignal;
  readonly scoped: boolean;
  readonly changed: () => void;
  readonly failed: (error: unknown) => void;
}

/** Connection-owned IO; the model alone owns target facts and their projection. */
export class TargetDiscovery {
  private readonly store = createStore();
  private readonly dirty = new Set<string>();
  private scan: Scan | null = null;
  private inventoryDeadline: AbortSignal | undefined;
  private selected: Selected | null = null;
  private fullWanted = false;
  private running = false;
  private closed = false;
  private epoch: number | null = null;

  constructor(
    private readonly directory: TargetDirectory,
    private readonly model: ViewerModel,
    private readonly options: DiscoveryOptions,
  ) {}

  private state() {
    return this.model.inventoryState();
  }

  start(): void {
    this.epoch = this.model.inventory({ type: "reset" }).epoch;
    if (this.options.scoped) {
      setLoop(
        () => {
          this.reconcile();
          return !this.active();
        },
        inventoryIntervalMs,
        this.options.signal,
        { testIntervalMs: inventoryIntervalMs },
      );
      setLoop(
        () => {
          this.checkSelected();
          return !this.active();
        },
        selectedIntervalMs,
        this.options.signal,
        { testIntervalMs: selectedIntervalMs },
      );
    } else {
      this.reconcile();
    }
  }

  watch(targetId: string | null): void {
    this.store.set(resetSelectedExpiry$);
    this.selected = null;
    if (targetId && this.options.scoped) {
      const selected: Selected = {
        targetId,
        order: this.state().sequence,
        pending: false,
        verifiedAt: performance.now(),
      };
      this.selected = selected;
      this.expireSelected(selected);
    }
  }

  current(targetId: string): boolean {
    return (
      this.active() &&
      (!this.options.scoped ||
        (this.selected?.targetId === targetId &&
          performance.now() - this.selected.verifiedAt < selectedFreshnessMs))
    );
  }

  refresh(): void {
    if (!this.active()) {
      return;
    }
    this.model.inventory({ type: "invalidate-round" });
    this.store.set(resetScan$);
    this.reconcile();
  }

  removed(targetId: string): void {
    if (!this.active()) {
      return;
    }
    this.store.set(resetScan$);
    this.dirty.delete(targetId);
    this.commit({ type: "closed", id: targetId });
    this.reconcile();
  }

  beginCreation(targetId: string): TargetObservation {
    if (!this.active()) {
      throw new CdpFault("tab", "The tab action is no longer current.");
    }
    const startedAt = performance.now();
    const state = this.model.inventory({
      type: "begin-creation",
      id: targetId,
      now: startedAt,
    });
    return {
      id: targetId,
      epoch: state.epoch,
      generation: state.entries.get(targetId)!.generation,
      order: state.sequence,
      startedAt,
    };
  }

  created(target: ViewerTarget, observation: TargetObservation): boolean {
    if (!this.active()) {
      return false;
    }
    this.dirty.delete(target.id);
    this.commit({ type: "created", target, observation });
    if (this.scan && !currentRound(this.state(), this.scan.round)) {
      this.store.set(resetScan$);
      if (this.running) {
        this.fullWanted = true;
      }
    }
    return this.model.getSnapshot().targets.some((value) => {
      return value.id === target.id;
    });
  }

  event(event: CdpEvent): void {
    if (!this.active()) {
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
      this.reconcile();
      return;
    }
    const target =
      event.method === "Target.targetDestroyed" ? null : pageTarget(info);
    const present = this.state().entries.has(id);
    if (!target) {
      if (
        !present &&
        (event.method !== "Target.targetDestroyed" || !this.state().round)
      ) {
        return;
      }
      this.dirty.delete(id);
      this.commit({ type: "retired", id }, present);
    } else {
      this.commit({ type: "metadata", target, now: performance.now() });
      this.dirty.add(id);
      if (!this.state().ready) {
        this.fullWanted = true;
      }
      this.pump();
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.store.set(resetSelectedExpiry$);
    this.store.set(resetScan$);
    this.store.set(resetInventoryExpiry$);
    this.dirty.clear();
    this.selected = null;
    this.fullWanted = false;
    if (this.state().epoch === this.epoch) {
      this.model.inventory({ type: "reset" });
    }
  }

  private active(): boolean {
    return (
      !this.closed &&
      !this.options.signal.aborted &&
      this.epoch === this.state().epoch
    );
  }

  private commit(event: InventoryEvent, notify = true): void {
    const targets = this.model.getSnapshot().targets;
    const ready = this.state().ready;
    this.model.inventory(event);
    this.expireInventory();
    if (
      notify &&
      (targets !== this.model.getSnapshot().targets ||
        (!ready && this.state().ready))
    ) {
      this.publish();
    }
  }

  private observe(id: string): TargetObservation | null {
    if (!this.active()) {
      return null;
    }
    const state = this.model.inventory({ type: "order" });
    const entry = state.entries.get(id);
    return entry
      ? {
          id,
          epoch: state.epoch,
          generation: entry.generation,
          order: state.sequence,
          startedAt: performance.now(),
        }
      : null;
  }

  private reconcile(): void {
    if (!this.active()) {
      return;
    }
    this.fullWanted = true;
    this.pump();
  }

  private pump(): void {
    if (!this.active() || this.running) {
      return;
    }
    detach(
      (async () => {
        const [reply1] = await Promise.allSettled([this.drain()]);
        if (reply1.status === "fulfilled") {
          return reply1.value;
        }
        const error = reply1.reason;
        return this.fail(error);
      })(),
      Reason.DomCallback,
      "browser operation",
    );
  }

  private async drain(): Promise<void> {
    this.running = true;
    const [completion1] = await Promise.allSettled([
      (async (): Promise<void> => {
        while (this.active() && (this.fullWanted || this.dirty.size)) {
          if (this.fullWanted) {
            this.fullWanted = false;
            await this.readFull();
          } else {
            await this.readDirty();
          }
        }
      })(),
    ]);

    this.running = false;

    if (completion1.status === "rejected") {
      throw completion1.reason;
    }
    return completion1.value;
  }

  private async readFull(): Promise<void> {
    const state = this.model.inventory({
      type: "begin-round",
      now: performance.now(),
    });
    const scan: Scan = {
      round: state.round!,
      signal: this.store.set(resetScan$, this.options.signal),
    };
    this.scan = scan;
    const current = () => {
      return this.active() && currentRound(this.state(), scan.round);
    };
    timeout(
      () => {
        if (current()) {
          this.fail(
            new CdpFault(
              "scope",
              "Window inventory could not be verified in time.",
            ),
          );
        }
      },
      inventoryRoundMs,
      { signal: scan.signal },
    );
    const [completion2] = await Promise.allSettled([
      (async (): Promise<void> => {
        const [operation2] = await Promise.allSettled([
          (async (): Promise<void> => {
            const pages = await this.directory.read();
            if (!current()) {
              return;
            }
            this.commit({ type: "listed", round: scan.round, targets: pages });
            if (!current()) {
              return;
            }
            for (let offset = 0; offset < pages.length; offset += 4) {
              await Promise.all(
                pages.slice(offset, offset + 4).map(async (target) => {
                  const observation = this.observe(target.id);
                  if (!observation) {
                    return;
                  }
                  await this.readMembership(observation, current);
                }),
              );
              if (!current()) {
                return;
              }
            }
            this.commit({ type: "complete-round", round: scan.round });
          })(),
        ]);
        if (operation2.status === "fulfilled") {
          return operation2.value;
        }
        const error: unknown = operation2.reason;

        if (current()) {
          this.fail(error);
        }
      })(),
    ]);

    if (this.scan === scan) {
      this.store.set(resetScan$);
      this.scan = null;
    }

    if (completion2.status === "rejected") {
      throw completion2.reason;
    }
    return completion2.value;
  }

  private expireInventory(): void {
    if (!this.active() || !this.options.scoped) {
      return;
    }
    this.store.set(resetInventoryExpiry$);
    const expiresAt = inventoryExpiry(this.state());
    if (expiresAt === null) {
      return;
    }
    const remaining = expiresAt - performance.now();
    const deadline = this.store.set(resetInventoryExpiry$, this.options.signal);
    timeout(
      () => {
        if (this.active() && this.inventoryDeadline === deadline) {
          this.fail(
            new CdpFault(
              "scope",
              "Window inventory could not be verified in time.",
            ),
          );
        }
      },
      Math.max(0, remaining),
      { signal: deadline },
    );
    this.inventoryDeadline = deadline;
  }

  private async readDirty(): Promise<void> {
    const batch: string[] = [];
    for (const id of this.dirty) {
      batch.push(id);
      this.dirty.delete(id);
      if (batch.length === 4) {
        break;
      }
    }
    await Promise.all(
      batch.map(async (id) => {
        const observation = this.observe(id);
        if (!observation) {
          return;
        }
        await this.readMembership(observation, () => {
          return this.active();
        });
      }),
    );
  }

  private async readMembership(
    observation: TargetObservation,
    current: () => boolean,
  ): Promise<void> {
    const accepts = () => {
      return (
        current() &&
        currentObservation(this.state(), observation) &&
        // A new selection performs its own fresh activation/attachment checks.
        !(
          this.selected?.targetId === observation.id &&
          observation.order <= this.selected.order
        )
      );
    };
    const [result] = await Promise.allSettled([
      this.directory.contains(observation.id),
    ]);
    let member = result.status === "fulfilled" && result.value;
    if (result.status === "rejected") {
      const error: unknown = result.reason;

      if (!accepts()) {
        return;
      }
      if (
        !(error instanceof CdpFault) ||
        error.kind !== "scope" ||
        this.model.getSnapshot().selectedTargetId === observation.id
      ) {
        this.fail(error);
        return;
      }
      // Unknown background membership revokes only that page's admission.
      member = false;
    }
    if (accepts()) {
      this.commit({ type: "membership", observation, member });
    }
  }

  private checkSelected(): void {
    const selected = this.selected;
    if (!this.active() || !selected || selected.pending) {
      return;
    }
    if (!this.current(selected.targetId)) {
      this.staleSelected();
      return;
    }
    selected.pending = true;
    detach(
      (async () => {
        const [reply2] = await Promise.allSettled([
          this.readSelected(selected),
        ]);
        if (reply2.status === "fulfilled") {
          return reply2.value;
        }
        const error = reply2.reason;

        if (this.active() && this.selected === selected) {
          this.fail(error);
        }

        return;
      })(),
      Reason.DomCallback,
      "browser operation",
    );
  }

  private async readSelected(selected: Selected): Promise<void> {
    const observation = this.observe(selected.targetId);
    const [completion3] = await Promise.allSettled([
      (async (): Promise<void> => {
        const [operation3] = await Promise.allSettled([
          (async (): Promise<void> => {
            if (!observation) {
              return;
            }
            const member = await this.directory.contains(selected.targetId);
            if (!this.active() || this.selected !== selected) {
              return;
            }
            if (!this.current(selected.targetId)) {
              this.staleSelected();
              return;
            }
            this.commit({ type: "membership", observation, member });
            if (this.selected !== selected) {
              return;
            }
            const entry = this.state().entries.get(selected.targetId);
            if (
              entry?.generation === observation.generation &&
              entry.membership?.member
            ) {
              selected.verifiedAt = Math.max(
                selected.verifiedAt,
                entry.membership.startedAt,
              );
              this.expireSelected(selected);
            }
          })(),
        ]);
        if (operation3.status === "fulfilled") {
          return operation3.value;
        }
        const error: unknown = operation3.reason;

        if (
          observation &&
          this.active() &&
          this.selected === selected &&
          currentObservation(this.state(), observation)
        ) {
          this.fail(error);
        }
      })(),
    ]);

    selected.pending = false;

    if (completion3.status === "rejected") {
      throw completion3.reason;
    }
    return completion3.value;
  }

  private expireSelected(selected: Selected): void {
    const signal = this.store.set(resetSelectedExpiry$, this.options.signal);
    timeout(
      () => {
        if (this.active() && this.selected === selected) {
          this.staleSelected();
        }
      },
      Math.max(
        0,
        selected.verifiedAt + selectedFreshnessMs - performance.now(),
      ),
      { signal },
    );
  }

  private staleSelected(): void {
    this.fail(
      new CdpFault(
        "scope",
        "Selected window membership could not be verified in time.",
      ),
    );
  }

  private publish(): void {
    if (this.active() && this.state().ready) {
      this.options.changed();
    }
  }

  private fail(error: unknown): void {
    if (!this.active()) {
      return;
    }
    this.store.set(resetScan$);
    this.store.set(resetInventoryExpiry$);
    this.fullWanted = false;
    this.dirty.clear();
    this.epoch = this.model.inventory({ type: "reset" }).epoch;
    this.options.failed(error);
  }
}
