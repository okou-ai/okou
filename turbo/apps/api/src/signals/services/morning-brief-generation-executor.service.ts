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
  morningBriefGenerations,
} from "@okouai/db/schema/morning-brief-generation";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { bindNativeGenerationAttempt } from "./morning-brief-native-schedule.service";
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
import { settle, settleIncludingAbort } from "../utils";
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
import { interpretGenerationOutput } from "./morning-brief-generation-result";
import { revalidateMorningBriefStoredGenerationSources$ } from "./morning-brief-generation-source-revalidation.service";
import {
  acceptMorningBriefGenerationResult,
  holdMorningBriefGenerationSlot,
  lockMorningBriefGeneration,
  readMorningBriefGeneration,
  readMorningBriefGenerationRecovery,
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
/**
 * The purposes this engine can execute for.
 *
 * `preview` is the operator endpoint's. `production` is the native scheduler's,
 * reached only through a validated native occurrence authority. They share the
 * reservation, single-POST, cost and validation engine and can never read each
 * other's results, because every read filters on the purpose it asked for.
 */
type MorningBriefExecutionPurpose =
  (typeof morningBriefGenerations.$inferSelect)["executionPurpose"];

export type MorningBriefGenerationConflict =
  | MorningBriefCollectionConflict
  | "generation-in-progress";

export type MorningBriefGenerationExecution =
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

/**
 * Content-free resolution of the exact durable S5 attempt a native slot bound.
 *
 * This is deliberately S5 vocabulary. The native scheduler may map it onto its
 * own settlement outcomes, but it does not inspect S5 rows or reinterpret model
 * output itself. A deliverable result still has to pass S6's authority fence.
 */
interface MorningBriefGenerationRecovery {
  readonly kind:
    | "pending"
    | "deliverable"
    | "empty-skip"
    | "collection-failed"
    | "model-skip"
    | "generation-failed"
    | "generation-unknown";
  readonly attemptId: string;
}

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
  readonly purpose: MorningBriefExecutionPurpose;
}): MorningBriefGenerationAdmission {
  const { context, plan } = args;
  const language = resolveGenerationLanguage(args.locale);
  return {
    key: generationKeyOf(context),
    executionPurpose: args.purpose,
    // The Slack compatibility writer has no instruction or retained-source
    // provenance. Explicit nulls prevent it from claiming all-source proof.
    instructionsVersionId: null,
    instructionsDigest: null,
    retainedSources: null,
    retainedUntil: null,
    attemptId: randomUUID(),
    membershipId: context.admission.membershipId,
    agentId: context.admission.agentId,
    // The Slack-only compatibility writer predates retained all-source proof.
    installationId: null,
    automationId: null,
    chatThreadId: null,
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
/**
 * The native execution authority a production generation is admitted under.
 *
 * It is supplied by the scheduler that claimed the occurrence and is bound to
 * the reserved attempt inside this same transaction, before the sole platform
 * request. Binding it afterwards would leave a window in which a possibly
 * invoked attempt has no durable association with the slot that paid for it.
 */
/**
 * The claim that admitted this generation is no longer the member's.
 *
 * Thrown inside the reservation transaction so the reservation, the collection
 * finalization and the native binding all roll back together, and no platform
 * request is ever made under a claim that moved.
 */
class NativeGenerationAuthorityLost extends Error {
  constructor() {
    super(
      "Morning Brief native generation authority was lost before the request",
    );
    this.name = "NativeGenerationAuthorityLost";
  }
}

interface MorningBriefNativeGenerationAuthority {
  readonly ownerEpoch: number;
  readonly membershipId: string;
  readonly leaseToken: string;
}

type MorningBriefGenerationRequest = {
  readonly owner: MorningBriefCollectionOwner;
  readonly scheduledFor: Date;
} & (
  | {
      readonly purpose: "preview";
      readonly nativeAuthority?: never;
    }
  | {
      readonly purpose: "production";
      readonly nativeAuthority: MorningBriefNativeGenerationAuthority;
    }
);
async function admitGeneration(
  tx: Tx,
  purpose: MorningBriefExecutionPurpose,
  context: MorningBriefCollectionHandoffContext,
  nativeAuthority: MorningBriefNativeGenerationAuthority | undefined,
): Promise<AdmittedGeneration> {
  const { bundle } = context;
  const locale = await loadMemberLocale(tx, context.admission.owner);
  const plan = planGenerationRequest({
    bundle,
    language: resolveGenerationLanguage(locale).language,
  });
  const admission = admissionOf({ context, plan, locale, bundle, purpose });

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
  if (nativeAuthority !== undefined) {
    // The reserved attempt and the native slot become durable together, in the
    // reservation's own transaction and before the sole platform request. A
    // claimant whose epoch or lease moved while collection ran fails here, the
    // reservation rolls back with it, and no request is made at all.
    const bound = await bindNativeGenerationAttempt(
      tx,
      context.admission.owner,
      {
        scheduledFor: context.admission.scheduledFor,
        generationAttemptId: admission.attemptId,
        expectedEpoch: nativeAuthority.ownerEpoch,
        expectedMembershipId: nativeAuthority.membershipId,
        leaseToken: nativeAuthority.leaseToken,
        at: context.at,
      },
    );
    if (!bound) {
      throw new NativeGenerationAuthorityLost();
    }
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
      /** What the answer said it was written in; never what was asked for. */
      readonly reportedLanguage: string | null;
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
/**
 * How one input shape turns raw model content into an outcome.
 *
 * The transport, reservation, receipt, cost and persistence engine below is
 * shared by every caller; only the contract the answer must satisfy differs.
 * Passing that contract in keeps it that way, instead of growing a second
 * engine beside this one.
 */
type MorningBriefContentInterpreter = (content: string) =>
  | {
      readonly kind: "accepted";
      readonly result:
        | {
            readonly decision: "deliver";
            readonly title: string;
            readonly markdown: string;
            readonly bytes: number;
            readonly reportedLanguage?: string | null;
          }
        | {
            readonly decision: "skip";
            readonly reason: string;
            readonly reportedLanguage?: string | null;
          };
    }
  | {
      readonly kind: "rejected";
      readonly reason: MorningBriefGenerationFailureReason;
    };

function interpretResponse(
  observation: PlatformGenerationObservation,
  interpret: MorningBriefContentInterpreter,
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
  const interpreted = interpret(observation.content);
  if (interpreted.kind === "rejected") {
    return {
      kind: "reject",
      state: "output_rejected",
      failureReason: interpreted.reason,
    };
  }
  const reportedLanguage = interpreted.result.reportedLanguage ?? null;
  return interpreted.result.decision === "skip"
    ? {
        kind: "accept",
        decision: "skip",
        skipReason: interpreted.result.reason,
        reportedLanguage,
        title: null,
        markdown: null,
        bytes: null,
      }
    : {
        kind: "accept",
        decision: "deliver",
        skipReason: null,
        reportedLanguage,
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
export function viewOfRow(
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
    row.contentPurgedAt === null &&
    (row.resultTitle === null ||
      row.resultMarkdown === null ||
      row.resultBytes === null)
  ) {
    throw new Error("Morning Brief generation stores an incomplete result");
  }
  return {
    purpose: row.executionPurpose,
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
    purpose: admission.executionPurpose,
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
        reportedLanguage: interpreted.reportedLanguage,
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
        // The occurrence decides which authority still has to hold, so a
        // source-independent slot is never judged against a Slack binding it
        // was not admitted under.
        collectionKind: occurrence.collectionKind,
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
    readonly purpose: MorningBriefExecutionPurpose;
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
    row.executionPurpose !== args.purpose
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
      readonly purpose: MorningBriefExecutionPurpose;
      readonly db: Db;
      readonly key: MorningBriefGenerationKey;
      readonly occurrence: MorningBriefCollectionOccurrenceView;
    },
    signal: AbortSignal,
  ): Promise<MorningBriefGenerationExecution> => {
    const { db, key, occurrence } = args;
    const row = await readMorningBriefGeneration(db, key, args.purpose);
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
        return await resolveStaleMorningBriefGeneration(tx, key, row.attemptId);
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

    // Re-check every source that entered the persisted request, including
    // supplied-but-uncited material. This is the last external wait before the
    // owner/result transaction below makes the final no-await release decision.
    const sourceRefusal = await set(
      revalidateMorningBriefStoredGenerationSources$,
      {
        owner: key.owner,
        resultAttemptId: row.attemptId,
        purpose: args.purpose,
      },
      signal,
    );
    signal.throwIfAborted();
    if (sourceRefusal === "owner-revoked") {
      return { kind: "conflict", reason: "owner-revoked" };
    }
    if (sourceRefusal === "binding-changed") {
      return { kind: "conflict", reason: "binding-changed" };
    }
    if (sourceRefusal !== null) {
      return { kind: "collection-completed-without-generation", occurrence };
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
        purpose: args.purpose,
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

function recoveryOfGeneration(
  row: NonNullable<
    Awaited<ReturnType<typeof readMorningBriefGenerationRecovery>>
  >,
  at: Date,
): MorningBriefGenerationRecovery {
  const recovered = (
    kind: MorningBriefGenerationRecovery["kind"],
  ): MorningBriefGenerationRecovery => {
    return { kind, attemptId: row.attemptId };
  };
  switch (row.state) {
    case "reserved": {
      return recovered("pending");
    }
    case "skipped_empty": {
      return recovered("empty-skip");
    }
    case "skipped_incomplete": {
      return recovered("collection-failed");
    }
    case "succeeded": {
      if (row.decision === "skip") {
        return recovered("model-skip");
      }
      // S6 must not be asked to release owner content after its retention
      // boundary. Current maintenance clears body bytes first and retains the
      // content-free invocation fence through the replay window, so either the
      // explicit purge marker or an elapsed deadline makes delivery unknown.
      return recovered(
        row.decision === "deliver" &&
          row.contentPurgedAt === null &&
          row.expiresAt.getTime() > at.getTime()
          ? "deliverable"
          : "generation-unknown",
      );
    }
    case "invocation_outcome_unknown": {
      return recovered("generation-unknown");
    }
    case "output_rejected":
    case "provider_failed":
    case "not_invoked":
    case "result_discarded": {
      return recovered("generation-failed");
    }
  }
}

/**
 * Resolve the exact S5 attempt a native occurrence already bound.
 *
 * No source is recollected, no provider request is possible and no saved body
 * is selected. A live reservation remains pending. A lapsed reservation is
 * settled through S5's existing stale-reservation transition, then read again
 * so a concurrent terminal writer wins honestly. Physical retention deletion
 * is the only way a terminal row disappears; because the caller supplied the
 * durable attempt id, that absence is an unknown generation, never an empty
 * collection and never permission to generate again.
 */
export const recoverMorningBriefGeneration$ = command(
  async (
    { set },
    args: {
      readonly owner: MorningBriefCollectionOwner;
      readonly attemptId: string;
      readonly purpose: MorningBriefExecutionPurpose;
    },
    signal: AbortSignal,
  ): Promise<MorningBriefGenerationRecovery> => {
    const db = set(writeDb$);
    let row = await readMorningBriefGenerationRecovery(db, args);
    signal.throwIfAborted();
    if (row === undefined) {
      return { kind: "generation-unknown", attemptId: args.attemptId };
    }

    if (
      row.state === "reserved" &&
      row.reservationExpiresAt.getTime() <= nowDate().getTime()
    ) {
      const key: MorningBriefGenerationKey = {
        owner: row.owner,
        scheduledFor: row.scheduledFor,
        collectionKind: row.collectionKind,
        collectionVersion: row.collectionVersion,
      };
      await db.transaction(async (tx) => {
        await resolveStaleMorningBriefGeneration(tx, key, args.attemptId);
      });
      signal.throwIfAborted();
      // The stale transition may have lost to the original terminal writer.
      // Re-read by exact attempt so either committed outcome is classified, and
      // a concurrent retention deletion is reported as unknown.
      row = await readMorningBriefGenerationRecovery(db, args);
      signal.throwIfAborted();
      if (row === undefined) {
        return { kind: "generation-unknown", attemptId: args.attemptId };
      }
    }

    return recoveryOfGeneration(row, nowDate());
  },
);

interface InvocationArgs {
  readonly db: Db;
  readonly apiKey: string;
  readonly admission: MorningBriefGenerationAdmission;
  /** The exact transport bytes this reservation admitted. Sent at most once. */
  readonly body: string;
  /** The contract the answer must satisfy, supplied by the input shape. */
  readonly interpret: MorningBriefContentInterpreter;
  readonly coverage: MorningBriefGenerationAdmission["sourceCoverage"];
  readonly occurrence: MorningBriefCollectionOccurrenceView;
  /** The durable record of the authority this invocation acts under. */
  readonly occurrenceRow: MorningBriefCollectionOccurrenceRow;
  /**
   * A last deterministic check, run after the reservation COMMIT and before
   * any provider contact.
   *
   * It is where a caller consumes the shared retained-source revalidator: the
   * sources were read before the reservation, and a revocation in between must
   * stop the request rather than be discovered after it was sent.
   */
  readonly preflight?: (
    signal: AbortSignal,
  ) => Promise<MorningBriefGenerationFailureReason | null>;
  /** Re-run the same retained-source proof after the response, before content. */
  readonly postflight?: (
    signal: AbortSignal,
  ) => Promise<MorningBriefGenerationFailureReason | null>;
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
    readonly interpret: MorningBriefContentInterpreter;
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
          interpreted: interpretResponse(observed, args.interpret),
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
export const invokeAndPersist$ = command(
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

    // The caller's own last deterministic check, after the reservation COMMIT
    // and still before contact. A source revoked while the reservation was
    // being committed stops the request here, where nothing has been sent, so
    // it is a proven pre-contact failure rather than an unknown outcome. The
    // immutable request is never edited or recollected to get past it.
    if (args.preflight) {
      const refused = await args.preflight(
        AbortSignal.any([signal, AbortSignal.timeout(preflightBudgetMs)]),
      );
      signal.throwIfAborted();
      if (refused !== null) {
        return await uninvoked(refused);
      }
    }

    // Resampled after every wait, so a preflight that consumed the allowance
    // cannot still admit the one request this reservation permits. Equality
    // with the deadline is exhausted.
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
        body: args.body,
        interpret: args.interpret,
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
    let interpreted =
      stillAdmitted.kind === "current"
        ? observedOutcome
        : lapsedAuthorityOutcome(stillAdmitted);

    if (stillAdmitted.kind === "current" && args.postflight) {
      const remainingMs = Math.min(
        5000,
        admission.reservationExpiresAt.getTime() - nowDate().getTime(),
      );
      const refused =
        remainingMs <= 0
          ? "reservation_expired"
          : await args.postflight(
              AbortSignal.any([signal, AbortSignal.timeout(remainingMs)]),
            );
      signal.throwIfAborted();
      if (refused !== null) {
        interpreted = lapsedAuthorityOutcome(
          refused === "binding_changed"
            ? { kind: "binding-changed" }
            : { kind: "not-executed", reason: "membership-revoked" },
        );
      }
    }

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

/**
 * Run the collection that a generation reservation joins, turning a lost native
 * claim into an outcome rather than a thrown tick failure.
 *
 * The reservation refuses inside its own transaction, which is what rolls the
 * collection finalization back with it. Reporting that as a non-executing
 * outcome keeps one member's moved claim from failing the whole cron tick.
 */
async function collectForGeneration<T>(
  run: Promise<T>,
  signal: AbortSignal,
): Promise<T | { readonly kind: "native-authority-lost" }> {
  const settled = await settle(run, signal);
  if (settled.ok) {
    return settled.value;
  }
  if (settled.error instanceof NativeGenerationAuthorityLost) {
    return { kind: "native-authority-lost" };
  }
  throw settled.error;
}

/**
 * The one generation engine, executed for an explicit purpose.
 *
 * `preview` is the operator endpoint's. `production` is the native scheduler's
 * and is reached only after that scheduler validated its own occurrence
 * authority against the durable native row. Both share this
 * reservation-before-single-POST protocol, the same platform cost accounting
 * and the same output validation.
 */
const executeMorningBriefGeneration$ = command(
  async (
    { set },
    args: MorningBriefGenerationRequest,
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
    const execution = await collectForGeneration(
      set(
        executeMorningBriefSlackCollection$,
        {
          owner: args.owner,
          scheduledFor: args.scheduledFor,
          handoff: {
            onCollected: async (tx, context) => {
              bundleCoverage = context.bundle.coverage;
              occurrenceRow = context.occurrence;
              admitted = await admitGeneration(
                tx,
                args.purpose,
                context,
                args.nativeAuthority,
              );
              if (admitted.kind === "reserved") {
                sources = admitted.plan.sources;
              }
            },
          },
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();

    if (execution.kind === "native-authority-lost") {
      return { kind: "not-executed", reason: "native-authority-lost" };
    }
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
        { db, key, occurrence: execution.occurrence, purpose: args.purpose },
        signal,
      );
    }

    if (!admitted || !occurrenceRow) {
      throw new Error("Morning Brief collection finalized without a handoff");
    }
    if (admitted.kind === "skipped") {
      const row = await readMorningBriefGeneration(db, key, args.purpose);
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

    const plan = admitted.plan;
    return await set(
      invokeAndPersist$,
      {
        db,
        apiKey,
        admission: admitted.admission,
        body: plan.body,
        interpret: (content) => {
          return interpretGenerationOutput({
            content,
            sources,
            coverage: {
              collected: bundleCoverage,
              omittedForSize: plan.droppedItems,
            },
            language: plan.language,
          });
        },
        coverage: bundleCoverage,
        occurrence: execution.occurrence,
        occurrenceRow,
      },
      signal,
    );
  },
);

/** The operator preview entry point. */
export const executeMorningBriefPreviewGeneration$ = command(
  async (
    { set },
    args: {
      readonly owner: MorningBriefCollectionOwner;
      readonly scheduledFor: Date;
    },
    signal: AbortSignal,
  ): Promise<MorningBriefGenerationExecution> => {
    return await set(
      executeMorningBriefGeneration$,
      { ...args, purpose: "preview" },
      signal,
    );
  },
);
