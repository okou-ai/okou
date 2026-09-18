import { randomUUID } from "node:crypto";

import type {
  MorningBriefCollectionOccurrenceView,
  MorningBriefSlackBundle,
} from "@okouai/api-contracts/contracts/morning-brief-collection-preview";
import type {
  MorningBriefGenerationFailureReason,
  MorningBriefGenerationSkipReason,
  MorningBriefGenerationState,
  MorningBriefGenerationView,
  MorningBriefPlatformReceiptView,
} from "@okouai/api-contracts/contracts/morning-brief-generation-preview";
import {
  MORNING_BRIEF_GENERATION_PROMPT_VERSION,
  MORNING_BRIEF_GENERATION_RESULT_SCHEMA_VERSION,
  MORNING_BRIEF_GENERATION_SOURCE_COVERAGES,
} from "@okouai/db/schema/morning-brief-generation";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  lookupPlatformGenerationCost,
  requestPlatformGeneration,
  unknownInvocationTokens,
  type PlatformGenerationCost,
  type PlatformGenerationObservation,
  type PlatformGenerationOutcome,
  type PlatformGenerationTokens,
} from "../external/openrouter-platform-generation";
import { settleIncludingAbort } from "../utils";
import {
  admitMorningBriefLocalAuthority,
  currentMorningBriefCollectionAuthority$,
  executeMorningBriefSlackCollection$,
  type MorningBriefCollectionConflict,
  type MorningBriefCollectionHandoffContext,
  type MorningBriefLocalAuthority,
} from "./morning-brief-collection-executor.service";
import {
  lockCollectionOwner,
  morningBriefCollectionBindingMatches,
  readMorningBriefCollectionOccurrence,
  type MorningBriefCollectionOccurrenceRow,
  type MorningBriefCollectionOwner,
} from "./morning-brief-collection-occurrence.service";
import {
  GENERATION_PROVIDER_DEADLINE_MS,
  MORNING_BRIEF_GENERATION_MODEL,
  planGenerationRequest,
  resolveGenerationLanguage,
  type GenerationRequestPlan,
  type GenerationSource,
} from "./morning-brief-generation-prompt";
import type { MorningBriefCoverageFacts } from "./morning-brief-coverage-note";
import { interpretGenerationOutput } from "./morning-brief-generation-result";
import {
  acceptMorningBriefGenerationResult,
  holdMorningBriefGenerationSlot,
  lockMorningBriefGeneration,
  readMorningBriefGeneration,
  readPlatformGenerationReceipt,
  recordMorningBriefGenerationOutcome,
  recordMorningBriefGenerationSkip,
  recordPlatformGenerationReceipt,
  reserveMorningBriefGeneration,
  resolveStaleMorningBriefGeneration,
  sweepExpiredMorningBriefGenerations,
  type MorningBriefGenerationAdmission,
  type MorningBriefGenerationFence,
  type MorningBriefGenerationKey,
  type MorningBriefGenerationRow,
  type MorningBriefPlatformReceiptValues,
} from "./morning-brief-generation-store.service";

/**
 * One explicitly invoked, platform-funded Morning Brief generation.
 *
 * The whole path runs inside the caller's request: real Slack collection, a
 * generation reservation committed in the same transaction that finalizes that
 * collection, then exactly one provider request and the durable record of what
 * it produced and what it cost. There is no Run, no sandbox, no tool loop, no
 * queue and no background scheduler, and nothing is delivered anywhere.
 *
 * Two rules shape everything below.
 *
 * **Okou pays.** The request uses the platform credential. Nothing reads the
 * user's model provider, checks a credit balance, reserves an allowance or
 * writes a usage event, so a zero-credit organization completes this path
 * exactly like any other.
 *
 * **A request that may have been sent is never sent again.** The reservation is
 * durable *before* the request, so a timeout, a lost response, a dead process
 * or a failed result commit all leave a state that resolves to
 * `invocation_outcome_unknown` rather than to another request. What is
 * guaranteed is one application invocation admission and one accepted result —
 * not exactly-once provider inference.
 *
 * The rules are described in
 * [the generation contract](../../../../../../docs/morning-brief-generation.md).
 */

/** How long one attempt owns its generation slot. Never the collection lease. */
const GENERATION_RESERVATION_MS = 60_000;
/** Held back from the reservation so an observed result can still be recorded. */
const GENERATION_PERSISTENCE_RESERVE_MS = 10_000;
/** Bounded preview retention for a source-derived result. */
const GENERATION_RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Persistence attempts for one already observed receipt and result. */
const GENERATION_PERSISTENCE_ATTEMPTS = 3;
/**
 * Attempts the anonymous receipt gets before anything else can leave.
 *
 * They run while the request is still here, joined and finite. Nothing is
 * detached to finish later: this is the accounting an already incurred charge
 * is owed, not a background job.
 */
const GENERATION_RECEIPT_ATTEMPTS = 3;
/** The read-only cost reconciliation is short and attempted at most once. */
const GENERATION_COST_LOOKUP_MS = 5000;

const GENERATION_OPERATION = "morning_brief_generation";
const GENERATION_PROVIDER = "openrouter";
const GENERATION_PURPOSE = "preview" as const;

export type MorningBriefGenerationConflict =
  | MorningBriefCollectionConflict
  | "generation-in-progress";

type MorningBriefGenerationExecution =
  | {
      readonly kind: "not-executed";
      readonly reason: MorningBriefGenerationSkipReason;
    }
  | { readonly kind: "invalid-anchor"; readonly message: string }
  | {
      readonly kind: "conflict";
      readonly reason: MorningBriefGenerationConflict;
    }
  | {
      readonly kind: "collection-failed";
      readonly occurrence: MorningBriefCollectionOccurrenceView;
      readonly retryAfterSeconds?: number;
    }
  | {
      readonly kind: "generated";
      readonly occurrence: MorningBriefCollectionOccurrenceView;
      readonly generation: MorningBriefGenerationView;
    }
  | {
      readonly kind: "already-generated";
      readonly occurrence: MorningBriefCollectionOccurrenceView;
      readonly generation: MorningBriefGenerationView;
    }
  | {
      readonly kind: "collection-completed-without-generation";
      readonly occurrence: MorningBriefCollectionOccurrenceView;
    };

/** What the in-transaction handoff produced for the request that follows it. */
type AdmittedGeneration =
  | {
      readonly kind: "reserved";
      readonly admission: MorningBriefGenerationAdmission;
      readonly plan: GenerationRequestPlan;
    }
  | { readonly kind: "skipped" };

