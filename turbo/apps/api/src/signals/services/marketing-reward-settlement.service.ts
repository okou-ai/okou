import type { MarketingRewardIntent } from "@okouai/api-contracts/contracts/marketing-reward-settlement";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { command } from "ccstate";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { env } from "../../lib/env";
import {
  marketingRewardSourceEventSchema,
  type MarketingRewardSourceEvent,
} from "../../lib/marketing-reward-events";
import { marketingRewardIntentMatchesSource } from "../../lib/marketing-reward-financial-contract";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { MARKETING_REWARD_EVENT_JOB_KIND } from "./marketing-reward-event-publication";
import { completedGetStartedQuestPublication } from "./get-started-member-reward";
import { grantGetStartedClaim$ } from "./get-started-member-reward.service";
import type { GetStartedClaimRow } from "./get-started-rewards.service";
import { ensureGetStartedRewardWallet$ } from "./get-started-wallet.service";
import { settleSlackReward$ } from "./slack-reward.service";

const readSource$ = command(
  async ({ set }, id: string, signal: AbortSignal) => {
    const [job] = await set(writeDb$)
      .select()
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.id, id),
          eq(backgroundJobs.kind, MARKETING_REWARD_EVENT_JOB_KIND),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!job) {
      return null;
    }
    const event = marketingRewardSourceEventSchema.parse(job.input);
    if (
      job.handlerVersion !== event.version ||
      job.userId !== event.userId ||
      job.orgId !== event.orgId ||
      event.environment !== env("ENV")
    ) {
      throw new Error("Reward source proof does not match its owner");
    }
    return event;
  },
);

