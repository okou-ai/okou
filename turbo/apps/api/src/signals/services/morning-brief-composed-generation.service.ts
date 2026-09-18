import { createHash, randomUUID } from "node:crypto";

import type { MorningBriefCollectionOccurrenceView } from "@okouai/api-contracts/contracts/morning-brief-collection-preview";
import {
  MORNING_BRIEF_COLLECTION_KIND_SOURCES,
  MORNING_BRIEF_COLLECTION_VERSION,
} from "@okouai/db/schema/morning-brief-collection-occurrence";
import { command } from "ccstate";

import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { clerk$, type ClerkClient } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import {
  admitMorningBriefCollection,
  admitMorningBriefNativeCollection,
  startMorningBriefSourceDeadline,
  type MorningBriefCollectionScope,
} from "./morning-brief-connector-reader.service";
import { admitCollectionCompletion } from "./morning-brief-collection-executor.service";
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
  MORNING_BRIEF_DEFAULT_LANGUAGE,
  type MorningBriefLanguagePlan,
} from "./morning-brief-language-policy";
import type { MorningBriefNativeActiveAuthority } from "./morning-brief-native-generation-admission.service";
import {
  invokeAndPersist$,
  viewOfRow,
  type MorningBriefGenerationExecution,
} from "./morning-brief-generation-executor.service";
import {
  readInvokedAnchorGeneration,
  readMorningBriefGeneration,
  recordMorningBriefGenerationSkip,
  reserveMorningBriefGeneration,
  sweepExpiredMorningBriefGenerations,
  type MorningBriefGenerationAdmission,
} from "./morning-brief-generation-store.service";
import { MORNING_BRIEF_GENERATION_MODEL } from "./morning-brief-generation-prompt";
import { revalidateMorningBriefStoredGenerationSources$ } from "./morning-brief-generation-source-revalidation.service";
import { loadMorningBriefMigrationState } from "./morning-brief-migration-state.service";
import { bindNativeGenerationAttempt } from "./morning-brief-native-schedule.service";
import {
  morningBriefDescriptorRetainUntil,
  morningBriefSourcesToRevalidate,
  type MorningBriefRetainedSourceDescriptor,
} from "./morning-brief-source-authority";
import { revalidateMorningBriefRetainedSources } from "./morning-brief-source-revalidation.service";
import { slackUserInstallation } from "./slack-data.service";

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
 * The input digest a slot records when no request was ever assembled.
 *
 * A skipped morning has no request to describe, and `input_digest` is not
 * nullable. This is the digest of the empty input — a defined, reproducible
 * value that says "nothing was sent" — rather than an empty string, which would
 * read as a digest nobody computed.
 */
const NO_REQUEST_DIGEST = createHash("sha256").update("").digest("hex");

/**
 * The bounded budget an admission may spend before it has to answer.
 *
 * Admission reads canonical state and this member's live Clerk membership, so
 * it can block. Both the entry admission and the pre-POST revalidation get
 * their own finite slice rather than running outside every budget.
 */
const COMPOSED_ADMISSION_BUDGET_MS = 5000;

type MorningBriefComposedConflict =
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

/** The native occurrence claim bound to the reserved attempt before POST. */
type MorningBriefNativeGenerationAuthority = MorningBriefNativeActiveAuthority;

class NativeGenerationAuthorityLost extends Error {
  constructor() {
    super("Morning Brief native authority moved before generation reservation");
    this.name = "NativeGenerationAuthorityLost";
  }
}

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
  const state =
    scope.nativeAuthority === undefined
      ? await loadMorningBriefMigrationState(db, owner)
      : null;
  if (
    scope.nativeAuthority === undefined &&
    (state === null || state.kind !== "installed" || !state.automation.enabled)
  ) {
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
    workflowId: scope.installationId,
    automationId: scope.automationId,
    agentId: scope.agentId,
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
    readonly slack: {
      readonly botToken: string;
      readonly workspaceId: string;
      readonly slackUserId: string;
    } | null;
  },
  signal: AbortSignal,
): Promise<"owner_revoked" | "binding_changed" | null> {
  const supplied = morningBriefSourcesToRevalidate(args.descriptors);
  if (supplied.length === 0) {
    return null;
  }
  const checked = await revalidateMorningBriefRetainedSources(
    {
      db: args.db,
      clerk: args.clerk,
      scope: args.scope,
      descriptors: supplied,
      slack: args.slack,
      deadline: startMorningBriefSourceDeadline(COMPOSED_ADMISSION_BUDGET_MS),
    },
    signal,
  );
  if (checked.kind === "owner-lost") {
    return "owner_revoked";
  }
  return checked.revoked.length > 0 ? "binding_changed" : null;
}