function generationKeyOf(
  context: MorningBriefCollectionHandoffContext,
): MorningBriefGenerationKey {
  return {
    owner: context.admission.owner,
    scheduledFor: context.admission.scheduledFor,
    collectionKind: context.admission.collectionKind,
    collectionVersion: context.occurrence.collectionVersion,
  };
}

/**
 * The member's persisted locale, read with the same transaction that reserves.
 *
 * `org_members_metadata` is the member's own preference row and the occurrence's
 * durable parent, so the language is resolved from state this transaction has
 * already locked rather than from a separate, possibly newer read.
 */
async function loadMemberLocale(
  tx: Tx,
  owner: MorningBriefCollectionOwner,
): Promise<string | null> {
  const [member] = await tx
    .select({ locale: orgMembersMetadata.locale })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, owner.orgId),
        eq(orgMembersMetadata.userId, owner.userId),
      ),
    )
    .limit(1);
  return member?.locale ?? null;
}

/**
 * The finite reservation window.
 *
 * It is this attempt's own phase ownership, not the collection lease, and it
 * never outlives the occurrence's claimable lifetime.
 */
function reservationExpiry(at: Date, occurrenceCreatedAt: Date): Date {
  const occurrenceLifetimeEnd =
    occurrenceCreatedAt.getTime() + GENERATION_RESULT_RETENTION_MS;
  return new Date(
    Math.min(at.getTime() + GENERATION_RESERVATION_MS, occurrenceLifetimeEnd),
  );
}

function admissionOf(args: {
  readonly context: MorningBriefCollectionHandoffContext;
  readonly plan: GenerationRequestPlan;
  readonly locale: string | null;
  readonly bundle: MorningBriefSlackBundle;
}): MorningBriefGenerationAdmission {
  const { context, plan } = args;
  const language = resolveGenerationLanguage(args.locale);
  return {
    key: generationKeyOf(context),
    attemptId: randomUUID(),
    membershipId: context.admission.membershipId,
    agentId: context.admission.agentId,
    model: MORNING_BRIEF_GENERATION_MODEL,
    language: language.language,
    languageSource: language.source,
    inputDigest: plan.inputDigest,
    inputItems: plan.inputItems,
    includedItems: plan.includedItems,
    inputReduced: plan.inputReduced,
    sourceCoverage: args.bundle.coverage,
    reservedAt: context.at,
    reservationExpiresAt: reservationExpiry(
      context.at,
      context.occurrence.createdAt,
    ),
    expiresAt: new Date(context.at.getTime() + GENERATION_RESULT_RETENTION_MS),
  };
}

/**
 * Admit this occurrence's single generation, inside the finalize transaction.
 *
 * A bundle with no candidates never reaches a provider. A healthy empty read
 * and a bounded read that happened to find nothing are recorded under distinct
 * terminal states, so an incomplete read can never be reported as an empty day.
 */
async function admitGeneration(
  tx: Tx,
  context: MorningBriefCollectionHandoffContext,
): Promise<AdmittedGeneration> {
  const { bundle } = context;
  const locale = await loadMemberLocale(tx, context.admission.owner);
  const plan = planGenerationRequest({
    bundle,
    language: resolveGenerationLanguage(locale).language,
  });
  const admission = admissionOf({ context, plan, locale, bundle });

  if (bundle.entries.length === 0) {
    const state: Extract<
      MorningBriefGenerationState,
      "skipped_empty" | "skipped_incomplete"
    > = bundle.coverage === "empty" ? "skipped_empty" : "skipped_incomplete";
    if (!(await recordMorningBriefGenerationSkip(tx, admission, state))) {
      throw new Error("Morning Brief generation slot was already taken");
    }
    return { kind: "skipped" };
  }
  if (!(await reserveMorningBriefGeneration(tx, admission))) {
    // The slot is the occurrence's primary key, and a completed occurrence can
    // never be re-claimed, so reaching this means an invariant is broken rather
    // than that a second caller legitimately arrived.
    throw new Error("Morning Brief generation slot was already taken");
  }
  return { kind: "reserved", admission, plan };
}

/**
 * Whether this invocation's charge actually reached durable storage.
 *
 * `unresolved` is the honest terminal state of a finite, exhausted attempt at
 * recording a charge that was really incurred. It is deliberately not reported
 * as a durable receipt and never as a cost of zero: the amount is known, the
 * record of it is not.
 */
type ReceiptRecord = MorningBriefPlatformReceiptView["recorded"];

function receiptView(
  values: MorningBriefPlatformReceiptValues,
  recorded: ReceiptRecord,
): MorningBriefPlatformReceiptView {
  return {
    recorded,
    attemptId: values.attemptId,
    provider: "openrouter",
    requestedModel: values.requestedModel,
    returnedModel: values.returnedModel,
    providerGenerationId: values.providerGenerationId,
    outcome: values.outcome,
    cost: {
      state: values.costState,
      value: values.costValue,
      unit:
        values.costUnit === "openrouter_credits" ? "openrouter_credits" : null,
      source: values.costSource ?? null,
    },
    tokens: {
      prompt: values.promptTokens,
      completion: values.completionTokens,
      reasoning: values.reasoningTokens,
      cached: values.cachedTokens,
      total: values.totalTokens,
    },
  };
}

function receiptCost(cost: PlatformGenerationCost | null): {
  readonly costState: MorningBriefPlatformReceiptValues["costState"];
  readonly costValue: string | null;
  readonly costUnit: string | null;
  readonly costSource: MorningBriefPlatformReceiptValues["costSource"];
} {
  if (cost === null) {
    return {
      costState: "invocation_unknown",
      costValue: null,
      costUnit: null,
      costSource: null,
    };
  }
  if (cost.state === "unavailable") {
    return {
      costState: "unavailable",
      costValue: null,
      costUnit: null,
      costSource: null,
    };
  }
  return {
    costState: "reported",
    costValue: cost.value,
    costUnit: cost.unit,
    costSource: cost.source,
  };
}

