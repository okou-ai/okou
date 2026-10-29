import type { Protocol } from "devtools-protocol";
import type { CdpClient } from "../cdp/client.ts";
import { CdpFault, requestDetails } from "../cdp/errors.ts";
import {
  constrainDisplay,
  nativePresentation,
  projectDisplay,
  windowPresentation,
  type DisplaySize,
} from "./geometry.ts";

import type {
  DisplayDecision,
  DisplayOutcome,
  DisplayStage,
} from "./policy.ts";
import type { NativeCapture, PresentationReceipt } from "./viewport.ts";
import {
  DisplayPreparation,
  type DisplaySnapshot,
  type DisplayTarget,
} from "./preparation.ts";

import { frameTimeoutMs } from "./limits.ts";
import { captureBoundary } from "./capture-boundary.ts";

export interface DisplayEffects {
  readonly signal: AbortSignal;
  readonly presentationTimeout?: number | undefined;
  readonly windowId: number | undefined;
  readonly capturePending: () => boolean;
  readonly refresh: (prepare: () => Promise<void>) => Promise<void>;
}

interface ExecutionPolicy {
  readonly decide: (windowId: number) => DisplayDecision | null;
  readonly prepared: () => boolean;
  readonly stage: (
    stage: Exclude<DisplayStage, "preparing" | "prepared">,
  ) => boolean;
}

export type DisplayResult =
  | Extract<DisplayOutcome, { readonly kind: "completed" }>
  | { readonly kind: "deferred" | "retired" }
  | { readonly kind: "failed"; readonly error: CdpFault };

type Mutation =
  | { readonly kind: "none" | "applied" }
  | { readonly kind: "pending"; readonly rejected: () => void };

function projection(
  windowId: number,
  decision: DisplayDecision,
  remote: DisplaySize,
  layout: Protocol.Page.GetLayoutMetricsResponse,
) {
  const size = constrainDisplay(
    decision.kind === "fit"
      ? decision.size
      : {
          width: (remote.width * remote.dpr) / decision.dpr,
          height: (remote.height * remote.dpr) / decision.dpr,
          dpr: decision.dpr,
        },
  );
  return { size, projected: projectDisplay(windowId, size, layout) };
}

interface AppliedReceipt {
  readonly windowId: number;
  readonly prepared: ReturnType<typeof projection>;
  readonly presentation: PresentationReceipt;
}

/** One selected lifetime's native effects and applied receipt, never window policy. */
export class DisplayTransaction {
  private applied: AppliedReceipt | undefined;
  private readonly preparation: DisplayPreparation;

  constructor(
    private readonly client: CdpClient,
    private readonly target: DisplayTarget,
    private readonly host: DisplayEffects,
    private readonly ownsTarget: () => boolean,
  ) {
    this.preparation = new DisplayPreparation(
      client,
      target,
      host.windowId,
      () => {
        return this.current();
      },
      () => {
        return this.fenceCapture("native");
      },
    );
  }

  private current(): boolean {
    return (
      !this.host.signal.aborted && this.ownsTarget() && this.target.current()
    );
  }

  private decision(
    policy: ExecutionPolicy,
    snapshot: DisplaySnapshot,
  ): DisplayDecision | null {
    return snapshot.current() ? policy.decide(snapshot.window.windowId) : null;
  }

  async execute(policy: ExecutionPolicy): Promise<DisplayResult> {
    const { target } = this;
    const mutation: { current: Mutation } = { current: { kind: "none" } };
    const [completion1] = await Promise.allSettled([
      (async (): Promise<DisplayResult> => {
        const [operation1] = await Promise.allSettled([
          this.perform(policy, mutation),
        ]);
        if (operation1.status === "fulfilled") {
          return operation1.value;
        }
        const error: unknown = operation1.reason;

        if (!this.current()) {
          return { kind: "retired" };
        }
        const uncertain =
          mutation.current.kind === "pending" &&
          !(error instanceof CdpFault && error.code !== undefined);
        if (mutation.current.kind === "pending" && !uncertain) {
          mutation.current.rejected();
        }
        let restored = true;
        if (mutation.current.kind === "applied" || uncertain) {
          target.geometry.uncertain();
          this.applied = undefined;
          policy.stage("recovering");
          restored = await this.restore();
          if (!this.current()) {
            return { kind: "retired" };
          }
        }
        return {
          kind: "failed",
          error: !restored
            ? new CdpFault(
                "display",
                "Display recovery could not be confirmed. Try synchronizing again.",
                undefined,
                requestDetails(error),
              )
            : error instanceof CdpFault &&
                ["scope", "display"].includes(error.kind)
              ? error
              : new CdpFault(
                  error instanceof CdpFault && error.code === -32_601
                    ? "unsupported-capability"
                    : "display",
                  "The browser display could not be synchronized. Check window support and try again.",
                  undefined,
                  requestDetails(error),
                ),
        };
      })(),
    ]);
    if (completion1.status === "rejected") {
      throw completion1.reason;
    }
    return completion1.value;
  }

