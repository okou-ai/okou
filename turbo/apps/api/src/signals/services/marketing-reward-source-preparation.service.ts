import { backgroundJobs } from "@okouai/db/schema/background-job";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { command } from "ccstate";
import {
  and,
  count,
  eq,
  inArray,
  isNotNull,
  notExists,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { captureMarketingInvitationAuthority$ } from "./marketing-invitation-observation.service";
import { deliverMarketingRewardEvents$ } from "./marketing-reward-event-delivery.service";
import { MARKETING_REWARD_EVENT_JOB_KIND } from "./marketing-reward-event-publication";

/** Operational source preparation never invokes campaign or financial processing. */
export const prepareMarketingRewardSources$ = command(
  async ({ set }, maxJobs: number, signal: AbortSignal) => {
    const [events, observations] = await Promise.all([
      set(deliverMarketingRewardEvents$, { maxJobs }, signal),
      set(captureMarketingInvitationAuthority$, { maxJobs: 10 }, signal),
    ]);
    signal.throwIfAborted();
    const db = set(writeDb$);
    const facts = alias(backgroundJobs, "invitation_facts");
    const [pending, unobserved] = await Promise.all([
      db
        .select({ total: count() })
        .from(backgroundJobs)
        .where(
          and(
            eq(backgroundJobs.kind, MARKETING_REWARD_EVENT_JOB_KIND),
            inArray(backgroundJobs.status, ["pending", "running", "failed"]),
          ),
        ),
      db
        .select({ total: count() })
        .from(getStartedClaims)
        .where(
          and(
            eq(getStartedClaims.questKey, "invite"),
            inArray(getStartedClaims.status, ["pending", "reviewing"]),
            isNotNull(getStartedClaims.invitationId),
            notExists(
              db
                .select({ id: facts.id })
                .from(facts)
                .where(
                  and(
                    eq(facts.kind, MARKETING_REWARD_EVENT_JOB_KIND),
                    eq(facts.handlerVersion, 6),
                    eq(facts.status, "completed"),
                    eq(facts.userId, getStartedClaims.actorUserId),
                    eq(facts.orgId, getStartedClaims.orgId),
                    sql`${facts.input}->>'environment' = ${env("ENV")}`,
                    sql`${facts.input}->>'claimId' = ${getStartedClaims.id}::text`,
                    sql`${facts.input}->>'invitationId' = ${getStartedClaims.invitationId}`,
                  ),
                ),
            ),
          ),
        ),
    ]);
    signal.throwIfAborted();
    const pendingTotal = pending[0];
    const unobservedTotal = unobserved[0];
    if (!pendingTotal || !unobservedTotal) {
      throw new Error("Source preparation counts were not returned");
    }
    return {
      processed: events.processed + observations.processed,
      cleaned: 0,
      sourcePending: pendingTotal.total,
      unobservedInvitations: unobservedTotal.total,
    };
  },
);