function receiptValuesOf(args: {
  readonly attemptId: string;
  readonly outcome: MorningBriefPlatformReceiptValues["outcome"];
  readonly observation: PlatformGenerationObservation | null;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}): MorningBriefPlatformReceiptValues {
  const tokens: PlatformGenerationTokens =
    args.observation?.tokens ?? unknownInvocationTokens();
  return {
    attemptId: args.attemptId,
    operation: GENERATION_OPERATION,
    provider: GENERATION_PROVIDER,
    requestedModel: MORNING_BRIEF_GENERATION_MODEL,
    returnedModel: args.observation?.returnedModel ?? null,
    providerGenerationId: args.observation?.generationId ?? null,
    outcome: args.outcome,
    ...receiptCost(args.observation?.cost ?? null),
    promptTokens: tokens.prompt,
    completionTokens: tokens.completion,
    reasoningTokens: tokens.reasoning,
    cachedTokens: tokens.cached,
    totalTokens: tokens.total,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
  };
}

/** What the model returned, once the transport outcome is classified. */
type InterpretedOutcome =
  | {
      readonly kind: "accept";
      readonly decision: "deliver" | "skip";
      readonly skipReason: string | null;
      readonly title: string | null;
      readonly markdown: string | null;
      readonly bytes: number | null;
    }
  | {
      readonly kind: "reject";
      readonly state: Extract<
        MorningBriefGenerationState,
        | "output_rejected"
        | "provider_failed"
        | "result_discarded"
        | "invocation_outcome_unknown"
      >;
      readonly failureReason: MorningBriefGenerationFailureReason;
    };

/**
 * Classify a readable response, which the provider has already been paid for.
 *
 * A truncated completion, a tool call, malformed JSON, a citation this request
 * never supplied and an empty or oversized brief are all failures. None of them
 * is a skip, and none of them is repaired by a second request.
 */
function interpretResponse(
  observation: PlatformGenerationObservation,
  sources: ReadonlyMap<string, GenerationSource>,
  coverage: MorningBriefCoverageFacts,
  language: string,
): InterpretedOutcome {
  if (observation.completionError) {
    return {
      kind: "reject",
      state: "output_rejected",
      failureReason: "provider_error",
    };
  }
  if (observation.finishReason === "length") {
    return {
      kind: "reject",
      state: "output_rejected",
      failureReason: "output_truncated",
    };
  }
  // Either signal is enough. This pipeline sends no tools, so a populated
  // tool-call field is unexpected output even when the provider labelled the
  // completion `stop`.
  if (observation.finishReason === "tool_calls" || observation.toolCalls) {
    return {
      kind: "reject",
      state: "output_rejected",
      failureReason: "unexpected_tool_calls",
    };
  }
  if (observation.finishReason !== "stop" || observation.content === null) {
    return {
      kind: "reject",
      state: "output_rejected",
      failureReason: "invalid_shape",
    };
  }
  const interpreted = interpretGenerationOutput({
    content: observation.content,
    sources,
    coverage,
    language,
  });
  if (interpreted.kind === "rejected") {
    return {
      kind: "reject",
      state: "output_rejected",
      failureReason: interpreted.reason,
    };
  }
  return interpreted.result.decision === "skip"
    ? {
        kind: "accept",
        decision: "skip",
        skipReason: interpreted.result.reason,
        title: null,
        markdown: null,
        bytes: null,
      }
    : {
        kind: "accept",
        decision: "deliver",
        skipReason: null,
        title: interpreted.result.title,
        markdown: interpreted.result.markdown,
        bytes: interpreted.result.bytes,
      };
}

function classifyTransport(
  outcome: Exclude<PlatformGenerationOutcome, { kind: "response" }>,
): {
  readonly receiptOutcome: MorningBriefPlatformReceiptValues["outcome"];
  readonly interpreted: Extract<InterpretedOutcome, { kind: "reject" }>;
} {
  if (outcome.kind === "provider-error") {
    return {
      receiptOutcome: "provider_error",
      interpreted: {
        kind: "reject",
        state: "provider_failed",
        failureReason: "provider_error",
      },
    };
  }
  if (outcome.kind === "response-unreadable") {
    return {
      receiptOutcome: "response_unreadable",
      interpreted: {
        kind: "reject",
        state: "provider_failed",
        failureReason: "response_unreadable",
      },
    };
  }
  return {
    receiptOutcome: "invocation_unknown",
    interpreted: {
      kind: "reject",
      // A request that never produced a readable response may still have
      // reached the provider, so this is unknown rather than a clean failure.
      state: "invocation_outcome_unknown",
      failureReason: "transport_failed",
    },
  };
}

/**
 * Read one stored generation into its response view.
 *
 * Stored values are validated rather than defaulted. `source_coverage` decides
 * whether an empty day was healthy and `result_bytes` is the real UTF-8 size of
 * the rendered brief, so substituting a value for either would report a
 * different fact than the one that was accepted. Both are constrained by the
 * table's own check constraints, so a violation here means the row is corrupt
 * or was written by something outside this contract — which is worth failing
 * loudly for, not papering over.
 */
function viewOfRow(
  row: MorningBriefGenerationRow,
  receipt: MorningBriefPlatformReceiptView | null,
): MorningBriefGenerationView {
  const coverage = MORNING_BRIEF_GENERATION_SOURCE_COVERAGES.find(
    (candidate) => {
      return candidate === row.sourceCoverage;
    },
  );
  if (coverage === undefined) {
    throw new Error(
      "Morning Brief generation stores an unsupported source coverage",
    );
  }
  if (
    row.decision === "deliver" &&
    (row.resultTitle === null ||
      row.resultMarkdown === null ||
      row.resultBytes === null)
  ) {
    throw new Error("Morning Brief generation stores an incomplete result");
  }
  return {
    purpose: GENERATION_PURPOSE,
    state: row.state,
    attemptId: row.attemptId,
    model: row.model,
    promptVersion: row.promptVersion,
    resultSchemaVersion: row.resultSchemaVersion,
    language: row.language,
    languageSource: row.languageSource,
    inputItems: row.inputItems,
    includedItems: row.includedItems,
    inputReduced: row.inputReduced,
    sourceCoverage: coverage,
    inputDigest: row.inputDigest,
    reservedAt: row.reservedAt.toISOString(),
    reservationExpiresAt: row.reservationExpiresAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    result:
      row.decision === "deliver" &&
      row.resultTitle !== null &&
      row.resultMarkdown !== null &&
      row.resultBytes !== null
        ? {
            decision: "deliver",
            title: row.resultTitle,
            markdown: row.resultMarkdown,
            bytes: row.resultBytes,
          }
        : row.decision === "skip"
          ? { decision: "skip", reason: "nothing_actionable" }
          : null,
    failureReason: row.failureReason,
    receipt,
  };
}