  private async perform(
    policy: ExecutionPolicy,
    mutation: { current: Mutation },
  ): Promise<DisplayResult> {
    const { host, target } = this;
    const snapshot = await this.preparation.acquire(
      host.signal,
      host.presentationTimeout,
    );
    if (!snapshot) {
      return { kind: this.current() ? "deferred" : "retired" };
    }
    const { window, remote: remoteSize, layout } = snapshot;
    const decision = this.decision(policy, snapshot);
    if (!decision) {
      return { kind: this.current() ? "deferred" : "retired" };
    }
    // Choose the latest local observation once. Later changes are separate work;
    // no dispatched payload can change while awaiting native acknowledgements.
    const prepared = projection(window.windowId, decision, remoteSize, layout);
    const existingPresentation = windowPresentation(
      snapshot.native,
      window.bounds,
      prepared.projected.presentation.nativeDpr,
    );
    if (
      this.applied?.prepared.projected.key === prepared.projected.key &&
      target.geometry.matches(existingPresentation, prepared.projected.input)
    ) {
      if (!policy.prepared()) {
        return { kind: this.current() ? "deferred" : "retired" };
      }
      return this.completed(this.applied, "reused");
    }

    return this.applyProjection(policy, snapshot, prepared, decision, mutation);
  }
  private async applyProjection(
    policy: ExecutionPolicy,
    snapshot: DisplaySnapshot,
    prepared: ReturnType<typeof projection>,
    decision: DisplayDecision,
    mutation: { current: Mutation },
  ): Promise<DisplayResult> {
    const { client, host, target } = this;
    const { window, layout } = snapshot;
    const { projected, size } = prepared;
    if (!policy.prepared()) {
      return { kind: this.current() ? "deferred" : "retired" };
    }
    const needsCaptureFence = target.geometry.captureFence(
      layout,
      projected.input,
    );
    if (!snapshot.current()) {
      return { kind: this.current() ? "deferred" : "retired" };
    }
    const rejected = target.geometry.beginWrite();
    if (!policy.stage("writing")) {
      rejected();
      return { kind: this.current() ? "deferred" : "retired" };
    }
    if (!this.current()) {
      rejected();
      return { kind: "retired" };
    }
    mutation.current = { kind: "pending", rejected };
    await client.request(
      "Emulation.setDeviceMetricsOverride",
      projected.metrics,
      target.sessionId,
    );
    mutation.current = { kind: "applied" };
    if (!this.current()) {
      return { kind: "retired" };
    }
    const confirmed = await this.preparation.confirm(window.windowId);
    if (!this.current()) {
      return { kind: "retired" };
    }
    let acknowledged = confirmed;
    if (decision.kind === "fit" || size.constrained) {
      await client.request("Browser.setContentsSize", projected.contents);
      if (!this.current()) {
        return { kind: "retired" };
      }
      acknowledged = await this.preparation.confirm(window.windowId);
      if (!this.current()) {
        return { kind: "retired" };
      }
    }
    if (!this.current()) {
      return { kind: "retired" };
    }
    const presentation = windowPresentation(
      snapshot.native,
      acknowledged.bounds,
      projected.presentation.nativeDpr,
    );
    // Automatic capture waits behind display work. Apply its latest bounds
    // through this transaction so presentation cannot wait on that same work.
    const freshCapture =
      needsCaptureFence(presentation) || host.capturePending();
    const receipt: AppliedReceipt = {
      windowId: window.windowId,
      prepared,
      presentation: {
        transform: projected.input,
        expected: presentation,
      },
    };
    target.geometry.apply(receipt.presentation, freshCapture);
    policy.stage("presenting");
    return this.presentProjection(receipt, freshCapture);
  }
  private async presentProjection(
    receipt: AppliedReceipt,
    freshCapture: boolean,
  ): Promise<DisplayResult> {
    const { target, host } = this;
    const presentation = receipt.presentation.expected;
    const projected = receipt.prepared.projected;
    if (freshCapture) {
      await this.fenceCapture();
    }
    if (!this.current()) {
      return { kind: "retired" };
    }
    const started = performance.now();
    const budget = host.presentationTimeout ?? frameTimeoutMs;
    const outcome = await target.geometry.waitForPresentation(
      host.signal,
      budget,
      !freshCapture,
    );
    // Compatible pixels can paint after the mismatch wakes this continuation.
    if (
      outcome === "inconsistent" &&
      !target.geometry.matches(presentation, projected.input)
    ) {
      if (!this.current()) {
        return { kind: "retired" };
      }
      // A clipped static image may be the stream's last frame. Refresh once
      // on evidence, retiring queued decodes before stopping that stream.
      target.geometry.apply(receipt.presentation, true);
      await this.fenceCapture();
      if (!this.current()) {
        return { kind: "retired" };
      }
      await target.geometry.waitForPresentation(
        host.signal,
        budget - (performance.now() - started),
      );
    }
    if (!this.current()) {
      return { kind: "retired" };
    }
    return this.completed(receipt, "painted");
  }
  private completed(
    receipt: AppliedReceipt,
    proof: "reused" | "painted",
  ): Extract<DisplayOutcome, { readonly kind: "completed" }> {
    this.applied = receipt;
    return {
      kind: "completed",
      proof,
      windowId: receipt.windowId,
      dpr: receipt.prepared.size.dpr,
    };
  }