function generationAdmissionOf(args: {
  readonly admission: MorningBriefCollectionAdmission;
  readonly scope: MorningBriefCollectionScope;
  readonly transport: MorningBriefCompositionTransport;
  readonly language: MorningBriefLanguagePlan;
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
    installationId: args.scope.installationId,
    automationId: args.scope.automationId,
    chatThreadId: args.scope.chatThreadId,
    model: MORNING_BRIEF_GENERATION_MODEL,
    language: args.language.fallbackLanguage,
    languageSource: args.language.authority,
    instructionsVersionId: args.language.instructions.versionId,
    instructionsDigest:
      args.language.instructions.state === "available"
        ? args.language.instructions.digest
        : null,
    // Frozen with the reservation, because it describes the request that is
    // about to be sent. No source body, prompt or credential is in it.
    retainedSources: [...args.descriptors],
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
function requiredComposedLanguage(
  composed: Extract<MorningBriefCompositionOutcome, { kind: "composed" }>,
): MorningBriefLanguagePlan {
  const language = composed.result.language;
  if (language === null) {
    throw new Error("Morning Brief composed a request without a language");
  }
  return language;
}

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
      /** Required for production and bound in the reservation transaction. */
      readonly nativeAuthority?: MorningBriefNativeGenerationAuthority;
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
    if (args.purpose === "production" && args.nativeAuthority === undefined) {
      return { kind: "not-executed", reason: "native-authority-lost" };
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

    const admissionArgs = {
      db,
      clerk,
      orgId: args.owner.orgId,
      userId: args.owner.userId,
      anchor: args.scheduledFor,
      deadline: startMorningBriefSourceDeadline(COMPOSED_ADMISSION_BUDGET_MS),
    };
    const admitted =
      args.nativeAuthority === undefined
        ? await admitMorningBriefCollection(admissionArgs, signal)
        : await admitMorningBriefNativeCollection(
            { ...admissionArgs, authority: args.nativeAuthority },
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
      return await resolveExisting(
        db,
        admission,
        claimed.occurrence,
        args,
        async (attemptId) => {
          return await set(
            revalidateMorningBriefStoredGenerationSources$,
            {
              owner: args.owner,
              resultAttemptId: attemptId,
              purpose: args.purpose,
            },
            signal,
          );
        },
      );
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
        nativeAuthority: args.nativeAuthority,
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
      {
        db,
        apiKey,
        admission,
        claim,
        scope,
        composed,
        purpose: args.purpose,
        nativeAuthority: args.nativeAuthority,
      },
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
  revalidate: (attemptId: string) => Promise<string | null>,
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
  if (row.state === "succeeded" && (await revalidate(row.attemptId)) !== null) {
    return { kind: "authority-changed" };
  }
  return {
    kind: "already-generated",
    occurrence: occurrenceView(occurrence),
    generation: viewOfRow(row, null),
  };
}

/**
 * Finalize the collection and take the one generation slot, in one transaction.
 *
 * The collected facts and the right to call the provider become durable
 * together or not at all, and the anchor-wide check runs here rather than
 * before it: a caller-side look before the transaction could not exclude a
 * competitor that commits in between.
 */
async function admitComposedGeneration(
  args: {
    readonly db: Db;
    readonly admission: MorningBriefCollectionAdmission;
    readonly scope: MorningBriefCollectionScope;
    readonly claim: MorningBriefCollectionClaim;
    readonly completion: MorningBriefCollectionCompletion;
    readonly composed: Extract<
      MorningBriefCompositionOutcome,
      { kind: "composed" | "empty" }
    >;
    readonly transport: MorningBriefCompositionTransport | null;
    readonly coverage: "complete" | "partial" | "empty";
    readonly purpose: MorningBriefGenerationAdmission["executionPurpose"];
    readonly nativeAuthority?: MorningBriefNativeGenerationAuthority;
  },
  signal: AbortSignal,
): Promise<{
  readonly finalized: Awaited<
    ReturnType<typeof finalizeMorningBriefCollection>
  >;
  readonly generationAdmission: MorningBriefGenerationAdmission | undefined;
  readonly anchorConflict: boolean;
}> {
  const { admission, transport, coverage } = args;
  if ((args.composed.kind === "composed") !== (transport !== null)) {
    throw new Error("Morning Brief composition and transport disagree");
  }
  const admittedTransport =
    transport === null
      ? {
          body: "",
          bodyBytes: 0,
          inputDigest: NO_REQUEST_DIGEST,
          citations: new Map(),
          inputItems: 0,
          includedItems: 0,
          sourceCoverage: coverage,
        }
      : transport;
  const language: MorningBriefLanguagePlan =
    args.composed.kind === "composed"
      ? requiredComposedLanguage(args.composed)
      : {
          authority: "default" as const,
          fallbackLanguage: MORNING_BRIEF_DEFAULT_LANGUAGE,
          instructions: { state: "no-storage" as const, versionId: null },
        };
  let generationAdmission: MorningBriefGenerationAdmission | undefined;
  let anchorConflict = false;

  const finalized = await args.db.transaction(async (tx) => {
    const result = await finalizeMorningBriefCollection(
      tx,
      admission,
      args.claim,
      args.completion,
      {
        clock: nowDate,
        // The same last check the Slack-only finalization takes, and it is
        // kind-aware: a composed occurrence is proved against the authority it
        // was admitted under rather than against a Slack binding it never read.
        admit: async (finalizingTx, occurrence) => {
          return await admitCollectionCompletion(
            finalizingTx,
            occurrence,
            signal,
          );
        },
      },
    );
    if (result.kind !== "finalized") {
      return result;
    }
    const pending = generationAdmissionOf({
      admission,
      scope: args.scope,
      transport: admittedTransport,
      // A healthy empty composition resolves no language, because asking which
      // language to write a brief in that will not be written is work nobody
      // authorized. The row still needs one, so it records the declared default
      // rather than an authority nothing resolved. A composed request, by
      // contrast, must carry the exact language plan that built its body.
      language,
      descriptors: args.composed.result.descriptors,
      at: result.at,
      occurrenceCreatedAt: result.occurrence.createdAt,
      purpose: args.purpose,
    });

    // One anchor, one possible invocation — including one admitted under the
    // Slack-only kind. A row that may already have reached the provider owns
    // this morning, and widening the source set is never a reason to send
    // again for it.
    const occupying = await readInvokedAnchorGeneration(tx, {
      owner: admission.owner,
      scheduledFor: admission.scheduledFor,
      executionPurpose: args.purpose,
    });
    if (occupying) {
      anchorConflict = true;
      return result;
    }

    const took =
      transport === null
        ? await recordMorningBriefGenerationSkip(
            tx,
            pending,
            coverage === "partial" ? "skipped_incomplete" : "skipped_empty",
          )
        : await reserveMorningBriefGeneration(tx, pending);
    if (!took) {
      anchorConflict = true;
      return result;
    }
    if (transport !== null && args.nativeAuthority !== undefined) {
      if (args.nativeAuthority.membershipId !== pending.membershipId) {
        throw new NativeGenerationAuthorityLost();
      }
      const bound = await bindNativeGenerationAttempt(tx, admission.owner, {
        scheduledFor: admission.scheduledFor,
        generationAttemptId: pending.attemptId,
        expectedEpoch: args.nativeAuthority.ownerEpoch,
        expectedMembershipId: args.nativeAuthority.membershipId,
        leaseToken: args.nativeAuthority.leaseToken,
        at: result.at,
      });
      if (!bound) {
        throw new NativeGenerationAuthorityLost();
      }
    }
    generationAdmission = pending;
    return result;
  });
  return { finalized, generationAdmission, anchorConflict };
}

/** Send the one transport body after its source-independent reservation. */
const invokeComposedTransport$ = command(
  async (
    { get, set },
    input: {
      readonly db: Db;
      readonly apiKey: string;
      readonly scope: MorningBriefCollectionScope;
      readonly composed: Extract<
        MorningBriefCompositionOutcome,
        { kind: "composed" }
      >;
      readonly transport: MorningBriefCompositionTransport;
      readonly coverage: MorningBriefGenerationAdmission["sourceCoverage"];
      readonly generationAdmission: MorningBriefGenerationAdmission;
      readonly occurrence: MorningBriefCollectionOccurrenceView;
      readonly occurrenceRow: MorningBriefCollectionOccurrenceRow;
    },
    signal: AbortSignal,
  ): Promise<MorningBriefComposedExecution> => {
    const clerk = get(clerk$);
    const requestedLanguage = requiredComposedLanguage(
      input.composed,
    ).fallbackLanguage;
    const installation = await get(
      slackUserInstallation({
        orgId: input.scope.orgId,
        userId: input.scope.userId,
      }),
    );
    signal.throwIfAborted();
    const slack =
      installation.kind === "connected"
        ? {
            botToken: installation.botToken,
            workspaceId: installation.workspaceId,
            slackUserId: installation.slackUserId,
          }
        : null;
    const revalidate = async (revalidationSignal: AbortSignal) => {
      return await retainedSourcesStillAuthorized(
        {
          db: input.db,
          clerk,
          scope: input.scope,
          descriptors: input.composed.result.descriptors,
          slack,
        },
        revalidationSignal,
      );
    };
    return await set(
      invokeAndPersist$,
      {
        db: input.db,
        apiKey: input.apiKey,
        admission: input.generationAdmission,
        body: input.transport.body,
        coverage: input.coverage,
        occurrence: input.occurrence,
        occurrenceRow: input.occurrenceRow,
        interpret: (content) => {
          return interpretComposedGenerationOutput({
            content,
            citations: input.transport.citations,
            coverage: {
              collected: input.coverage,
              omittedForSize:
                input.transport.inputItems - input.transport.includedItems,
            },
            language: requestedLanguage,
          });
        },
        preflight: revalidate,
        postflight: revalidate,
      },
      signal,
    );
  },
);

/**
 * Finalize the collection, take the single reservation, then send once.
 *
 * The finalize-and-reserve transaction is short and local. The provider request
 * follows its COMMIT, so the durable record of the invocation always exists
 * before the invocation can happen.
 */
const reserveAndInvoke$ = command(
  async (
    { set },
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
      readonly nativeAuthority?: MorningBriefNativeGenerationAuthority;
    },
    signal: AbortSignal,
  ): Promise<MorningBriefComposedExecution> => {
    const { db, admission, claim, composed } = input;
    const transport = composed.kind === "composed" ? composed.transport : null;
    const coverage = transport === null ? "empty" : transport.sourceCoverage;
    const completion = completionOf(
      composed.kind === "composed" ? "composed" : "empty",
      coverage,
    );

    const admissionAttempt = await settle(
      admitComposedGeneration(
        {
          db,
          admission,
          scope: input.scope,
          claim,
          completion,
          composed,
          transport,
          coverage,
          purpose: input.purpose,
          nativeAuthority: input.nativeAuthority,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!admissionAttempt.ok) {
      if (admissionAttempt.error instanceof NativeGenerationAuthorityLost) {
        return { kind: "not-executed", reason: "native-authority-lost" };
      }
      throw admissionAttempt.error;
    }
    const { finalized, generationAdmission, anchorConflict } =
      admissionAttempt.value;

    if (finalized.kind !== "finalized") {
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
      return {
        kind: "generated",
        occurrence,
        generation: viewOfRow(row, null),
      };
    }
    if (composed.kind !== "composed") {
      throw new Error(
        "Morning Brief transport exists for an empty composition",
      );
    }

    return await set(
      invokeComposedTransport$,
      {
        db,
        apiKey: input.apiKey,
        scope: input.scope,
        composed,
        transport,
        coverage,
        generationAdmission,
        occurrence,
        occurrenceRow: finalized.occurrence,
      },
      signal,
    );
  },
);