/**
 * The view for an attempt whose owner-state write could not be committed.
 *
 * The receipt is durable, so the spend is not lost; the slot stays reserved and
 * a later explicit invocation resolves it to `invocation_outcome_unknown`. This
 * reports exactly that, rather than a row read that does not exist.
 */
function viewOfUncommittedAttempt(
  admission: MorningBriefGenerationAdmission,
  coverage: MorningBriefSlackBundle["coverage"],
  receipt: MorningBriefPlatformReceiptView | null,
  failureReason: MorningBriefGenerationFailureReason,
): MorningBriefGenerationView {
  return {
    purpose: GENERATION_PURPOSE,
    state: "reserved",
    attemptId: admission.attemptId,
    model: admission.model,
    promptVersion: MORNING_BRIEF_GENERATION_PROMPT_VERSION,
    resultSchemaVersion: MORNING_BRIEF_GENERATION_RESULT_SCHEMA_VERSION,
    language: admission.language,
    languageSource: admission.languageSource,
    inputItems: admission.inputItems,
    includedItems: admission.includedItems,
    inputReduced: admission.inputReduced,
    sourceCoverage: coverage,
    inputDigest: admission.inputDigest,
    reservedAt: admission.reservedAt.toISOString(),
    reservationExpiresAt: admission.reservationExpiresAt.toISOString(),
    expiresAt: admission.expiresAt.toISOString(),
    finishedAt: null,
    result: null,
    failureReason,
    receipt,
  };
}

interface PersistenceArgs {
  readonly fence: MorningBriefGenerationFence;
  readonly receipt: MorningBriefPlatformReceiptValues;
  /** What the receipt's own bounded attempts already achieved. */
  readonly recorded: ReceiptRecord;
  readonly interpreted: InterpretedOutcome;
  /** The durable record of the authority the content was produced under. */
  readonly occurrenceRow: MorningBriefCollectionOccurrenceRow;
}

type OwnerWriteResult =
  | { readonly kind: "written"; readonly row: MorningBriefGenerationRow }
  | { readonly kind: "owner-revoked" };

/**
 * The outcome this write may actually commit, decided where it is admitted.
 *
 * The canonical authority was proved before persistence began, outside any
 * transaction, because it waits on Clerk. That proof describes the past: a
 * Settings disable, an Agent deletion or a Slack rebinding can commit while
 * this write waits for its locks. Re-resolving the *local* half here — through
 * the shared admission point, which holds the rows those mutators really write
 * — is what stops a decision made before the wait from turning into owner
 * content after it. The remote half is deliberately not re-resolved: a
 * transaction is never held open across a network round trip.
 *
 * A write that stores no content skips it. Such a write only records why this
 * already-observed invocation produced nothing, so it neither needs nor should
 * take another owner's authority rows.
 */
function admittedOutcome(
  args: PersistenceArgs,
  authority: MorningBriefLocalAuthority,
): InterpretedOutcome {
  return authority.kind === "current"
    ? args.interpreted
    : lapsedAuthorityOutcome(authority);
}

/**
 * Write the owner-scoped outcome under the fence the reservation was admitted
 * with.
 *
 * The order is the whole point. The owner fence and the local authority rows
 * are taken first, then this attempt's own slot, and only then is the authority
 * resolved — so every wait this transaction performs is already behind it when
 * the decision is made. The three things only this layer can decide then happen
 * at that one instant: a caller that cancelled commits nothing at all, a result
 * whose authority lapsed while it waited is recorded as discarded instead of
 * accepted, and the reservation deadline is compared against the clock read
 * there rather than against an earlier reading. Content that became late during
 * those waits is never stored; the honest `result_discarded` outcome is
 * recorded instead, because refusing both would leave the slot looking merely
 * stale. A revoked owner matches neither write, and nothing here recreates an
 * owner row.
 *
 * Cancellation after this transaction commits cannot retract it. The guarantee
 * is that nothing is committed for a caller that had already cancelled when its
 * write was admitted, not that accepted bytes can be taken back afterwards.
 */
async function commitOwnerOutcome(
  tx: Tx,
  args: PersistenceArgs,
  signal: AbortSignal,
): Promise<OwnerWriteResult> {
  let interpreted = args.interpreted;
  if (interpreted.kind === "accept") {
    if (!(await lockCollectionOwner(tx, args.fence.key.owner))) {
      return { kind: "owner-revoked" };
    }
    const admission = await admitMorningBriefLocalAuthority(
      tx,
      args.occurrenceRow,
      async () => {
        return await lockMorningBriefGeneration(tx, args.fence.key);
      },
    );
    if (!admission.guarded) {
      return { kind: "owner-revoked" };
    }
    interpreted = admittedOutcome(args, admission.authority);
  } else if (!(await holdMorningBriefGenerationSlot(tx, args.fence))) {
    return { kind: "owner-revoked" };
  }
  // Admitted after every wait this transaction performs and before any mutation
  // is issued. Throwing here unwinds the whole transaction, so a cancelled
  // caller leaves the slot exactly as its reservation left it.
  signal.throwIfAborted();
  const at = nowDate();
  if (interpreted.kind === "accept") {
    const accepted = await acceptMorningBriefGenerationResult(
      tx,
      args.fence,
      at,
      {
        decision: interpreted.decision,
        skipReason: interpreted.skipReason,
        title: interpreted.title,
        markdown: interpreted.markdown,
        bytes: interpreted.bytes,
      },
    );
    if (accepted.kind === "written") {
      return { kind: "written", row: accepted.row };
    }
    const discarded = await recordMorningBriefGenerationOutcome(
      tx,
      args.fence,
      at,
      {
        state: "result_discarded",
        failureReason: "reservation_expired",
      },
    );
    return discarded.kind === "written"
      ? { kind: "written", row: discarded.row }
      : { kind: "owner-revoked" };
  }
  const written = await recordMorningBriefGenerationOutcome(
    tx,
    args.fence,
    at,
    {
      state: interpreted.state,
      failureReason: interpreted.failureReason,
    },
  );
  return written.kind === "written"
    ? { kind: "written", row: written.row }
    : { kind: "owner-revoked" };
}

/**
 * Whether the authority this occurrence was admitted under still holds.
 *
 * The occurrence row is the durable record of that authority, so the live
 * canonical resolution is compared against it field by field rather than
 * against anything a caller supplied. A different-but-valid current binding is
 * a different authority: it does not license invoking for the old one, nor
 * releasing what the old one produced.
 */
type GenerationAuthority = MorningBriefLocalAuthority;

