import { scheduleTimeout, detach, Reason } from "../../utils.ts";
import { CdpFault, isRecord } from "../cdp/errors.ts";
import { pageTarget, type TargetDirectory } from "../cdp/targets.ts";
import type { CdpEvent } from "../cdp/client.ts";
import type { ViewerModel } from "./model.ts";
import type { ViewerTarget } from "./types.ts";
import {
  currentObservation,
  currentRound,
  type InventoryEvent,
  type TargetObservation,
} from "./target-inventory.ts";

interface DiscoveryOptions {
  readonly signal: AbortSignal;
  readonly changed: () => void;
  readonly invalidated: () => void;
  readonly failed: (error: unknown) => void;
}

/** One cold snapshot, owning target events, and bounded native invalidations. */
export class TargetDiscovery {
  private readonly dirty = new Set<string>();
  private fullWanted = false;
  private running = false;
  private closed = false;
  private initialized = false;
  private validating = true;
  private epoch: number | null = null;
  private deadline: (() => void) | undefined;

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
    this.refresh();
  }

  get ready(): boolean {
    return this.active() && this.state().ready && !this.validating;
  }

  current(targetId: string): boolean {
    return (
      this.ready &&
      this.state().entries.get(targetId)?.membership?.member === true
    );
  }

  refresh(): void {
    if (!this.active()) {
      return;
    }
    this.model.inventory({ type: "invalidate-round" });
    if (!this.validating) {
      this.validating = true;
      this.options.invalidated();
    }
    if (!this.active()) {
      return;
    }
    // Repeated events do not extend the deadline for regaining authority.
    this.deadline ??= scheduleTimeout(
      () => {
        this.fail(
          new CdpFault(
            "scope",
            "Window inventory could not be verified in time.",
          ),
        );
      },
      10_000,
      this.options.signal,
    );
    this.fullWanted = true;
    this.pump();
  }

  removed(targetId: string): void {
    if (!this.active()) {
      return;
    }
    this.dirty.delete(targetId);
    this.commit({ type: "retired", id: targetId });
  }

  beginCreation(targetId: string): TargetObservation {
    if (!this.active()) {
      throw new CdpFault("tab", "The tab action is no longer current.");
    }
    const state = this.model.inventory({
      type: "begin-creation",
      id: targetId,
    });
    return {
      id: targetId,
      epoch: state.epoch,
      generation: state.entries.get(targetId)!.generation,
      order: state.sequence,
    };
  }

  created(target: ViewerTarget, observation: TargetObservation): boolean {
    if (!this.active()) {
      return false;
    }
    this.dirty.delete(target.id);
    this.commit({ type: "created", target, observation });
    if (this.validating) {
      this.fullWanted = true;
      this.pump();
    }
    return this.state().entries.get(target.id)?.membership?.member === true;
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
    if (typeof id !== "string" || !id) {
      return;
    }
    const target =
      event.method === "Target.targetDestroyed" ? null : pageTarget(info);
    const present = this.state().entries.has(id);
    if (!target) {
      // Journal even an unknown destruction during the cold snapshot.
      if (!present && !this.state().round) {
        return;
      }
      this.dirty.delete(id);
      this.commit({ type: "retired", id });
    } else {
      this.commit({ type: "metadata", target });
      if (!present) {
        this.dirty.add(id);
        this.pump();
      }
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.deadline?.();
    this.dirty.clear();
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

  private commit(event: InventoryEvent): void {
    this.model.inventory(event);
    if (this.ready) {
      this.options.changed();
    }
  }

  private observe(id: string): TargetObservation | null {
    const state = this.model.inventory({ type: "order" });
    const entry = state.entries.get(id);
    return entry
      ? {
          id,
          epoch: state.epoch,
          generation: entry.generation,
          order: state.sequence,
        }
      : null;
  }

  private pump(): void {
    if (!this.active() || this.running) {
      return;
    }
    this.running = true;
    detach(this.drain(), Reason.DomCallback, "browser inventory");
  }

  private async drain(): Promise<void> {
    const [result] = await Promise.allSettled([
      (async () => {
        while (this.active() && (this.fullWanted || this.dirty.size)) {
          if (this.fullWanted) {
            this.fullWanted = false;
            await this.readFull();
          } else {
            const ids = [...this.dirty].slice(0, 4);
            for (const id of ids) {
              this.dirty.delete(id);
            }
            await Promise.all(
              ids.map((id) => {
                return this.readMembership(id, () => {
                  return this.active() && !this.validating;
                });
              }),
            );
          }
        }
      })(),
    ]);
    this.running = false;
    if (result.status === "rejected") {
      this.fail(result.reason);
    }
  }

  private async readFull(): Promise<void> {
    const round = this.model.inventory({
      type: "begin-round",
    }).round!;
    const current = () => {
      return this.active() && currentRound(this.state(), round);
    };
    const [result] = await Promise.allSettled([
      (async () => {
        await this.directory.assertWindow();
        if (!current()) {
          return;
        }
        if (!this.initialized) {
          const targets = await this.directory.read();
          if (!current()) {
            return;
          }
          this.commit({ type: "listed", round, targets });
          this.initialized = true;
        }
        const selected = this.model.getSnapshot().selectedTargetId;
        const ids = [...this.state().entries.keys()].sort((a, b) => {
          return Number(b === selected) - Number(a === selected);
        });
        for (let offset = 0; offset < ids.length; offset += 4) {
          await Promise.all(
            ids.slice(offset, offset + 4).map((id) => {
              return this.readMembership(id, current);
            }),
          );
          if (!current()) {
            return;
          }
        }
        if (!current()) {
          return;
        }
        this.model.inventory({ type: "complete-round", round });
        this.validating = false;
        this.deadline?.();
        this.deadline = undefined;
        this.options.changed();
      })(),
    ]);
    if (result.status === "rejected" && current()) {
      throw result.reason;
    }
  }

  private async readMembership(
    id: string,
    current: () => boolean,
  ): Promise<void> {
    const observation = this.observe(id);
    if (!observation) {
      return;
    }
    const [result] = await Promise.allSettled([this.directory.contains(id)]);
    if (!current() || !currentObservation(this.state(), observation)) {
      return;
    }
    if (
      result.status === "rejected" &&
      (!(result.reason instanceof CdpFault) || result.reason.kind !== "scope")
    ) {
      throw result.reason;
    }
    this.commit({
      type: "membership",
      observation,
      member: result.status === "fulfilled" && result.value,
    });
  }

  private fail(error: unknown): void {
    if (!this.active()) {
      return;
    }
    this.close();
    this.options.failed(error);
  }
}
