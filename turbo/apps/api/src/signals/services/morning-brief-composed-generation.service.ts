import { randomUUID } from "node:crypto";

import type { MorningBriefCollectionOccurrenceView } from "@okouai/api-contracts/contracts/morning-brief-collection-preview";
import type { MorningBriefGenerationView } from "@okouai/api-contracts/contracts/morning-brief-generation-preview";
import {
  MORNING_BRIEF_COLLECTION_KIND_SOURCES,
  MORNING_BRIEF_COLLECTION_VERSION,
} from "@okouai/db/schema/morning-brief-collection-occurrence";
import { command } from "ccstate";

import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { clerk$, type ClerkClient } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import {
  admitMorningBriefCollection,
  startMorningBriefSourceDeadline,
  type MorningBriefCollectionScope,
} from "./morning-brief-connector-reader.service";
import {
  claimMorningBriefCollection,
  collectionLeaseHeld,
  finalizeMorningBriefCollection,
  loadMorningBriefCollectionOwnerRow,
  type MorningBriefCollectionAdmission,
  type MorningBriefCollectionClaim,
  type MorningBriefCollectionCompletion,
  type MorningBriefCollectionOccurrenceRow,
  type MorningBriefCollectionOwner,
} from "./morning-brief-collection-occurrence.service";
import {
  composeMorningBrief$,
  type MorningBriefCompositionOutcome,
  type MorningBriefCompositionTransport,
} from "./morning-brief-composition.service";
import { interpretComposedGenerationOutput } from "./morning-brief-generation-result";
import {
  invokeAndPersist$,
  type MorningBriefGenerationExecution,
} from "./morning-brief-generation-executor.service";
import {
  readInvokedAnchorGeneration,
  readMorningBriefGeneration,
  recordMorningBriefGenerationSkip,
  reserveMorningBriefGeneration,
  sweepExpiredMorningBriefGenerations,
  type MorningBriefGenerationAdmission,
  type MorningBriefGenerationRow,
} from "./morning-brief-generation-store.service";
import { MORNING_BRIEF_GENERATION_MODEL } from "./morning-brief-generation-prompt";
import { loadMorningBriefMigrationState } from "./morning-brief-migration-state.service";
import {
  morningBriefDescriptorRetainUntil,
  morningBriefSourcesToRevalidate,
  type MorningBriefRetainedSourceDescriptor,
} from "./morning-brief-source-authority";

/**
 * The real source-independent Morning Brief generation.
 *
 * It is the composition's actual consumer: every source this owner has is read
 * by `composeMorningBrief$`, the request it assembles is the exact transport
 * body sent, and that body travels through the same S5 reservation, the same
 * single platform-funded POST, the same receipt and cost writer and the same
 * accepted-result lifecycle the Slack-only entry already used. There is no
 * second engine, no second result store and no second authorization path.
 *
 * Three orderings are load-bearing:
 *
 * - **Every network read finishes before the reservation.** Composition owns
 *   the provider reads, the language archive read and the request assembly; the
 *   finalize-and-reserve transaction is short and touches only local rows.
 * - **The single POST follows the reservation COMMIT.** The reservation is
 *   durable before any provider contact, so a crash resolves to an unknown
 *   outcome rather than to a second request.
 * - **The retained sources are revalidated after that COMMIT and before the
 *   POST.** A revocation that lands while the reservation commits stops the
 *   request where nothing has been sent. The committed request is never edited
 *   or recollected to get past that fence.
 *
 * Okou pays. Nothing here reads the owner's model provider, checks a credit
 * balance, reserves an allowance or writes a usage event, and nothing starts a
 * Run, a sandbox or a tool loop.
 */

/** Anchors may not run ahead of this instance's clock by more than a minute. */
const MAX_ANCHOR_SKEW_MS = 60_000;

