import { createHash, randomUUID } from "node:crypto";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { command } from "ccstate";
import { and, eq, inArray, isNotNull, notExists, sql } from "drizzle-orm";
import { iso, object, string, uuid } from "zod";
import { env } from "../../lib/env";
import {
  marketingRewardInvitationAuthorityEventSchema,
  type MarketingRewardSourceEvent,
} from "../../lib/marketing-reward-events";
import type { ClaimedBackgroundJob } from "./background-job.service";
import { nowDate } from "../../lib/time";
import {
  clerkRateLimit,
  readClerkInvitationAuthority,
} from "../external/clerk";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  claimBackgroundJob$,
  enqueueBackgroundJob$,
  transitionBackgroundJob$,
} from "./background-job-command.service";
import {
  MARKETING_REWARD_EVENT_JOB_KIND,
  MARKETING_REWARD_INVITATION_AUTHORITY_HANDLER_VERSION,
} from "./marketing-reward-event-publication";

const kind = "marketing-invitation-authority-observation";
function observationBatchSize(maximum: number | undefined) {
  const size = maximum ?? 4;
  if (!Number.isInteger(size) || size < 1 || size > 10) {
    throw new Error("Invitation observation batch must be between 1 and 10");
  }
  return size;
}
const sourceSchema = object({
  claimId: uuid(),
  claimCreatedAt: iso.datetime(),
  orgId: string().min(1),
  userId: string().min(1),
  sourceKey: string().min(1),
  invitationId: string().min(1),
}).strict();

function observationJobId(claimId: string, invitationId: string) {
  const bytes = createHash("sha256")
    .update(JSON.stringify([kind, claimId, invitationId]))
    .digest()
    .subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 15) | 128, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 63) | 128, 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const enqueueInvitationObservers$ = command(
  async ({ set }, args: { readonly claimId?: string }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const candidates = await db
      .select()
      .from(getStartedClaims)
      .where(
        and(
          eq(getStartedClaims.questKey, "invite"),
          args.claimId ? eq(getStartedClaims.id, args.claimId) : undefined,
          inArray(getStartedClaims.status, ["pending", "reviewing"]),
          isNotNull(getStartedClaims.invitationId),
          notExists(
            db
              .select({ id: backgroundJobs.id })
              .from(backgroundJobs)
              .where(
                and(
                  eq(backgroundJobs.kind, kind),
                  eq(backgroundJobs.handlerVersion, 1),
                  eq(backgroundJobs.userId, getStartedClaims.actorUserId),
                  eq(backgroundJobs.orgId, getStartedClaims.orgId),
                  sql`${backgroundJobs.input}->>'claimId' = ${getStartedClaims.id}::text`,
                  sql`${backgroundJobs.input}->>'invitationId' = ${getStartedClaims.invitationId}`,
                ),
              ),
          ),
        ),
      )
      .orderBy(getStartedClaims.createdAt, getStartedClaims.id)
      .limit(20);
    signal.throwIfAborted();
    const jobIds: string[] = [];
    for (const claim of candidates) {
      const input = sourceSchema.parse({
        claimId: claim.id,
        claimCreatedAt: claim.createdAt.toISOString(),
        orgId: claim.orgId,
        userId: claim.actorUserId,
        sourceKey: claim.sourceKey,
        invitationId: claim.invitationId,
      });
      const id = observationJobId(input.claimId, input.invitationId);
      await set(
        enqueueBackgroundJob$,
        {
          id,
          kind,
          handlerVersion: 1,
          userId: claim.actorUserId,
          orgId: claim.orgId,
          input,
        },
        signal,
      );
      jobIds.push(id);
    }
    return jobIds;
  },
);

