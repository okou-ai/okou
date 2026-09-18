import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief-delivery";
import { morningBriefGenerations } from "@okouai/db/schema/morning-brief-generation";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { clerk$ } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import {
  admitMorningBriefCollection,
  admitMorningBriefNativeCollection,
  startMorningBriefSourceDeadline,
  type MorningBriefCollectionScope,
} from "./morning-brief-connector-reader.service";
import type { MorningBriefCollectionOwner } from "./morning-brief-collection-occurrence.service";
import { loadMorningBriefNativeRetainedAuthority } from "./morning-brief-native-generation-admission.service";
import {
  morningBriefSourcesToRevalidate,
  type MorningBriefRetainedSourceDescriptor,
} from "./morning-brief-source-authority";
import { revalidateMorningBriefRetainedSources } from "./morning-brief-source-revalidation.service";
import { slackUserInstallation } from "./slack-data.service";

const STORED_SOURCE_REVALIDATION_MS = 5000;

type MorningBriefStoredSourceRefusal =
  | "result-not-found"
  | "proof-unavailable"
  | "owner-revoked"
  | "binding-changed";

interface StoredSourceRequest {
  readonly owner: MorningBriefCollectionOwner;
  readonly resultAttemptId: string;
  readonly purpose: "preview" | "production";
}

async function loadStoredGeneration(db: Db, args: StoredSourceRequest) {
  const [generation] = await db
    .select({
      scheduledFor: morningBriefGenerations.scheduledFor,
      collectionKind: morningBriefGenerations.collectionKind,
      membershipId: morningBriefGenerations.membershipId,
      agentId: morningBriefGenerations.agentId,
      installationId: morningBriefGenerations.installationId,
      automationId: morningBriefGenerations.automationId,
      chatThreadId: morningBriefGenerations.chatThreadId,
      retainedSources: morningBriefGenerations.retainedSources,
      retainedUntil: morningBriefGenerations.retainedUntil,
    })
    .from(morningBriefGenerations)
    .where(
      and(
        eq(morningBriefGenerations.orgId, args.owner.orgId),
        eq(morningBriefGenerations.userId, args.owner.userId),
        eq(morningBriefGenerations.attemptId, args.resultAttemptId),
        eq(morningBriefGenerations.executionPurpose, args.purpose),
      ),
    )
    .limit(1);
  return generation;
}

type StoredGeneration = NonNullable<
  Awaited<ReturnType<typeof loadStoredGeneration>>
>;

type StoredProof =
  | { readonly kind: "legacy-slack" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "ready";
      readonly descriptors: readonly MorningBriefRetainedSourceDescriptor[];
    };

/** Interpret the additive proof columns without inventing proof for old rows. */
function storedProofOf(generation: StoredGeneration): StoredProof {
  if (
    generation.retainedSources === null ||
    generation.retainedUntil === null ||
    generation.installationId === null ||
    generation.automationId === null
  ) {
    // Historical Slack-only rows predate retained-source proof and complete
    // binding provenance. Their live Slack authority remains the caller's gate;
    // all-source rows are never allowed through this compatibility path.
    return generation.collectionKind === "sources"
      ? { kind: "unavailable" }
      : { kind: "legacy-slack" };
  }
  if (generation.retainedUntil.getTime() <= nowDate().getTime()) {
    return { kind: "unavailable" };
  }
  return {
    kind: "ready",
    descriptors: morningBriefSourcesToRevalidate(
      generation.retainedSources as readonly MorningBriefRetainedSourceDescriptor[],
    ),
  };
}