const generationAuthorityStillCurrent$ = command(
  async (
    { set },
    occurrence: MorningBriefCollectionOccurrenceRow,
    signal: AbortSignal,
  ): Promise<GenerationAuthority> => {
    const resolved = await set(
      currentMorningBriefCollectionAuthority$,
      {
        owner: { orgId: occurrence.orgId, userId: occurrence.userId },
        scheduledFor: occurrence.scheduledFor,
      },
      signal,
    );
    signal.throwIfAborted();
    if (resolved.kind !== "admitted") {
      return { kind: "not-executed", reason: resolved.reason };
    }
    return morningBriefCollectionBindingMatches(occurrence, resolved.admission)
      ? { kind: "current" }
      : { kind: "binding-changed" };
  },
);

/** The terminal record an authority that no longer holds produces. */
function lapsedAuthorityOutcome(
  authority: Exclude<GenerationAuthority, { kind: "current" }>,
): Extract<InterpretedOutcome, { kind: "reject" }> {
  return {
    kind: "reject",
    state: "result_discarded",
    failureReason:
      authority.kind === "binding-changed"
        ? "binding_changed"
        : "owner_revoked",
  };
}

type PersistOutcome =
  | { readonly kind: "committed"; readonly write: OwnerWriteResult }
  | { readonly kind: "uncommitted" };

/**
 * Record the anonymous charge, with bounded attempts of the same observation.
 *
 * Every attempt is awaited here, so an exhausted one is a finished fact rather
 * than a promise still running somewhere. The insert is keyed by the opaque
 * attempt id and conflict-free, so retrying — and a later attempt racing an
 * earlier one that actually committed — leaves exactly one cost record, and
 * never replaces a committed observation with this one.
 *
 * It takes no owner lock and no erasure admission: the charge belongs to the
 * platform, so it is still recorded for an owner who was revoked or erased
 * while the request was in flight.
 *
 * Aborts are settled rather than propagated. A caller who cancelled still
 * cancels, but only after the request that may already have been billed has
 * been given its finite chance to be written down.
 */
async function persistReceipt(
  db: Db,
  receipt: MorningBriefPlatformReceiptValues,
): Promise<ReceiptRecord> {
  let attempt = 0;
  while (attempt < GENERATION_RECEIPT_ATTEMPTS) {
    attempt += 1;
    const settled = await settleIncludingAbort(
      recordPlatformGenerationReceipt(db, receipt),
    );
    if (settled.ok) {
      return "durable";
    }
  }
  return "unresolved";
}

/**
 * Commit the owner-scoped outcome, retrying the receipt only if it still owes.
 *
 * The two writes are separate on purpose. The receipt is anonymous platform
 * spend and was already given its own bounded attempts before anything could
 * refuse the owner-scoped write, so a storage fault that has since cleared gets
 * one more finite chance here rather than making the owner write wait on
 * accounting — and an owner write that fails can never undo a committed charge.
 *
 * When every owner attempt fails the slot stays reserved: a later explicit
 * invocation resolves it to `invocation_outcome_unknown`, and nothing sends
 * again.
 */
async function persistObservation(
  db: Db,
  args: PersistenceArgs,
  signal: AbortSignal,
): Promise<{
  readonly outcome: PersistOutcome;
  readonly recorded: ReceiptRecord;
}> {
  const recorded =
    args.recorded === "durable"
      ? "durable"
      : await persistReceipt(db, args.receipt);
  let attempt = 0;
  while (attempt < GENERATION_PERSISTENCE_ATTEMPTS) {
    // A cancelled caller commits nothing to the owner slot, and no number of
    // retries can change that, so the reserve is spent on real faults only.
    if (signal.aborted) {
      break;
    }
    attempt += 1;
    const settled = await settleIncludingAbort(
      db.transaction(async (tx) => {
        return await commitOwnerOutcome(tx, args, signal);
      }),
    );
    if (settled.ok) {
      return { outcome: { kind: "committed", write: settled.value }, recorded };
    }
  }
  return { outcome: { kind: "uncommitted" }, recorded };
}

async function loadReceiptView(
  db: Db,
  attemptId: string,
): Promise<MorningBriefPlatformReceiptView | null> {
  const row = await readPlatformGenerationReceipt(db, attemptId);
  if (!row) {
    return null;
  }
  return {
    // Read back out of the table, so the record is durable by construction.
    recorded: "durable",
    attemptId: row.attemptId,
    provider: "openrouter",
    requestedModel: row.requestedModel,
    returnedModel: row.returnedModel,
    providerGenerationId: row.providerGenerationId,
    outcome: row.outcome,
    cost: {
      state: row.costState,
      value: row.costValue,
      unit: row.costUnit === "openrouter_credits" ? "openrouter_credits" : null,
      source: row.costSource,
    },
    tokens: {
      prompt: row.promptTokens,
      completion: row.completionTokens,
      reasoning: row.reasoningTokens,
      cached: row.cachedTokens,
      total: row.totalTokens,
    },
  };
}

/** What the final, local release fence decided about one stored result. */
type GenerationRelease =
  | { readonly kind: "released"; readonly row: MorningBriefGenerationRow }
  | { readonly kind: "gone" }
  | {
      readonly kind: "not-executed";
      readonly reason: MorningBriefGenerationSkipReason;
    }
  | { readonly kind: "binding-changed" }
  | { readonly kind: "owner-revoked" };

/**
 * Prove — last, and under the owner lock — that this content may still go out.
 *
 * Every earlier check describes an instant that has already passed: the Clerk
 * membership resolution waits on the network, and the receipt lookup waits on
 * the database. A deletion, a Settings disable, a rebinding or the retention
 * deadline can all land during those waits, so this fence takes every authority
 * parent before it re-reads the row `FOR UPDATE`. The copy it returns therefore
 * cannot be deleted out from under it while canonical authority is re-resolved.
 * The maintenance purge selects `SKIP LOCKED` and simply leaves a held row for
 * its next pass; the owner sweep, the member cleanup cascade and the Agent
 * deletion cascade all have to wait for this transaction. Reading the row a
 * second time afterwards would reopen exactly the interval that lock closes, so
 * the pinned copy is what is returned.
 *
 * The shared admission point holds Agent, Settings and Slack rows, then the
 * caller's generation row, then reuses the canonical reader. The clock is
 * sampled last — after every wait this fence performs. Equality with
 * the retention deadline is already expired: a result becomes unreadable at its
 * deadline, whether or not the maintenance purge has physically removed it yet.
 *
 * Nothing here writes. A result that may not be released is simply not
 * released; no replacement owner row is created and no stored row is rewritten.
 */