/** The oldest anchor this engine accepts. */
const MAX_ANCHOR_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The frozen window is the 24 hours ending at the anchor. */
const COMPOSED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Bounded retention for a source-derived result. Never reset by a retry. */
const COMPOSED_RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** How long one attempt owns its generation slot. Never the collection lease. */
const COMPOSED_RESERVATION_MS = 60_000;

/**
 * The bounded budget an admission may spend before it has to answer.
 *
 * Admission reads canonical state and this member's live Clerk membership, so
 * it can block. Both the entry admission and the pre-POST revalidation get
 * their own finite slice rather than running outside every budget.
 */
const COMPOSED_ADMISSION_BUDGET_MS = 5000;

export type MorningBriefComposedConflict =
  | "in-progress"
  | "retry-pending"
  | "attempts-exhausted"
  | "expired"
  | "binding-changed"
  | "owner-revoked"
  | "claim-lost"
  | "generation-in-progress"
  /** Another collection kind or contract version already owns this morning. */
  | "anchor-already-invoked";

export type MorningBriefComposedExecution =
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "invalid-anchor"; readonly message: string }
  | {
      readonly kind: "conflict";
      readonly reason: MorningBriefComposedConflict;
    }
  | {
      readonly kind: "incomplete";
      readonly reason: string;
      readonly detail: string;
    }
  | { readonly kind: "authority-changed" }
  | MorningBriefGenerationExecution;

function validateAnchor(
  scheduledFor: Date,
  at: Date,
): { readonly kind: "invalid-anchor"; readonly message: string } | null {
  const offset = scheduledFor.getTime() - at.getTime();
  if (offset > MAX_ANCHOR_SKEW_MS) {
    return {
      kind: "invalid-anchor",
      message: "scheduledFor must not be a future instant.",
    };
  }
  if (-offset > MAX_ANCHOR_AGE_MS) {
    return {
      kind: "invalid-anchor",
      message: "scheduledFor is older than the supported collection window.",
    };
  }
  return null;
}

function occurrenceView(
  row: MorningBriefCollectionOccurrenceRow,
): MorningBriefCollectionOccurrenceView {
  if (row.status === "running" || row.outcome === null) {
    throw new Error("Morning Brief occurrence finalized without an outcome");
  }
  return {
    scheduledFor: row.scheduledFor.toISOString(),
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    timezone: row.timezone,
    collectionKind: MORNING_BRIEF_COLLECTION_KIND_SOURCES,
    collectionVersion: row.collectionVersion,
    attempt: row.attempt,
    status: row.status,
    outcome: row.outcome,
  };
}

/**
 * The occurrence identity a composed attempt is admitted with.
 *
 * It reuses the shared admission — the feature switch, the canonical installed
 * and enabled brief, the member timezone, the installation's Agent and a fresh
 * exact-member Clerk membership — and adds only the schedule identity the
 * occurrence row needs. The Slack binding is deliberately absent: an owner
 * without a Slack installation still has a morning, and a placeholder would
 * make a later binding comparison pass against a workspace nobody read.
 */
async function composedAdmission(
  db: Db,
  scope: MorningBriefCollectionScope,
  scheduledFor: Date,
): Promise<MorningBriefCollectionAdmission | null> {
  const owner: MorningBriefCollectionOwner = {
    orgId: scope.orgId,
    userId: scope.userId,
  };
  const state = await loadMorningBriefMigrationState(db, owner);
  if (state.kind !== "installed" || !state.automation.enabled) {
    return null;
  }
  const ownerRow = await loadMorningBriefCollectionOwnerRow(db, owner);
  if (ownerRow === null) {
    return null;
  }
  return {
    owner,
    memberCreatedAt: ownerRow.memberCreatedAt,
    scheduledFor,
    collectionKind: MORNING_BRIEF_COLLECTION_KIND_SOURCES,
    windowStart: new Date(scheduledFor.getTime() - COMPOSED_WINDOW_MS),
    windowEnd: scheduledFor,
    timezone: scope.timezone,
    membershipId: scope.membershipId,
    workflowId: state.installation.id,
    automationId: state.automation.id,
    agentId: state.installation.agentId,
    slackWorkspaceId: null,
    slackUserId: null,
  };
}