const retainObservation$ = command(
  async (
    { set },
    job: ClaimedBackgroundJob,
    event: Extract<MarketingRewardSourceEvent, { version: 6 }>,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const { rowCount } = await db.execute(sql`INSERT INTO ${backgroundJobs}
        (id, kind, handler_version, user_id, org_id, input, available_at, created_at, updated_at)
        SELECT ${event.id}::uuid, ${MARKETING_REWARD_EVENT_JOB_KIND}, ${MARKETING_REWARD_INVITATION_AUTHORITY_HANDLER_VERSION},
          ${event.userId}, ${event.orgId}, ${JSON.stringify(event)}::jsonb,
          timezone('UTC', clock_timestamp()), timezone('UTC', clock_timestamp()), timezone('UTC', clock_timestamp())
        WHERE EXISTS (SELECT 1 FROM ${backgroundJobs} AS observation_job
          WHERE observation_job.id = ${job.id}::uuid AND observation_job.kind = ${kind}
            AND observation_job.status = 'running' AND observation_job.lease_id = ${job.leaseId}::uuid
            AND observation_job.lease_expires_at > timezone('UTC', clock_timestamp()))
          AND EXISTS (SELECT 1 FROM ${getStartedClaims}
            WHERE ${getStartedClaims.id} = ${event.claimId}::uuid AND ${getStartedClaims.questKey} = 'invite'
              AND ${getStartedClaims.orgId} = ${event.orgId} AND ${getStartedClaims.actorUserId} = ${event.userId}
              AND ${getStartedClaims.sourceKey} = ${event.sourceKey} AND ${getStartedClaims.invitationId} = ${event.invitationId})`);
    signal.throwIfAborted();
    return rowCount === 1;
  },
);

/** Existing retained claims own durable, bounded Clerk reads; no campaign or ledger writes. */
export const captureMarketingInvitationAuthority$ = command(
  async (
    { set },
    args: { readonly claimId?: string; readonly maxJobs?: number },
    signal: AbortSignal,
  ): Promise<{ processed: number; eventIds: string[] }> => {
    if (
      !env("MARKETING_REWARDS_EVENTS_ORIGIN") ||
      !env("MARKETING_REWARDS_EVENTS_SECRET")
    ) {
      return { processed: 0, eventIds: [] };
    }
    const budget = observationBatchSize(args.maxJobs);
    const queued = await set(enqueueInvitationObservers$, args, signal);
    const maximum = args.claimId ? Math.min(queued.length, 1) : budget;
    const eventIds: string[] = [];
    let processed = 0;
    for (; processed < maximum; processed++) {
      const job = await set(
        claimBackgroundJob$,
        {
          kind,
          handlerVersion: 1,
          ...(args.claimId ? { jobId: queued[processed] } : {}),
        },
        signal,
      );
      if (!job) {
        break;
      }
      const source = sourceSchema.parse(job.input);
      if (
        job.id !== observationJobId(source.claimId, source.invitationId) ||
        job.orgId !== source.orgId ||
        job.userId !== source.userId
      ) {
        throw new Error(
          "Invitation observation job has different original ownership",
        );
      }
      // Capture before provider I/O so a late response cannot acquire a later source clock.
      const observedAt = nowDate();
      const authority = await settle(
        readClerkInvitationAuthority(source.orgId, source.invitationId, signal),
        signal,
      );
      if (!authority.ok) {
        const rateLimit = clerkRateLimit(authority.error);
        await set(
          transitionBackgroundJob$,
          job,
          {
            kind: "retry",
            error: "Invitation authority was not observed",
            availableAt: new Date(
              observedAt.getTime() +
                Math.max(
                  (rateLimit?.retryAfterSeconds ?? 0) * 1000,
                  Math.min(
                    15 * 60_000,
                    60_000 * 2 ** Math.min(job.failureCount, 4),
                  ),
                ),
            ),
          },
          signal,
        );
        if (rateLimit) {
          processed++;
          break;
        }
        continue;
      }
      const event = marketingRewardInvitationAuthorityEventSchema.parse({
        version: 6,
        id: randomUUID(),
        environment: env("ENV"),
        type: "invitation.status-observed",
        occurredAt: observedAt.toISOString(),
        orgId: source.orgId,
        userId: source.userId,
        claimId: source.claimId,
        claimCreatedAt: source.claimCreatedAt,
        sourceKey: source.sourceKey,
        invitationId: source.invitationId,
        observation: authority.value
          ? { kind: "invitation", ...authority.value }
          : { kind: "unavailable" },
      });
      const retained = await set(retainObservation$, job, event, signal);
      if (!retained) {
        // A lost lease or changed local reference is not provider unavailability.
        await set(
          transitionBackgroundJob$,
          job,
          { kind: "complete", checkpoint: { sourceChanged: true } },
          signal,
        );
        continue;
      }
      eventIds.push(event.id);
      const terminal =
        !authority.value ||
        authority.value.status !== "pending" ||
        Date.parse(authority.value.expiresAt) <= observedAt.getTime();
      await set(
        transitionBackgroundJob$,
        job,
        terminal
          ? { kind: "complete", checkpoint: { eventId: event.id } }
          : {
              kind: "defer",
              availableAt: new Date(observedAt.getTime() + 60_000),
            },
        signal,
      );
    }
    return { processed, eventIds };
  },
);