async function releaseStoredGeneration(
  tx: Tx,
  args: {
    readonly key: MorningBriefGenerationKey;
    readonly attemptId: string;
    readonly occurrenceRow: MorningBriefCollectionOccurrenceRow;
  },
): Promise<GenerationRelease> {
  if (!(await lockCollectionOwner(tx, args.key.owner))) {
    return { kind: "owner-revoked" };
  }
  const admission = await admitMorningBriefLocalAuthority(
    tx,
    args.occurrenceRow,
    async () => {
      return await lockMorningBriefGeneration(tx, args.key);
    },
  );
  const row = admission.guarded;
  if (
    !row ||
    row.attemptId !== args.attemptId ||
    row.executionPurpose !== GENERATION_PURPOSE
  ) {
    return { kind: "gone" };
  }
  // Sampled after every lock and every read this fence performs, so the deadline
  // comparison describes the instant this release is really decided.
  if (row.expiresAt.getTime() <= nowDate().getTime()) {
    return { kind: "gone" };
  }
  if (admission.authority.kind === "not-executed") {
    return { kind: "not-executed", reason: admission.authority.reason };
  }
  if (admission.authority.kind === "binding-changed") {
    return { kind: "binding-changed" };
  }
  return { kind: "released", row };
}

/**
 * Report what an occurrence that already finished collecting holds.
 *
 * It never recollects and never regenerates. A stale reservation is settled as
 * unknown, because the original request may already have reached the provider.
 * Releasing a stored result is different: it hands back source-derived content,
 * so it requires the same live authority the content was produced under. A
 * brief that has since been disabled, or whose membership, installation, Agent
 * or Slack binding changed, does not get the previous binding's work.
 */
const resolveExistingGeneration$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly key: MorningBriefGenerationKey;
      readonly occurrence: MorningBriefCollectionOccurrenceView;
    },
    signal: AbortSignal,
  ): Promise<MorningBriefGenerationExecution> => {
    const { db, key, occurrence } = args;
    const row = await readMorningBriefGeneration(db, key, GENERATION_PURPOSE);
    signal.throwIfAborted();
    if (!row) {
      return { kind: "collection-completed-without-generation", occurrence };
    }

    if (row.state === "reserved") {
      const at = nowDate();
      // Equality with the deadline is already expired.
      if (row.reservationExpiresAt.getTime() > at.getTime()) {
        return { kind: "conflict", reason: "generation-in-progress" };
      }
      // Settling a lapsed reservation records an operational fact and releases
      // no content, so it is not gated on the content-release authority below.
      const resolved = await db.transaction(async (tx) => {
        return await resolveStaleMorningBriefGeneration(tx, key);
      });
      signal.throwIfAborted();
      if (!resolved) {
        return { kind: "collection-completed-without-generation", occurrence };
      }
      return {
        kind: "already-generated",
        occurrence,
        generation: viewOfRow(
          resolved,
          await loadReceiptView(db, resolved.attemptId),
        ),
      };
    }

    const occurrenceRow = await readMorningBriefCollectionOccurrence(db, {
      owner: key.owner,
      scheduledFor: key.scheduledFor,
      collectionKind: key.collectionKind,
    });
    signal.throwIfAborted();
    if (!occurrenceRow) {
      // The occurrence cascaded away, so nothing here has an authority to
      // release under.
      return { kind: "collection-completed-without-generation", occurrence };
    }
    const authority = await set(
      generationAuthorityStillCurrent$,
      occurrenceRow,
      signal,
    );
    signal.throwIfAborted();
    if (authority.kind === "not-executed") {
      return { kind: "not-executed", reason: authority.reason };
    }
    if (authority.kind === "binding-changed") {
      return { kind: "conflict", reason: "binding-changed" };
    }

    // The last wait this request performs, and then the fence that decides
    // whether what it read may still be released. Nothing awaits after it.
    const receipt = await loadReceiptView(db, row.attemptId);
    signal.throwIfAborted();
    const released = await db.transaction(async (tx) => {
      return await releaseStoredGeneration(tx, {
        key,
        attemptId: row.attemptId,
        occurrenceRow,
      });
    });
    signal.throwIfAborted();
    if (released.kind === "gone") {
      // Deleted, replaced or past its retention deadline. The occurrence is
      // still completed, so this is a collection that holds no readable
      // generation — never an occurrence free to invoke the provider again.
      return { kind: "collection-completed-without-generation", occurrence };
    }
    if (released.kind === "owner-revoked") {
      return { kind: "conflict", reason: "owner-revoked" };
    }
    if (released.kind === "not-executed") {
      return { kind: "not-executed", reason: released.reason };
    }
    if (released.kind === "binding-changed") {
      return { kind: "conflict", reason: "binding-changed" };
    }
    return {
      kind: "already-generated",
      occurrence,
      generation: viewOfRow(released.row, receipt),
    };
  },
);

interface InvocationArgs {
  readonly db: Db;
  readonly apiKey: string;
  readonly admission: MorningBriefGenerationAdmission;
  readonly plan: GenerationRequestPlan;
  readonly sources: ReadonlyMap<string, GenerationSource>;
  readonly coverage: MorningBriefSlackBundle["coverage"];
  readonly occurrence: MorningBriefCollectionOccurrenceView;
  /** The durable record of the authority this invocation acts under. */
  readonly occurrenceRow: MorningBriefCollectionOccurrenceRow;
}

/**
 * Reconcile an amount the completion response did not carry.
 *
 * Read-only, bounded, and attempted at most once. A delayed, missing, refused
 * or malformed answer leaves the cost exactly as unknown as it already was; it
 * never becomes zero, and it is never a reason to send the completion again.
 */
async function reconcileCost(
  args: {
    readonly apiKey: string;
    readonly observation: PlatformGenerationObservation;
  },
  providerSignal: AbortSignal,
): Promise<PlatformGenerationObservation> {
  const { observation } = args;
  if (observation.cost.state === "reported" || !observation.generationId) {
    return observation;
  }
  const reconciled = await lookupPlatformGenerationCost(
    { apiKey: args.apiKey, generationId: observation.generationId },
    AbortSignal.any([
      providerSignal,
      AbortSignal.timeout(GENERATION_COST_LOOKUP_MS),
    ]),
  );
  return reconciled.state === "reported"
    ? { ...observation, cost: reconciled }
    : observation;
}

