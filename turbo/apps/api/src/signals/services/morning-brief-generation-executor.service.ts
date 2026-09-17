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
} from "@okouai/db/schema/morning-brief-generation";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  requestPlatformGeneration,
  unknownInvocationTokens,
  type PlatformGenerationCost,
  type PlatformGenerationObservation,
  type PlatformGenerationOutcome,
  type PlatformGenerationTokens,
} from "../external/openrouter-platform-generation";
import { settleIncludingAbort } from "../utils";
import {
  executeMorningBriefSlackCollection$,
  type MorningBriefCollectionConflict,
  type MorningBriefCollectionHandoffContext,
} from "./morning-brief-collection-executor.service";
import type { MorningBriefCollectionOwner } from "./morning-brief-collection-occurrence.service";
import {
  GENERATION_PROVIDER_DEADLINE_MS,
  MORNING_BRIEF_GENERATION_MODEL,
  planGenerationRequest,
  resolveGenerationLanguage,
  type GenerationRequestPlan,
  type GenerationSource,
} from "./morning-brief-generation-prompt";
import { interpretGenerationOutput } from "./morning-brief-generation-result";
import {
  acceptMorningBriefGenerationResult,
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

function receiptView(
  values: MorningBriefPlatformReceiptValues,
): MorningBriefPlatformReceiptView {
  return {
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
        "output_rejected" | "provider_failed" | "invocation_outcome_unknown"
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
  if (observation.finishReason === "tool_calls") {
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

function viewOfRow(
  row: MorningBriefGenerationRow,
  receipt: MorningBriefPlatformReceiptView | null,
): MorningBriefGenerationView {
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
    sourceCoverage:
      row.sourceCoverage === "complete" || row.sourceCoverage === "partial"
        ? row.sourceCoverage
        : "empty",
    inputDigest: row.inputDigest,
    reservedAt: row.reservedAt.toISOString(),
    reservationExpiresAt: row.reservationExpiresAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    result:
      row.decision === "deliver" &&
      row.resultTitle !== null &&
      row.resultMarkdown !== null
        ? {
            decision: "deliver",
            title: row.resultTitle,
            markdown: row.resultMarkdown,
            bytes: row.resultBytes ?? row.resultMarkdown.length,
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
  readonly interpreted: InterpretedOutcome;
  readonly at: Date;
}

type OwnerWriteResult =
  | { readonly kind: "written"; readonly row: MorningBriefGenerationRow }
  | { readonly kind: "owner-revoked" };

/**
 * Write the owner-scoped outcome under the fence the reservation was admitted
 * with.
 *
 * Acceptance additionally requires an unexpired reservation, so content that
 * arrived too late is never stored. When it does arrive too late the honest
 * `result_discarded` outcome is recorded instead — refusing both would leave
 * the slot looking merely stale. A revoked owner matches neither write, and
 * nothing here recreates an owner row.
 */
async function commitOwnerOutcome(
  tx: Tx,
  args: PersistenceArgs,
): Promise<OwnerWriteResult> {
  if (args.interpreted.kind === "accept") {
    const accepted = await acceptMorningBriefGenerationResult(
      tx,
      args.fence,
      {
        decision: args.interpreted.decision,
        skipReason: args.interpreted.skipReason,
        title: args.interpreted.title,
        markdown: args.interpreted.markdown,
        bytes: args.interpreted.bytes,
      },
      args.at,
    );
    if (accepted.kind === "written") {
      return { kind: "written", row: accepted.row };
    }
    const discarded = await recordMorningBriefGenerationOutcome(
      tx,
      args.fence,
      { state: "result_discarded", failureReason: "reservation_expired" },
      args.at,
    );
    return discarded.kind === "written"
      ? { kind: "written", row: discarded.row }
      : { kind: "owner-revoked" };
  }
  const written = await recordMorningBriefGenerationOutcome(
    tx,
    args.fence,
    {
      state: args.interpreted.state,
      failureReason: args.interpreted.failureReason,
    },
    args.at,
  );
  return written.kind === "written"
    ? { kind: "written", row: written.row }
    : { kind: "owner-revoked" };
}

type PersistOutcome =
  | { readonly kind: "committed"; readonly write: OwnerWriteResult }
  | { readonly kind: "uncommitted" };

/**
 * Commit the observed receipt and then the owner-scoped outcome.
 *
 * They are separate writes on purpose. The receipt is anonymous platform spend
 * and must survive an owner who was revoked or erased while the request was in
 * flight, so it is written first and keyed by the opaque attempt id — a bounded
 * retry of the same observation therefore writes exactly one cost record. When
 * every attempt fails the slot stays reserved: a later explicit invocation
 * resolves it to `invocation_outcome_unknown`, and nothing sends again.
 */
async function persistObservation(
  db: Db,
  args: PersistenceArgs,
): Promise<PersistOutcome> {
  let attempt = 0;
  while (attempt < GENERATION_PERSISTENCE_ATTEMPTS) {
    attempt += 1;
    const settled = await settleIncludingAbort(
      (async (): Promise<OwnerWriteResult> => {
        await recordPlatformGenerationReceipt(db, args.receipt);
        return await db.transaction(async (tx) => {
          return await commitOwnerOutcome(tx, args);
        });
      })(),
    );
    if (settled.ok) {
      return { kind: "committed", write: settled.value };
    }
  }
  return { kind: "uncommitted" };
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

/**
 * Report what an occurrence that already finished collecting holds.
 *
 * It never recollects and never regenerates. A terminal slot is read back as
 * it is; a reservation whose deadline has passed is settled as unknown,
 * because the original request may already have reached the provider; and an
 * occurrence that finished with no generation at all reports exactly that,
 * since a completed occurrence keeps no source body to rebuild one from.
 */
async function resolveExistingGeneration(
  db: Db,
  key: MorningBriefGenerationKey,
  occurrence: MorningBriefCollectionOccurrenceView,
): Promise<MorningBriefGenerationExecution> {
  const row = await readMorningBriefGeneration(db, key, GENERATION_PURPOSE);
  if (!row) {
    return { kind: "collection-completed-without-generation", occurrence };
  }
  if (row.state !== "reserved") {
    return {
      kind: "already-generated",
      occurrence,
      generation: viewOfRow(row, await loadReceiptView(db, row.attemptId)),
    };
  }
  const at = nowDate();
  // Equality with the deadline is already expired.
  if (row.reservationExpiresAt.getTime() > at.getTime()) {
    return { kind: "conflict", reason: "generation-in-progress" };
  }
  const resolved = await db.transaction(async (tx) => {
    return await resolveStaleMorningBriefGeneration(tx, key, at);
  });
  const settled =
    resolved ?? (await readMorningBriefGeneration(db, key, GENERATION_PURPOSE));
  if (!settled) {
    return { kind: "collection-completed-without-generation", occurrence };
  }
  return {
    kind: "already-generated",
    occurrence,
    generation: viewOfRow(
      settled,
      await loadReceiptView(db, settled.attemptId),
    ),
  };
}

interface InvocationArgs {
  readonly db: Db;
  readonly apiKey: string;
  readonly admission: MorningBriefGenerationAdmission;
  readonly plan: GenerationRequestPlan;
  readonly sources: ReadonlyMap<string, GenerationSource>;
  readonly coverage: MorningBriefSlackBundle["coverage"];
  readonly occurrence: MorningBriefCollectionOccurrenceView;
}

/**
 * Make the single provider request this reservation admitted, then record it.
 *
 * Everything before this point is reversible; this is not. The deadline is
 * checked before any contact — equality with the reservation deadline is
 * already expired — and the request is never retried, because the reservation
 * is already durable and a resent request could be a second inference.
 */
async function invokeAndPersist(
  args: InvocationArgs,
  signal: AbortSignal,
): Promise<MorningBriefGenerationExecution> {
  const { admission, db } = args;
  const fence: MorningBriefGenerationFence = {
    key: admission.key,
    attemptId: admission.attemptId,
    membershipId: admission.membershipId,
  };
  const startedAt = nowDate();
  const budgetMs = Math.min(
    GENERATION_PROVIDER_DEADLINE_MS,
    admission.reservationExpiresAt.getTime() -
      startedAt.getTime() -
      GENERATION_PERSISTENCE_RESERVE_MS,
  );
  if (budgetMs <= 0) {
    // Deterministically uninvoked: no request was made, so this is a
    // failure-before-contact and never an unknown outcome.
    const written = await db.transaction(async (tx) => {
      return await recordMorningBriefGenerationOutcome(
        tx,
        fence,
        { state: "not_invoked", failureReason: "reservation_expired" },
        nowDate(),
      );
    });
    return written.kind === "written"
      ? {
          kind: "generated",
          occurrence: args.occurrence,
          generation: viewOfRow(written.row, null),
        }
      : {
          kind: "generated",
          occurrence: args.occurrence,
          generation: viewOfUncommittedAttempt(
            admission,
            args.coverage,
            null,
            "owner_revoked",
          ),
        };
  }

  const outcome = await requestPlatformGeneration(
    { apiKey: args.apiKey, body: args.plan.body },
    AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]),
  );
  const finishedAt = nowDate();
  const observation = outcome.kind === "response" ? outcome.observation : null;
  const classified =
    outcome.kind === "response"
      ? {
          receiptOutcome: "response_received" as const,
          interpreted: interpretResponse(outcome.observation, args.sources),
        }
      : classifyTransport(outcome);
  const receipt = receiptValuesOf({
    attemptId: admission.attemptId,
    outcome: classified.receiptOutcome,
    observation,
    startedAt,
    finishedAt,
  });

  const persisted = await persistObservation(db, {
    fence,
    receipt,
    interpreted: classified.interpreted,
    at: finishedAt,
  });
  const view = receiptView(receipt);
  if (persisted.kind === "uncommitted") {
    return {
      kind: "generated",
      occurrence: args.occurrence,
      generation: viewOfUncommittedAttempt(
        admission,
        args.coverage,
        null,
        "persistence_failed",
      ),
    };
  }
  if (persisted.write.kind === "owner-revoked") {
    // The incurred cost stays recorded; no owner row is recreated to hold it.
    return {
      kind: "generated",
      occurrence: args.occurrence,
      generation: viewOfUncommittedAttempt(
        admission,
        args.coverage,
        view,
        "owner_revoked",
      ),
    };
  }
  return {
    kind: "generated",
    occurrence: args.occurrence,
    generation: viewOfRow(persisted.write.row, view),
  };
}

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
      return await resolveExistingGeneration(db, key, execution.occurrence);
    }

    if (!admitted) {
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

    return await invokeAndPersist(
      {
        db,
        apiKey,
        admission: admitted.admission,
        plan: admitted.plan,
        sources,
        coverage: bundleCoverage,
        occurrence: execution.occurrence,
      },
      signal,
    );
  },
);