/** Does a null destination reflect the one S6 transaction that created it? */
async function deliveryEstablishedCurrentThread(
  db: Db,
  args: StoredSourceRequest,
  generation: StoredGeneration,
  current: MorningBriefCollectionScope,
  signal: AbortSignal,
): Promise<boolean> {
  if (generation.chatThreadId !== null) {
    return false;
  }
  const [delivery] = await db
    .select({
      membershipId: morningBriefDeliveries.membershipId,
      workflowId: morningBriefDeliveries.workflowId,
      automationId: morningBriefDeliveries.automationId,
      agentId: morningBriefDeliveries.agentId,
      chatThreadId: morningBriefDeliveries.chatThreadId,
    })
    .from(morningBriefDeliveries)
    .where(
      and(
        eq(morningBriefDeliveries.orgId, args.owner.orgId),
        eq(morningBriefDeliveries.userId, args.owner.userId),
        eq(morningBriefDeliveries.resultAttemptId, args.resultAttemptId),
        eq(morningBriefDeliveries.executionPurpose, args.purpose),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!delivery) {
    return false;
  }
  return (
    delivery.membershipId === generation.membershipId &&
    delivery.workflowId === generation.installationId &&
    delivery.automationId === generation.automationId &&
    delivery.agentId === generation.agentId &&
    delivery.chatThreadId === current.chatThreadId
  );
}

/** Compare the generation-time binding, including S6's receipt-first thread. */
async function storedBindingIsCurrent(
  db: Db,
  args: StoredSourceRequest,
  generation: StoredGeneration,
  current: MorningBriefCollectionScope,
  signal: AbortSignal,
): Promise<boolean> {
  if (
    current.membershipId !== generation.membershipId ||
    current.agentId !== generation.agentId ||
    current.installationId !== generation.installationId ||
    current.automationId !== generation.automationId
  ) {
    return false;
  }
  if (current.chatThreadId === generation.chatThreadId) {
    return true;
  }
  // The first S6 commit is the one legitimate null → thread transition:
  // generation is admitted before a destination exists, then the same delivery
  // transaction creates and records it. Any other destination change loses.
  return await deliveryEstablishedCurrentThread(
    db,
    args,
    generation,
    current,
    signal,
  );
}

/**
 * Revalidate the exact retained inputs of one persisted generation.
 *
 * This is the common post-reservation/readback/Chat/email boundary. It reads no
 * source body and creates no replacement proof: the persisted descriptors name
 * the same connector endpoints or first-party containers the shared
 * revalidator checks everywhere else.
 */
export const revalidateMorningBriefStoredGenerationSources$ = command(
  async (
    { get, set },
    args: StoredSourceRequest,
    signal: AbortSignal,
  ): Promise<MorningBriefStoredSourceRefusal | null> => {
    const db = set(writeDb$);
    const generation = await loadStoredGeneration(db, args);
    signal.throwIfAborted();
    if (!generation) {
      return "result-not-found";
    }

    const proof = storedProofOf(generation);
    if (proof.kind === "legacy-slack") {
      return null;
    }
    if (proof.kind === "unavailable") {
      return "proof-unavailable";
    }
    if (proof.descriptors.length === 0) {
      return null;
    }

    const deadline = startMorningBriefSourceDeadline(
      STORED_SOURCE_REVALIDATION_MS,
    );
    const admissionArgs = {
      db,
      clerk: get(clerk$),
      orgId: args.owner.orgId,
      userId: args.owner.userId,
      anchor: generation.scheduledFor,
      deadline,
    };
    const nativeAuthority =
      args.purpose === "production"
        ? await loadMorningBriefNativeRetainedAuthority(db, {
            ...args.owner,
            scheduledFor: generation.scheduledFor,
            generationAttemptId: args.resultAttemptId,
          })
        : undefined;
    signal.throwIfAborted();
    const admitted =
      args.purpose === "production"
        ? nativeAuthority === undefined
          ? { kind: "denied" as const, reason: "not-installed" }
          : await admitMorningBriefNativeCollection(
              { ...admissionArgs, authority: nativeAuthority },
              signal,
            )
        : await admitMorningBriefCollection(admissionArgs, signal);
    signal.throwIfAborted();
    if (admitted.kind !== "ok") {
      return "owner-revoked";
    }
    if (
      !(await storedBindingIsCurrent(
        db,
        args,
        generation,
        admitted.scope,
        signal,
      ))
    ) {
      return "binding-changed";
    }

    const installation = await get(
      slackUserInstallation({
        orgId: args.owner.orgId,
        userId: args.owner.userId,
      }),
    );
    signal.throwIfAborted();
    const checked = await revalidateMorningBriefRetainedSources(
      {
        db,
        clerk: get(clerk$),
        scope: admitted.scope,
        descriptors: proof.descriptors,
        slack:
          installation.kind === "connected"
            ? {
                botToken: installation.botToken,
                workspaceId: installation.workspaceId,
                slackUserId: installation.slackUserId,
              }
            : null,
        deadline,
      },
      signal,
    );
    if (checked.kind === "owner-lost") {
      return "owner-revoked";
    }
    return checked.revoked.length > 0 ? "binding-changed" : null;
  },
);