/**
 * The collector's own verdict plus the candidates the plan had to drop.
 *
 * Both come from the same place the request was built from, so the note the
 * reader sees cannot disagree with what the model was told.
 */
function coverageFactsOf(args: InvocationArgs): MorningBriefCoverageFacts {
  return {
    collected: args.coverage,
    omittedForSize: args.plan.droppedItems,
  };
}

/**
 * The irreversible step, and the one place cancellation must not short-circuit.
 *
 * Every await here deliberately settles rather than propagates: once the
 * request may have reached the provider, the caller still has to record what it
 * observed. Cancellation is applied by the caller, after the anonymous charge
 * has had its bounded joined attempts at becoming durable and before any of the
 * answer can become owner content. Recording a charge is not permission to
 * accept content, and nothing here writes or releases owner content.
 */
async function requestAndRecordCharge(
  args: {
    readonly db: Db;
    readonly apiKey: string;
    readonly attemptId: string;
    readonly body: string;
    readonly sources: ReadonlyMap<string, GenerationSource>;
    /** The same numbers the request was built from, for the coverage note. */
    readonly coverage: MorningBriefCoverageFacts;
    readonly language: string;
  },
  providerSignal: AbortSignal,
): Promise<{
  readonly receipt: MorningBriefPlatformReceiptValues;
  readonly recorded: ReceiptRecord;
  readonly interpreted: InterpretedOutcome;
}> {
  const startedAt = nowDate();
  const outcome = await requestPlatformGeneration(
    { apiKey: args.apiKey, body: args.body },
    providerSignal,
  );
  const observed =
    outcome.kind === "response"
      ? await reconcileCost(
          { apiKey: args.apiKey, observation: outcome.observation },
          providerSignal,
        )
      : null;
  const finishedAt = nowDate();
  const classified =
    observed === null
      ? classifyTransport(
          outcome as Exclude<PlatformGenerationOutcome, { kind: "response" }>,
        )
      : {
          receiptOutcome: "response_received" as const,
          interpreted: interpretResponse(
            observed,
            args.sources,
            args.coverage,
            args.language,
          ),
        };
  const receipt = receiptValuesOf({
    attemptId: args.attemptId,
    outcome: classified.receiptOutcome,
    observation: observed,
    startedAt,
    finishedAt,
  });
  // The charge is already incurred, so it is recorded here — before the
  // caller's cancellation check and before the authority resolution that
  // decides the owner-scoped write, either of which can leave this request
  // entirely. A transient storage fault at this point used to discard an
  // observed charge; these attempts are bounded, joined and finite instead.
  const recorded = await persistReceipt(args.db, receipt);
  return { receipt, recorded, interpreted: classified.interpreted };
}

/**
 * Report what persistence actually achieved, for the owner and the charge.
 *
 * The receipt is reported at whatever its own bounded attempts reached, so an
 * owner-scoped write that failed never downgrades a committed charge and an
 * unresolved charge is never dressed up as a durable one.
 */
function generationOfPersistence(args: {
  readonly admission: MorningBriefGenerationAdmission;
  readonly coverage: MorningBriefSlackBundle["coverage"];
  readonly receipt: MorningBriefPlatformReceiptValues;
  readonly persisted: {
    readonly outcome: PersistOutcome;
    readonly recorded: ReceiptRecord;
  };
}): MorningBriefGenerationView {
  const { admission, coverage, persisted } = args;
  const view = receiptView(args.receipt, persisted.recorded);
  if (persisted.outcome.kind === "uncommitted") {
    return viewOfUncommittedAttempt(
      admission,
      coverage,
      view,
      "persistence_failed",
    );
  }
  if (persisted.outcome.write.kind === "owner-revoked") {
    // The incurred cost stays recorded; no owner row is recreated to hold it.
    return viewOfUncommittedAttempt(admission, coverage, view, "owner_revoked");
  }
  return viewOfRow(persisted.outcome.write.row, view);
}

/**
 * What this attempt may still spend at `at`, after the persistence reserve.
 *
 * Zero or negative means the reservation is exhausted: whatever is left is
 * owed to recording the outcome, so nothing may be sent.
 */
function remainingProviderBudgetMs(
  reservationExpiresAt: Date,
  at: Date,
): number {
  return Math.min(
    GENERATION_PROVIDER_DEADLINE_MS,
    reservationExpiresAt.getTime() -
      at.getTime() -
      GENERATION_PERSISTENCE_RESERVE_MS,
  );
}

/**
 * Record an attempt that a deterministic check stopped before provider contact.
 *
 * Nothing was sent, so this is a known failure rather than an unknown outcome.
 * It takes the slot the same way every other owner-scoped write does, and a
 * revoked owner matches nothing instead of being recreated.
 */
async function recordUninvokedAttempt(
  args: InvocationArgs,
  fence: MorningBriefGenerationFence,
  failureReason: MorningBriefGenerationFailureReason,
): Promise<MorningBriefGenerationExecution> {
  const written = await args.db.transaction(async (tx) => {
    if (!(await holdMorningBriefGenerationSlot(tx, fence))) {
      return { kind: "not-owned" } as const;
    }
    // Sampled after the locks this transaction waited on, so the instant
    // recorded is the one the write is really admitted at.
    return await recordMorningBriefGenerationOutcome(tx, fence, nowDate(), {
      state: "not_invoked",
      failureReason,
    });
  });
  return {
    kind: "generated",
    occurrence: args.occurrence,
    generation:
      written.kind === "written"
        ? viewOfRow(written.row, null)
        : viewOfUncommittedAttempt(
            args.admission,
            args.coverage,
            null,
            "owner_revoked",
          ),
  };
}

/**
 * Make the single provider request this reservation admitted, then record it.
 *
 * Everything before this point is reversible; this is not, so the live
 * authority is proven twice: once before any provider contact, and once before
 * any of the answer becomes owner content. The deadline is checked before
 * contact — equality with the reservation deadline is already expired — and the
 * request is never retried, because the reservation is already durable and a
 * resent request could be a second inference.
 */
