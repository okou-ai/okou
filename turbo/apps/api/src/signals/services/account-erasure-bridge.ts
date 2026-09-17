import { settleIncludingAbort } from "../utils";
import { v5 as uuidv5 } from "uuid";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  createErasureJournal,
  JournalAppend,
} from "@okouai/db/erasure-journal";
import { projectErasureDecision } from "@okouai/db/operations/account-erasure";
import {
  assertExactAppend,
  beginErasureReplay,
  captureAppend,
  captureErasureIngress,
  checkpointErasureReplay,
  claimErasureIngress,
  claimErasureReplay,
  readErasureCapture,
  recordErasureIngress,
  releaseErasureIngress,
  retireCompletedErasureCapture,
  type ErasureBridgeBinding,
  type ErasureCapture,
  type ErasureReplayIdentity,
} from "@okouai/db/operations/account-erasure-bridge";
import {
  verifyClerkDeletion,
  type ClerkDeletionEnvelope,
} from "../external/clerk";

// Immutable v1 compatibility namespace. Names use JSON tuples, not concatenation.
const CLERK_DELETION_NAMESPACE = "bd0c2eda-9bde-4a58-889e-bc76e6e9b1c7";
type UnresolvedReason = "recovered" | "transferred" | "retired" | "ambiguous";
type FrozenDecision = JournalAppend & Readonly<{ authorityId: string }>;
export interface ErasureBridgeAuthority {
  decideInitial(
    event: ClerkDeletionEnvelope,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly outcome: "initial";
        readonly generation: number;
        readonly dispositionVersion: number;
        readonly deadlineAt: Date;
      }
    | { readonly outcome: "unresolved"; readonly reason: UnresolvedReason }
  >;
  // Independent CURRENT disposition, including for an old committed decision.
  // No production implementation/default is installed by this dormant slice.
  applicability(
    decision: FrozenDecision,
    signal: AbortSignal,
  ): Promise<
    | { readonly outcome: "applicable"; readonly decisionRef: string }
    | { readonly outcome: "unresolved"; readonly reason: UnresolvedReason }
  >;
}
type NonSuccessStatus =
  | "pending"
  | "external_committed_local_pending"
  | "unresolved";
type ErasureBridgeResult =
  | {
      readonly status: "projection_committed";
      readonly decisionRef: string;
      readonly decisionSequence: bigint;
    }
  | { readonly status: NonSuccessStatus; readonly reason: string };
interface ErasureBridgeConfig extends ErasureBridgeBinding {
  readonly signingSecret: string;
  readonly journal: ReturnType<typeof createErasureJournal>;
  readonly db: NodePgDatabase<Record<string, never>>;
  readonly authority: ErasureBridgeAuthority;
}
function eventReferences(event: ClerkDeletionEnvelope) {
  return {
    confirmationRef: uuidv5(
      JSON.stringify(["confirmation", event.audience, event.eventId]),
      CLERK_DELETION_NAMESPACE,
    ),
    decisionRef: uuidv5(
      JSON.stringify(["decision", event.audience, event.eventId]),
      CLERK_DELETION_NAMESPACE,
    ),
  };
}
function assertEvent(event: ClerkDeletionEnvelope, decision: JournalAppend) {
  if (
    decision.confirmationRef !== eventReferences(event).confirmationRef ||
    decision.subjectKind !== event.subjectKind ||
    decision.subjectId !== event.subjectId ||
    decision.requestedAt.getTime() !== event.requestedAt.getTime()
  ) {
    throw new Error("erasure_bridge:event_conflict");
  }
}
function unresolved(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith("erasure_bridge:") ||
      error.message.startsWith("account_erasure:") ||
      error.message.startsWith("erasure_journal:"))
  );
}

/** Explicitly constructed internal handler; importing it opens no connection,
 * registers no worker and changes no production webhook acknowledgement.
 */
class ClerkErasureBridge {
  private readonly binding: ErasureBridgeBinding;
  private readonly db: ErasureBridgeConfig["db"];
  private readonly journal: ErasureBridgeConfig["journal"];
  private readonly authority: ErasureBridgeAuthority;
  private readonly signingSecret: string;

