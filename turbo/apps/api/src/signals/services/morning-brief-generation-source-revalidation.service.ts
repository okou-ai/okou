import { morningBriefGenerations } from "@okouai/db/schema/morning-brief-generation";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import {
  admitMorningBriefCollection,
  startMorningBriefSourceDeadline,
} from "./morning-brief-connector-reader.service";
import type { MorningBriefCollectionOwner } from "./morning-brief-collection-occurrence.service";
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
    args: {
      readonly owner: MorningBriefCollectionOwner;
      readonly resultAttemptId: string;
      readonly purpose: "preview" | "production";
    },
    signal: AbortSignal,
  ): Promise<MorningBriefStoredSourceRefusal | null> => {
    const db = set(writeDb$);
    const [generation] = await db
      .select({
        scheduledFor: morningBriefGenerations.scheduledFor,
        collectionKind: morningBriefGenerations.collectionKind,
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
    signal.throwIfAborted();
    if (!generation) {
      return "result-not-found";
    }
    if (
      generation.retainedSources === null ||
      generation.retainedUntil === null
    ) {
      // Historical Slack-only rows predate retained-source proof. Their live
      // Slack authority remains the caller's gate; all-source rows are never
      // allowed through this compatibility path.
      return generation.collectionKind === "sources"
        ? "proof-unavailable"
        : null;
    }
    if (generation.retainedUntil.getTime() <= nowDate().getTime()) {
      return "proof-unavailable";
    }

    const descriptors = morningBriefSourcesToRevalidate(
      generation.retainedSources as readonly MorningBriefRetainedSourceDescriptor[],
    );
    if (descriptors.length === 0) {
      return null;
    }

    const deadline = startMorningBriefSourceDeadline(
      STORED_SOURCE_REVALIDATION_MS,
    );
    const admitted = await admitMorningBriefCollection(
      {
        db,
        clerk: get(clerk$),
        orgId: args.owner.orgId,
        userId: args.owner.userId,
        anchor: generation.scheduledFor,
        deadline,
      },
      signal,
    );
    signal.throwIfAborted();
    if (admitted.kind !== "ok") {
      return "owner-revoked";
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
        descriptors,
        slack:
          installation.kind === "connected"
            ? {
                botToken: installation.botToken,
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