/**
 * Prove the sources this request was built from are still the owner's to read.
 *
 * It consumes the one shared admission rather than a second authorizer: the
 * feature switch, canonical installation, Agent and Clerk membership are
 * resolved again against live state and compared with what the descriptors
 * recorded. Every supplied source is checked, cited or not, because the model
 * may have used material without citing it.
 */
async function retainedSourcesStillAuthorized(
  args: {
    readonly db: Db;
    readonly clerk: ClerkClient;
    readonly scope: MorningBriefCollectionScope;
    readonly descriptors: readonly MorningBriefRetainedSourceDescriptor[];
  },
  signal: AbortSignal,
): Promise<"owner_revoked" | "binding_changed" | null> {
  const supplied = morningBriefSourcesToRevalidate(args.descriptors);
  if (supplied.length === 0) {
    return null;
  }
  const readmitted = await admitMorningBriefCollection(
    {
      db: args.db,
      clerk: args.clerk,
      orgId: args.scope.orgId,
      userId: args.scope.userId,
      anchor: args.scope.anchor,
      deadline: startMorningBriefSourceDeadline(COMPOSED_ADMISSION_BUDGET_MS),
    },
    signal,
  );
  if (readmitted.kind !== "ok") {
    return "owner_revoked";
  }
  const current = readmitted.scope;
  // The descriptors are the frozen proof of what was read and under whose
  // authority. They are compared against live state rather than against an
  // earlier in-request snapshot: a second snapshot is not evidence, and the
  // question this fence answers is whether *these inputs* are still the
  // owner's to send.
  const moved = supplied.some((descriptor) => {
    return (
      descriptor.membershipId !== current.membershipId ||
      descriptor.agentId !== current.agentId
    );
  });
  return moved ? "binding_changed" : null;
}

function generationAdmissionOf(args: {
  readonly admission: MorningBriefCollectionAdmission;
  readonly transport: MorningBriefCompositionTransport;
  readonly language: {
    readonly authority: MorningBriefGenerationAdmission["languageSource"];
    readonly fallbackLanguage: string;
    readonly instructionsVersionId: string | null;
    readonly instructionsDigest: string | null;
  };
  readonly descriptors: readonly MorningBriefRetainedSourceDescriptor[];
  readonly at: Date;
  readonly occurrenceCreatedAt: Date;
  readonly purpose: MorningBriefGenerationAdmission["executionPurpose"];
}): MorningBriefGenerationAdmission {
  const { admission, transport, at } = args;
  const expiresAt = new Date(at.getTime() + COMPOSED_RESULT_RETENTION_MS);
  return {
    key: {
      owner: admission.owner,
      scheduledFor: admission.scheduledFor,
      collectionKind: admission.collectionKind,
      collectionVersion: MORNING_BRIEF_COLLECTION_VERSION,
    },
    executionPurpose: args.purpose,
    attemptId: randomUUID(),
    membershipId: admission.membershipId,
    agentId: admission.agentId,
    model: MORNING_BRIEF_GENERATION_MODEL,
    language: args.language.fallbackLanguage,
    languageSource: args.language.authority,
    instructionsVersionId: args.language.instructionsVersionId,
    instructionsDigest: args.language.instructionsDigest,
    // Frozen with the reservation, because it describes the request that is
    // about to be sent. No source body, prompt or credential is in it.
    retainedSources: args.descriptors,
    // The proof outlives the body. No email obligation exists yet, so this is
    // the result's own validity; a later obligation extends it from its own
    // original deadline rather than by resetting this one.
    retainedUntil: morningBriefDescriptorRetainUntil(at, null),
    inputDigest: transport.inputDigest,
    inputItems: transport.inputItems,
    includedItems: transport.includedItems,
    inputReduced: transport.includedItems < transport.inputItems,
    sourceCoverage: transport.sourceCoverage,
    reservedAt: at,
    reservationExpiresAt: new Date(
      Math.min(
        at.getTime() + COMPOSED_RESERVATION_MS,
        args.occurrenceCreatedAt.getTime() + COMPOSED_RESULT_RETENTION_MS,
      ),
    ),
    expiresAt,
  };
}