const invokeAndPersist$ = command(
  async (
    { set },
    args: InvocationArgs,
    signal: AbortSignal,
  ): Promise<MorningBriefGenerationExecution> => {
    const { admission, db } = args;
    const fence: MorningBriefGenerationFence = {
      key: admission.key,
      attemptId: admission.attemptId,
      membershipId: admission.membershipId,
    };
    const uninvoked = async (
      failureReason: MorningBriefGenerationFailureReason,
    ): Promise<MorningBriefGenerationExecution> => {
      return await recordUninvokedAttempt(args, fence, failureReason);
    };

    // The preflight below is a real membership and authorization resolution
    // that can block, so it spends the same reservation the request does. It
    // gets a finite slice of what remains, and the allowance for the request
    // itself is recomputed from the clock afterwards — a budget measured before
    // a wait describes time this attempt may no longer own.
    const preflightBudgetMs = remainingProviderBudgetMs(
      admission.reservationExpiresAt,
      nowDate(),
    );
    if (preflightBudgetMs <= 0) {
      // Deterministically uninvoked: no request was made, so this is a
      // failure-before-contact and never an unknown outcome.
      return await uninvoked("reservation_expired");
    }

    // The reservation proved this attempt owns the slot; it does not prove the
    // owner still wants a brief or that the source is still theirs to read.
    const admitted = await settleIncludingAbort(
      set(
        generationAuthorityStillCurrent$,
        args.occurrenceRow,
        AbortSignal.any([signal, AbortSignal.timeout(preflightBudgetMs)]),
      ),
    );
    // A caller that cancelled still cancels; a preflight the reservation
    // deadline cut off is a proven pre-contact failure, not an unknown one.
    signal.throwIfAborted();
    if (!admitted.ok) {
      return await uninvoked("reservation_expired");
    }
    if (admitted.value.kind !== "current") {
      return await uninvoked(
        admitted.value.kind === "binding-changed"
          ? "binding_changed"
          : "owner_revoked",
      );
    }

    // Resampled immediately before contact, so a preflight that consumed the
    // allowance cannot still admit the one request this reservation permits.
    // Equality with the deadline is exhausted.
    const budgetMs = remainingProviderBudgetMs(
      admission.reservationExpiresAt,
      nowDate(),
    );
    if (budgetMs <= 0) {
      return await uninvoked("reservation_expired");
    }

    const {
      receipt,
      recorded,
      interpreted: observedOutcome,
    } = await requestAndRecordCharge(
      {
        db,
        apiKey: args.apiKey,
        attemptId: admission.attemptId,
        body: args.plan.body,
        sources: args.sources,
        coverage: coverageFactsOf(args),
        language: args.plan.language,
      },
      AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]),
    );
    // Cancellation never accepts owner content. The charge above has already
    // finished its own bounded attempts, so propagating here cannot discard an
    // observation this request made — and cannot make one durable that is not.
    signal.throwIfAborted();

    // Resolving the live authority can itself fail and leave this request; the
    // receipt above is settled either way, so an incurred charge no longer
    // depends on that resolution succeeding.
    const stillAdmitted = await set(
      generationAuthorityStillCurrent$,
      args.occurrenceRow,
      signal,
    );
    signal.throwIfAborted();
    const interpreted =
      stillAdmitted.kind === "current"
        ? observedOutcome
        : lapsedAuthorityOutcome(stillAdmitted);

    const persisted = await persistObservation(
      db,
      {
        fence,
        receipt,
        recorded,
        interpreted,
        occurrenceRow: args.occurrenceRow,
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      kind: "generated",
      occurrence: args.occurrence,
      generation: generationOfPersistence({
        admission,
        coverage: args.coverage,
        receipt,
        persisted,
      }),
    };
  },
);

export const executeMorningBriefPreviewGeneration$ = command(
  async (
    { set },
    args: {
      readonly owner: MorningBriefCollectionOwner;
      readonly scheduledFor: Date;
    },
    signal: AbortSignal,
  ): Promise<MorningBriefGenerationExecution> => {
    const db = set(writeDb$);

    // Bounded retention is consumed here rather than by a scheduler: every
    // invocation drops this owner's own expired preview results first.
    await sweepExpiredMorningBriefGenerations(db, args.owner, nowDate());
    signal.throwIfAborted();

    const apiKey = optionalEnv("OPENROUTER_API_KEY");
    if (!apiKey) {
      // Checked before admission so a deployment without the platform
      // credential claims no occurrence and reads no Slack.
      return { kind: "not-executed", reason: "generation-not-configured" };
    }

    let admitted: AdmittedGeneration | undefined;
    let occurrenceRow: MorningBriefCollectionOccurrenceRow | undefined;
    let bundleCoverage: MorningBriefSlackBundle["coverage"] = "empty";
    let sources: ReadonlyMap<string, GenerationSource> = new Map();
    const execution = await set(
      executeMorningBriefSlackCollection$,
      {
        owner: args.owner,
        scheduledFor: args.scheduledFor,
        handoff: {
          onCollected: async (tx, context) => {
            bundleCoverage = context.bundle.coverage;
            occurrenceRow = context.occurrence;
            admitted = await admitGeneration(tx, context);
            if (admitted.kind === "reserved") {
              sources = admitted.plan.sources;
            }
          },
        },
      },
      signal,
    );
    signal.throwIfAborted();

    if (
      execution.kind === "not-executed" ||
      execution.kind === "invalid-anchor" ||
      execution.kind === "conflict"
    ) {
      return execution;
    }
    if (execution.kind === "failed") {
      return {
        kind: "collection-failed",
        occurrence: execution.occurrence,
        ...(execution.retryAfterSeconds !== undefined && {
          retryAfterSeconds: execution.retryAfterSeconds,
        }),
      };
    }

    const key: MorningBriefGenerationKey = {
      owner: args.owner,
      scheduledFor: args.scheduledFor,
      collectionKind: execution.occurrence.collectionKind,
      collectionVersion: execution.occurrence.collectionVersion,
    };

    if (execution.kind === "already-completed") {
      return await set(
        resolveExistingGeneration$,
        { db, key, occurrence: execution.occurrence },
        signal,
      );
    }

    if (!admitted || !occurrenceRow) {
      throw new Error("Morning Brief collection finalized without a handoff");
    }
    if (admitted.kind === "skipped") {
      const row = await readMorningBriefGeneration(db, key, GENERATION_PURPOSE);
      signal.throwIfAborted();
      if (!row) {
        throw new Error("Morning Brief generation skip was not recorded");
      }
      return {
        kind: "generated",
        occurrence: execution.occurrence,
        generation: viewOfRow(row, null),
      };
    }

    return await set(
      invokeAndPersist$,
      {
        db,
        apiKey,
        admission: admitted.admission,
        plan: admitted.plan,
        sources,
        coverage: bundleCoverage,
        occurrence: execution.occurrence,
        occurrenceRow,
      },
      signal,
    );
  },
);