  constructor(config: ErasureBridgeConfig) {
    this.binding = {
      authorityId: config.authorityId,
      audience: config.audience,
    };
    this.db = config.db;
    this.journal = config.journal;
    this.authority = config.authority;
    this.signingSecret = config.signingSecret;
    if (
      !this.binding.audience ||
      !this.binding.authorityId ||
      !this.signingSecret
    ) {
      throw new Error("erasure_bridge:configuration_required");
    }
  }
  private async boundAuthority(signal: AbortSignal) {
    signal.throwIfAborted();
    const watermark = await this.journal.readWatermark();
    if (watermark.authorityId !== this.binding.authorityId) {
      throw new Error("erasure_bridge:binding_mismatch");
    }
    signal.throwIfAborted();
    return watermark;
  }
  private async applicable(input: JournalAppend, signal: AbortSignal) {
    signal.throwIfAborted();
    const result = await this.authority.applicability(
      {
        ...input,
        authorityId: this.binding.authorityId,
        requestedAt: new Date(input.requestedAt),
        deadlineAt: new Date(input.deadlineAt),
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.outcome !== "applicable") {
      throw new Error(`erasure_bridge:${result.reason}`);
    }
    if (result.decisionRef !== input.decisionRef) {
      throw new Error("erasure_bridge:applicability_mismatch");
    }
  }
  private checkOriginal(captured: ErasureCapture, original: JournalAppend) {
    assertExactAppend(
      captureAppend(captured),
      captureAppend({ ...captured, ...original }),
    );
  }
  private async processClaim(
    claim: ErasureCapture,
    signal: AbortSignal,
  ): Promise<ErasureBridgeResult> {
    const progress: { status: NonSuccessStatus } = { status: "pending" };
    const attempt = async (): Promise<ErasureBridgeResult> => {
      await this.boundAuthority(signal);
      const frozen = captureAppend(claim);
      const stored = await this.journal.readDecisionByConfirmationRef(
        claim.confirmationRef,
      );
      signal.throwIfAborted();
      if (stored) {
        this.checkOriginal(claim, stored);
      }
      await this.applicable(frozen, signal);
      // A failed/lost COMMIT response leaves this exact capture for point lookup.
      const decision = stored ?? (await this.journal.append(frozen));
      progress.status = "external_committed_local_pending";
      signal.throwIfAborted();
      await recordErasureIngress(
        this.db,
        claim,
        "external_committed",
        decision.decisionSequence,
        signal,
      );
      await this.applicable(decision, signal);
      await projectErasureDecision(this.db, decision);
      signal.throwIfAborted();
      await recordErasureIngress(
        this.db,
        claim,
        "projection_committed",
        decision.decisionSequence,
        signal,
      );
      signal.throwIfAborted();
      return {
        status: "projection_committed",
        decisionRef: decision.decisionRef,
        decisionSequence: decision.decisionSequence,
      };
    };
    // Cancellation is an explicit NON-success outcome after a possibly committed
    // external effect. Settle it using the central irreversible-operation helper.
    const result = await settleIncludingAbort(attempt());
    if (result.ok) {
      return result.value;
    }
    const isUnresolved = unresolved(result.error) || claim.attempts >= 5;
    const released = await settleIncludingAbort(
      releaseErasureIngress(this.db, claim, isUnresolved),
    );
    return {
      status: isUnresolved ? "unresolved" : progress.status,
      reason: signal.aborted
        ? "aborted"
        : !released.ok
          ? "retry_state_uncertain"
          : isUnresolved
            ? "decision_unresolved"
            : "attempt_failed",
    };
  }
  private async resumeAttempt(
    confirmationRef: string,
    signal: AbortSignal,
  ): Promise<ErasureBridgeResult> {
    signal.throwIfAborted();
    const claim = await claimErasureIngress(
      this.db,
      this.binding,
      confirmationRef,
    );
    if (claim) {
      return await this.processClaim(claim, signal);
    }
    const captured = await readErasureCapture(
      this.db,
      this.binding,
      confirmationRef,
    );
    // A local completed marker is not current applicability or proof the job
    // still exists after restore. Recheck authority and actual B1 projection.
    if (captured?.state === "projection_committed") {
      await this.boundAuthority(signal);
      const original =
        await this.journal.readDecisionByConfirmationRef(confirmationRef);
      if (!original) {
        return { status: "unresolved", reason: "authority_absent" };
      }
      this.checkOriginal(captured, original);
      await this.applicable(original, signal);
      await projectErasureDecision(this.db, original);
      signal.throwIfAborted();
      return {
        status: "projection_committed",
        decisionRef: original.decisionRef,
        decisionSequence: original.decisionSequence,
      };
    }
    return captured?.state === "unresolved" ||
      (captured && captured.attempts >= 5)
      ? { status: "unresolved", reason: "retry_exhausted_or_blocked" }
      : {
          status: "pending",
          reason: captured ? "claim_unavailable" : "capture_absent",
        };
  }
  async resume(
    confirmationRef: string,
    signal: AbortSignal,
  ): Promise<ErasureBridgeResult> {
    const result = await settleIncludingAbort(
      this.resumeAttempt(confirmationRef, signal),
    );
    return result.ok
      ? result.value
      : {
          status: unresolved(result.error) ? "unresolved" : "pending",
          reason: signal.aborted ? "aborted" : "resume_failed",
        };
  }
  private async handleAttempt(
    request: Request,
    signal: AbortSignal,
  ): Promise<ErasureBridgeResult> {
    signal.throwIfAborted();
    const event = await verifyClerkDeletion(request, {
      audience: this.binding.audience,
      signingSecret: this.signingSecret,
    });
    await this.boundAuthority(signal);
    const refs = eventReferences(event);
    // Authority lookup MUST precede all current policy/deadline defaults.
    const original = await this.journal.readDecisionByConfirmationRef(
      refs.confirmationRef,
    );
    if (original) {
      assertEvent(event, original);
    }
    const captured = await readErasureCapture(
      this.db,
      this.binding,
      refs.confirmationRef,
    );
    if (captured) {
      assertEvent(event, captured);
      if (original) {
        this.checkOriginal(captured, original);
      }
      return await this.resume(refs.confirmationRef, signal);
    }
    let input: JournalAppend;
    if (original) {
      input = original;
    } else {
      const disposition = await this.authority.decideInitial(
        { ...event, requestedAt: new Date(event.requestedAt) },
        signal,
      );
      signal.throwIfAborted();
      if (disposition.outcome !== "initial") {
        return { status: "unresolved", reason: disposition.reason };
      }
      input = {
        ...refs,
        subjectKind: event.subjectKind,
        subjectId: event.subjectId,
        requestedAt: event.requestedAt,
        deadlineAt: new Date(disposition.deadlineAt),
        generation: disposition.generation,
        dispositionVersion: disposition.dispositionVersion,
        previousDecisionRef: null,
      };
    }
    await this.applicable(input, signal);
    await captureErasureIngress(this.db, {
      ...input,
      ...this.binding,
      eventId: event.eventId,
    });
    signal.throwIfAborted();
    return await this.resume(refs.confirmationRef, signal);
  }
  async handle(
    request: Request,
    signal: AbortSignal,
  ): Promise<ErasureBridgeResult> {
    const result = await settleIncludingAbort(
      this.handleAttempt(request, signal),
    );
    return result.ok
      ? result.value
      : {
          status: unresolved(result.error) ? "unresolved" : "pending",
          reason: signal.aborted ? "aborted" : "request_not_committed",
        };
  }
  async retryNext(signal: AbortSignal): Promise<ErasureBridgeResult> {
    signal.throwIfAborted();
    const claim = await claimErasureIngress(this.db, this.binding);
    return claim
      ? await this.processClaim(claim, signal)
      : { status: "pending", reason: "no_ready_capture" };
  }
  async replayPage(
    identity: Pick<ErasureReplayIdentity, "targetId" | "replayGeneration">,
    signal: AbortSignal,
  ) {
    const watermark = await this.boundAuthority(signal);
    const pass = await beginErasureReplay(
      this.db,
      { ...identity, ...this.binding },
      watermark.sequence,
    );
    signal.throwIfAborted();
    if (pass.state !== "pending") {
      return {
        status: pass.state,
        cursor: pass.cursor,
        watermark: pass.watermark,
      };
    }
    const claim = await claimErasureReplay(this.db, pass);
    if (!claim) {
      return {
        status: "pending",
        cursor: pass.cursor,
        watermark: pass.watermark,
      };
    }
    const active = claim;
    let cursor = active.cursor;
    const attempt = async () => {
      const page = await this.journal.readPage({
        afterSequence: active.cursor,
        watermark: {
          authorityId: this.binding.authorityId,
          sequence: active.watermark,
        },
        limit: 100,
      });
      for (const decision of page.decisions) {
        await this.applicable(decision, signal);
        await projectErasureDecision(this.db, decision);
        signal.throwIfAborted();
        cursor = decision.decisionSequence;
      }
      return await checkpointErasureReplay(
        this.db,
        active,
        page.nextAfterSequence,
        page.done ? "complete" : "pending",
        signal,
      );
    };
    const result = await settleIncludingAbort(attempt());
    if (result.ok) {
      return {
        status: result.value.state,
        cursor: result.value.cursor,
        watermark: result.value.watermark,
      };
    }
    // Partial holes retain the last complete prefix, never direct-insert an old
    // generation. Abort leaves the previous checkpoint for safe duplicate replay.
    if (signal.aborted) {
      return {
        status: "pending",
        cursor: claim.cursor,
        watermark: claim.watermark,
      };
    }
    const saved = await checkpointErasureReplay(
      this.db,
      claim,
      cursor,
      unresolved(result.error) ? "unresolved" : "pending",
      signal,
    );
    return {
      status: saved.state,
      cursor: saved.cursor,
      watermark: saved.watermark,
    };
  }
  async retireCompleted(confirmationRef: string, signal: AbortSignal) {
    await this.boundAuthority(signal);
    const row = await readErasureCapture(
      this.db,
      this.binding,
      confirmationRef,
    );
    if (!row || row.state !== "projection_committed") {
      return false;
    }
    const original =
      await this.journal.readDecisionByConfirmationRef(confirmationRef);
    if (!original) {
      throw new Error("erasure_bridge:authority_absent");
    }
    this.checkOriginal(row, original);
    signal.throwIfAborted();
    return await retireCompletedErasureCapture(this.db, row);
  }
}

export function createClerkErasureBridge(config: ErasureBridgeConfig) {
  return new ClerkErasureBridge(config);
}