/** Which terminal facts the occurrence records for a composed attempt. */
function completionOf(
  outcome: "composed" | "empty" | "incomplete",
  coverage: "complete" | "partial" | "empty",
): MorningBriefCollectionCompletion {
  if (outcome === "incomplete") {
    return { status: "failed", outcome: "provider_failed" };
  }
  if (outcome === "empty") {
    // A healthy empty read and a bounded one stay distinguishable, exactly as
    // they do for the Slack-only collection.
    return {
      status: "completed",
      outcome: coverage === "partial" ? "partial" : "no_shared_channels",
      truncated: coverage === "partial",
    };
  }
  return {
    status: "completed",
    outcome: coverage === "partial" ? "partial" : "complete",
    truncated: coverage === "partial",
  };
}

export const executeMorningBriefComposedGeneration$ = command(
  async (
    { get, set },
    args: {
      readonly owner: MorningBriefCollectionOwner;
      readonly scheduledFor: Date;
      readonly purpose: MorningBriefGenerationAdmission["executionPurpose"];
    },
    signal: AbortSignal,
  ): Promise<MorningBriefComposedExecution> => {
    const db = set(writeDb$);
    const clerk = get(clerk$);
    const startedAt = nowDate();
    const invalid = validateAnchor(args.scheduledFor, startedAt);
    if (invalid) {
      return invalid;
    }

    // Bounded retention is consumed here rather than by a scheduler: every
    // invocation drops this owner's own expired results first.
    await sweepExpiredMorningBriefGenerations(db, args.owner, nowDate());
    signal.throwIfAborted();

    const apiKey = optionalEnv("OPENROUTER_API_KEY");
    if (!apiKey) {
      // Checked before admission, so a deployment without the platform
      // credential claims no occurrence and reads no source.
      return { kind: "not-executed", reason: "generation-not-configured" };
    }

    const admitted = await admitMorningBriefCollection(
      {
        db,
        clerk,
        orgId: args.owner.orgId,
        userId: args.owner.userId,
        anchor: args.scheduledFor,
        deadline: startMorningBriefSourceDeadline(COMPOSED_ADMISSION_BUDGET_MS),
      },
      signal,
    );
    signal.throwIfAborted();
    if (admitted.kind !== "ok") {
      return { kind: "denied", reason: admitted.reason };
    }
    const { scope } = admitted;

    const admission = await composedAdmission(db, scope, args.scheduledFor);
    signal.throwIfAborted();
    if (admission === null) {
      return { kind: "denied", reason: "not-installed" };
    }

    const claimed = await db.transaction(async (tx) => {
      return await claimMorningBriefCollection(
        tx,
        admission,
        randomUUID(),
        nowDate,
      );
    });
    signal.throwIfAborted();
    if (claimed.kind === "rejected") {
      return { kind: "conflict", reason: claimed.reason };
    }
    if (claimed.kind === "already-completed") {
      // A completed occurrence is metadata about a collection, never a
      // checkpoint of one: this makes no provider call and offers no request.
      return await resolveExisting(db, admission, claimed.occurrence, args);
    }
    const { claim } = claimed;
    if (!collectionLeaseHeld(claim, nowDate())) {
      return { kind: "conflict", reason: "claim-lost" };
    }

    // Every provider read, the language archive read and the request assembly
    // happen here, outside any transaction.
    const composed = await set(
      composeMorningBrief$,
      {
        orgId: args.owner.orgId,
        userId: args.owner.userId,
        anchor: args.scheduledFor,
      },
      signal,
    );
    signal.throwIfAborted();
    if (composed.kind === "denied") {
      return { kind: "denied", reason: composed.reason };
    }
    if (composed.kind === "authority-changed") {
      return { kind: "authority-changed" };
    }
    if (composed.kind === "incomplete") {
      return {
        kind: "incomplete",
        reason: composed.reason,
        detail: composed.detail,
      };
    }

    return await set(
      reserveAndInvoke$,
      { db, apiKey, admission, claim, scope, composed, purpose: args.purpose },
      signal,
    );
  },
);