  private async restore(): Promise<boolean> {
    const { client, target, host } = this;
    if (!this.current()) {
      return false;
    }
    const cleared = await (async () => {
      const [reply1] = await Promise.allSettled([
        client.request(
          "Emulation.clearDeviceMetricsOverride",
          undefined,
          target.sessionId,
        ),
      ]);
      if (reply1.status === "fulfilled") {
        return true;
      }
      return false;
    })();
    if (!cleared || !this.current()) {
      return false;
    }
    const [completion2] = await Promise.allSettled([
      (async (): Promise<boolean> => {
        const [operation2] = await Promise.allSettled([
          (async (): Promise<boolean> => {
            const layout = await client.request(
              "Page.getLayoutMetrics",
              undefined,
              target.sessionId,
            );
            if (!this.current()) {
              return false;
            }
            target.geometry.apply(
              { transform: null, expected: nativePresentation(layout) },
              true,
            );
            await this.fenceCapture();
            if (!this.current()) {
              return false;
            }
            await target.geometry.waitForPresentation(
              host.signal,
              host.presentationTimeout,
            );
            return this.current();
          })(),
        ]);
        if (operation2.status === "fulfilled") {
          return operation2.value;
        }

        if (this.current()) {
          target.geometry.uncertain();
        }
        return false;
      })(),
    ]);
    if (completion2.status === "rejected") {
      throw completion2.reason;
    }
    return completion2.value;
  }

  private async fenceCapture(
    kind: "native" | "presentation" = "presentation",
  ): Promise<NativeCapture | null> {
    const { client, target } = this;
    if (!this.current()) {
      return null;
    }
    let capture: NativeCapture | null = null;
    if (kind === "native") {
      target.geometry.fenceNative(Infinity);
    }
    await this.host.refresh(async () => {
      const boundary = await captureBoundary(client, target.sessionId, () => {
        return this.current();
      });
      if (boundary === null) {
        return;
      }
      if (kind === "native") {
        capture = target.geometry.fenceNative(boundary);
      } else {
        target.geometry.fence(boundary);
      }
    });
    return this.current() ? capture : null;
  }
}