const readClaim$ = command(
  async ({ set }, intent: MarketingRewardIntent, signal: AbortSignal) => {
    const [claim] = await set(writeDb$)
      .select()
      .from(getStartedClaims)
      .where(
        and(
          eq(getStartedClaims.actorUserId, intent.actorUserId),
          eq(getStartedClaims.questKey, intent.questKey),
          eq(getStartedClaims.sourceKey, intent.sourceKey),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return claim ?? null;
  },
);

function matchesClaim(
  intent: MarketingRewardIntent,
  claim: GetStartedClaimRow,
) {
  return (
    claim.beneficiaryUserId === intent.beneficiaryUserId &&
    claim.rewardTarget === intent.rewardTarget &&
    claim.rewardAmount === intent.rewardAmount &&
    (claim.id !== intent.id || claim.orgId === intent.orgId) &&
    (claim.status !== "granted" || claim.rewardKey === intent.rewardKey)
  );
}

const publishAutomaticReward$ = command(
  async ({ set }, intent: MarketingRewardIntent, signal: AbortSignal) => {
    if (
      intent.questKey !== "connector" &&
      intent.questKey !== "imessage" &&
      intent.questKey !== "checkin"
    ) {
      throw new Error("Unexpected automatic financial operation");
    }
    const at = nowDate();
    const publication = completedGetStartedQuestPublication(
      {
        orgId: intent.orgId,
        userId: intent.actorUserId,
        questKey: intent.questKey,
        sourceKey: intent.sourceKey,
        claimId: intent.id,
        completedAt: new Date(intent.completedAt),
      },
      at,
    );
    await set(writeDb$).execute(
      sql`WITH claim AS (${publication.claim}) ${publication.grant}`,
    );
    signal.throwIfAborted();
  },
);

/** Persist the financial request under the existing legacy source identity. */
const prepareClaim$ = command(
  async (
    { set },
    args: {
      readonly intent: MarketingRewardIntent;
      readonly source: MarketingRewardSourceEvent;
    },
    signal: AbortSignal,
  ) => {
    const { intent, source } = args;
    const cappedAutomatic =
      intent.questKey === "connector" || intent.questKey === "imessage";
    const at = nowDate();
    await set(writeDb$)
      .insert(getStartedClaims)
      .values({
        id: intent.id,
        orgId: intent.orgId,
        actorUserId: intent.actorUserId,
        beneficiaryUserId: intent.beneficiaryUserId,
        questKey: intent.questKey,
        sourceKey: intent.sourceKey,
        rewardTarget: intent.rewardTarget,
        rewardAmount: intent.rewardAmount,
        status: cappedAutomatic ? "ineligible" : "pending",
        reason: cappedAutomatic ? "limit_reached" : null,
        completedAt: new Date(intent.completedAt),
        ...(source.type === "workflow.run-completed"
          ? {
              workflowId: source.workflowId,
              sourceEventId: source.sourceEventId,
              runId: source.runId,
            }
          : {}),
        ...(source.type === "invitation.accepted"
          ? {
              invitationId: source.invitationId,
              inviteeUserId: source.inviteeUserId,
            }
          : {}),
        nextAttemptAt: at,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();
  },
);

/** Reuse the existing financial lease so an older reviewer cannot publish afterward. */
const acquireClaim$ = command(
  async ({ set }, id: string, signal: AbortSignal) => {
    const at = nowDate();
    const [claim] = await set(writeDb$)
      .update(getStartedClaims)
      .set({
        status: "reviewing",
        leaseId: randomUUID(),
        leaseExpiresAt: new Date(at.getTime() + 60_000),
        updatedAt: at,
      })
      .where(
        and(
          eq(getStartedClaims.id, id),
          inArray(getStartedClaims.status, ["pending", "reviewing"]),
          or(
            isNull(getStartedClaims.leaseId),
            lte(getStartedClaims.leaseExpiresAt, at),
          ),
        ),
      )
      .returning();
    signal.throwIfAborted();
    return claim ?? null;
  },
);

const settleClaim$ = command(
  async (
    { set },
    args: {
      readonly intent: MarketingRewardIntent;
      readonly claim: GetStartedClaimRow;
    },
    signal: AbortSignal,
  ) => {
    const claim = await set(acquireClaim$, args.claim.id, signal);
    if (!claim) {
      return;
    }
    if (args.intent.questKey === "slack") {
      await set(settleSlackReward$, claim, signal);
    } else {
      await set(
        grantGetStartedClaim$,
        { claim, rewardKey: args.intent.rewardKey },
        signal,
      );
    }
    signal.throwIfAborted();
  },
);

type Resolution =
  | { readonly kind: "missing" | "conflict" }
  | { readonly kind: "receipt"; readonly claim: GetStartedClaimRow };

/** App verifies provenance and financial uniqueness; Marketing owns campaign orchestration. */
export const resolveMarketingRewardIntent$ = command(
  async (
    { set },
    args: { readonly intent: MarketingRewardIntent; readonly apply: boolean },
    signal: AbortSignal,
  ): Promise<Resolution> => {
    const { intent } = args;
    const source = await set(readSource$, intent.sourceEventId, signal);
    if (!source) {
      return { kind: "missing" };
    }
    if (!marketingRewardIntentMatchesSource(intent, source)) {
      return { kind: "conflict" };
    }
    let claim = await set(readClaim$, intent, signal);
    if (claim && !matchesClaim(intent, claim)) {
      return { kind: "conflict" };
    }
    if (
      !args.apply ||
      (claim && ["granted", "ineligible", "rejected"].includes(claim.status))
    ) {
      return claim ? { kind: "receipt", claim } : { kind: "missing" };
    }
    await set(ensureGetStartedRewardWallet$, intent.orgId, signal);
    if (
      !claim &&
      (intent.questKey === "connector" ||
        intent.questKey === "imessage" ||
        intent.questKey === "checkin")
    ) {
      await set(publishAutomaticReward$, intent, signal);
      claim = await set(readClaim$, intent, signal);
    }
    if (!claim) {
      await set(prepareClaim$, { intent, source }, signal);
      claim = await set(readClaim$, intent, signal);
    }
    if (!claim) {
      throw new Error("Marketing financial request was not persisted");
    }
    if (!matchesClaim(intent, claim)) {
      return { kind: "conflict" };
    }
    if (["pending", "reviewing"].includes(claim.status)) {
      await set(settleClaim$, { intent, claim }, signal);
    }
    const receipt = await set(readClaim$, intent, signal);
    if (!receipt) {
      throw new Error("Marketing financial receipt disappeared");
    }
    return { kind: "receipt", claim: receipt };
  },
);