/** What an already completed occurrence resolves to, without any provider call. */
async function resolveExisting(
  db: Db,
  admission: MorningBriefCollectionAdmission,
  occurrence: MorningBriefCollectionOccurrenceRow,
  args: {
    readonly purpose: MorningBriefGenerationAdmission["executionPurpose"];
  },
): Promise<MorningBriefComposedExecution> {
  const row = await readMorningBriefGeneration(
    db,
    {
      owner: admission.owner,
      scheduledFor: admission.scheduledFor,
      collectionKind: admission.collectionKind,
      collectionVersion: MORNING_BRIEF_COLLECTION_VERSION,
    },
    args.purpose,
  );
  if (!row) {
    return {
      kind: "collection-completed-without-generation",
      occurrence: occurrenceView(occurrence),
    };
  }
  return {
    kind: "already-generated",
    occurrence: occurrenceView(occurrence),
    generation: composedView(row),
  };
}

/** The stored row as the one generation view, with no content re-derived. */
function composedView(
  row: MorningBriefGenerationRow,
): MorningBriefGenerationView {
  const result =
    row.decision === "deliver" &&
    row.resultTitle !== null &&
    row.resultMarkdown !== null
      ? {
          decision: "deliver" as const,
          title: row.resultTitle,
          markdown: row.resultMarkdown,
          bytes: row.resultBytes ?? 0,
        }
      : row.decision === "skip"
        ? { decision: "skip" as const, reason: "nothing_actionable" as const }
        : null;
  return {
    purpose: row.executionPurpose,
    state: row.state,
    attemptId: row.attemptId,
    model: row.model,
    promptVersion: row.promptVersion,
    resultSchemaVersion: row.resultSchemaVersion,
    language: row.language,
    languageSource: row.languageSource,
    inputDigest: row.inputDigest,
    inputItems: row.inputItems,
    includedItems: row.includedItems,
    inputReduced: row.inputReduced,
    sourceCoverage: row.sourceCoverage,
    reservedAt: row.reservedAt.toISOString(),
    reservationExpiresAt: row.reservationExpiresAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    failureReason: row.failureReason,
    result,
    receipt: null,
  };
}

/**
 * Finalize the collection, take the single reservation, then send once.
 *
 * The finalize-and-reserve transaction is short and local. The provider request
 * follows its COMMIT, so the durable record of the invocation always exists
 * before the invocation can happen.
 */
const reserveAndInvoke$ = command(
  async (
    { get, set },
    input: {
      readonly db: Db;
      readonly apiKey: string;
      readonly admission: MorningBriefCollectionAdmission;
      readonly claim: MorningBriefCollectionClaim;
      readonly scope: MorningBriefCollectionScope;
      readonly composed: Extract<
        MorningBriefCompositionOutcome,
        { kind: "composed" | "empty" }
      >;
      readonly purpose: MorningBriefGenerationAdmission["executionPurpose"];
    },
    signal: AbortSignal,
  ): Promise<MorningBriefComposedExecution> => {
    const { db, admission, claim, composed } = input;
    const clerk = get(clerk$);
    const transport = composed.kind === "composed" ? composed.transport : null;
    const coverage = transport?.sourceCoverage ?? "empty";
    const completion = completionOf(
      composed.kind === "composed" ? "composed" : "empty",
      coverage,
    );

    let generationAdmission: MorningBriefGenerationAdmission | undefined;
    let occurrenceRow: MorningBriefCollectionOccurrenceRow | undefined;
    let anchorConflict = false;

    const finalized = await db.transaction(async (tx) => {
      const result = await finalizeMorningBriefCollection(
        tx,
        admission,
        claim,
        completion,
        nowDate,
      );
      if (result.kind !== "finalized") {
        return result;
      }
      occurrenceRow = result.occurrence;
      const language = composed.result.language;
      const pending = generationAdmissionOf({
        admission,
        transport: transport ?? {
          body: "",
          bodyBytes: 0,
          inputDigest: "",
          citations: new Map(),
          inputItems: 0,
          includedItems: 0,
          sourceCoverage: coverage,
        },
        language: {
          authority: language?.authority ?? "default",
          fallbackLanguage: language?.fallbackLanguage ?? "en-US",
          instructionsVersionId: language?.instructionsVersionId ?? null,
          instructionsDigest: language?.instructionsDigest ?? null,
        },
        descriptors: composed.result.descriptors,
        at: result.at,
        occurrenceCreatedAt: result.occurrence.createdAt,
        purpose: input.purpose,
      });

      // One anchor, one possible invocation — including one admitted under the
      // Slack-only kind. A row that may already have reached the provider owns
      // this morning, and widening the source set is never a reason to send
      // again for it.
      const occupying = await readInvokedAnchorGeneration(tx, {
        owner: admission.owner,
        scheduledFor: admission.scheduledFor,
        executionPurpose: input.purpose,
      });
      if (occupying) {
        anchorConflict = true;
        return result;
      }

      if (transport === null) {
        const state =
          coverage === "partial" ? "skipped_incomplete" : "skipped_empty";
        if (!(await recordMorningBriefGenerationSkip(tx, pending, state))) {
          anchorConflict = true;
          return result;
        }
        generationAdmission = pending;
        return result;
      }
      if (!(await reserveMorningBriefGeneration(tx, pending))) {
        anchorConflict = true;
        return result;
      }
      generationAdmission = pending;
      return result;
    });
    signal.throwIfAborted();

    if (finalized.kind !== "finalized" || occurrenceRow === undefined) {
      return {
        kind: "conflict",
        reason:
          finalized.kind === "owner-revoked" ? "owner-revoked" : "claim-lost",
      };
    }
    const occurrence = occurrenceView(finalized.occurrence);
    if (anchorConflict || generationAdmission === undefined) {
      return { kind: "conflict", reason: "anchor-already-invoked" };
    }
    if (transport === null) {
      const row = await readMorningBriefGeneration(
        db,
        generationAdmission.key,
        input.purpose,
      );
      signal.throwIfAborted();
      if (!row) {
        throw new Error("Morning Brief generation skip was not recorded");
      }
      return { kind: "generated", occurrence, generation: composedView(row) };
    }

    const language = composed.result.language;
    const requestedLanguage = language?.fallbackLanguage ?? "en-US";
    return await set(
      invokeAndPersist$,
      {
        db,
        apiKey: input.apiKey,
        admission: generationAdmission,
        body: transport.body,
        coverage,
        occurrence,
        occurrenceRow: finalized.occurrence,
        interpret: (content) => {
          return interpretComposedGenerationOutput({
            content,
            citations: transport.citations,
            coverage: {
              collected: coverage,
              omittedForSize: transport.inputItems - transport.includedItems,
            },
            language: requestedLanguage,
          });
        },
        preflight: async (preflightSignal) => {
          return await retainedSourcesStillAuthorized(
            {
              db,
              clerk,
              scope: input.scope,
              descriptors: composed.result.descriptors,
            },
            preflightSignal,
          );
        },
      },
      signal,
    );
  },
);
