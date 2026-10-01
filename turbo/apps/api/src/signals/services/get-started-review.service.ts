import { chatEvents } from "@okouai/db/schema/chat-event";
import { GET_STARTED_REWARDS_CHANGED_EVENT } from "@okouai/api-contracts/contracts/get-started";
import { safeUrlParse } from "../utils";
import { randomUUID } from "node:crypto";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import type { GetStartedClaimRow } from "./get-started-rewards.service";
import { grantGetStartedClaim$ } from "./get-started-member-reward.service";
import { readGetStartedRewardPost } from "./social.service";

export function normalizeGetStartedPostUrl(
  input: string,
): { readonly id: string; readonly url: string } | null {
  const url = safeUrlParse(input);
  if (!url) {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
      url.hostname,
    )
  ) {
    return null;
  }
  const match =
    /^\/(?:[A-Za-z0-9_]+\/status|i\/web\/status)\/([1-9][0-9]{0,19})\/?$/.exec(
      url.pathname,
    );
  if (!match?.[1]) {
    return null;
  }
  return { id: match[1], url: `https://x.com/i/status/${match[1]}` };
}

/**
 * Okou's official X account, as a lowercased handle. Its posts mention Okou by
 * definition, so pasting one proves nothing about the claimant.
 */
const OFFICIAL_OKOU_X_HANDLE = "okou_ai";

/**
 * "Okou" as its own token: matches "Okou", "@okou_ai", "#okou", "okou.ai",
 * "Okou's" and Okou next to CJK text, but not an ASCII word that merely
 * contains it, such as "tokou".
 */
const OKOU_MENTION = /(?<![a-z0-9])okou(?![a-z0-9])/i;

/**
 * One share reward per X author, enforced by the global unique reward key.
 * Grants made before author keys existed used `share:{postId}`; post IDs are
 * numeric, so the two forms cannot collide.
 */
function shareAuthorRewardKey(handle: string): string {
  return `share:author:${handle}`;
}

type Review =
  | {
      readonly kind: "approve";
      readonly rewardKey: string;
      readonly evidence: string;
    }
  | {
      readonly kind: "reject";
      readonly reason: string;
      readonly evidence: string | null;
    }
  | { readonly kind: "retry"; readonly reason: string };

function reject(reason: string, evidence: string): Review {
  return { kind: "reject", reason, evidence };
}

const reviewShareClaim$ = command(
  async (
    { set },
    claim: GetStartedClaimRow,
    signal: AbortSignal,
  ): Promise<Review> => {
    const db = set(writeDb$);
    if (!claim.postUrl) {
      throw new Error("X reward claim has no post URL");
    }
    const post = await readGetStartedRewardPost(claim.postUrl, signal);
    if (post.kind === "retry") {
      return post;
    }
    if (post.id !== claim.sourceKey) {
      return { kind: "retry", reason: "post_id_mismatch" };
    }
    if (!OKOU_MENTION.test(post.text)) {
      return reject("post_must_mention_okou", post.text);
    }
    if (!post.authorHandle) {
      return reject("post_author_unavailable", post.text);
    }
    if (post.authorHandle === OFFICIAL_OKOU_X_HANDLE) {
      return reject("post_by_official_account", post.text);
    }
    const rewardKey = shareAuthorRewardKey(post.authorHandle);
    const [rewarded] = await db
      .select({ id: getStartedClaims.id })
      .from(getStartedClaims)
      .where(eq(getStartedClaims.rewardKey, rewardKey))
      .limit(1);
    signal.throwIfAborted();
    if (rewarded) {
      // A concurrent grant for the same author is still caught by the unique
      // reward key and recorded as already_redeemed.
      return reject("author_already_rewarded", post.text);
    }
    return { kind: "approve", rewardKey, evidence: post.text };
  },
);

const reviewClaim$ = command(
  async (
    { set },
    claim: GetStartedClaimRow,
    signal: AbortSignal,
  ): Promise<Review> => {
    const db = set(writeDb$);
    if (claim.questKey === "share") {
      return await set(reviewShareClaim$, claim, signal);
    }
    if (!claim.sourceEventId || !claim.workflowId || !claim.beneficiaryUserId) {
      throw new Error("Workflow reward claim has no source provenance");
    }
    if (!claim.leaseId) {
      throw new Error("Workflow review has no lease");
    }
    let runId = claim.runId;
    if (!runId) {
      const [replacement] = await db
        .select({ runId: chatEvents.runId, eventType: chatEvents.eventType })
        .from(chatEvents)
        .where(eq(chatEvents.revokesEventId, claim.sourceEventId))
        .limit(1);
      signal.throwIfAborted();
      if (!replacement) {
        return { kind: "retry", reason: "run_queued" };
      }
      if (
        !replacement.runId ||
        !["input.prompt", "input.automation"].includes(replacement.eventType)
      ) {
        return {
          kind: "reject",
          reason: "workflow_request_replaced",
          evidence: null,
        };
      }
      runId = replacement.runId;
      await db
        .update(getStartedClaims)
        .set({ runId })
        .where(
          and(
            eq(getStartedClaims.id, claim.id),
            eq(getStartedClaims.leaseId, claim.leaseId),
            eq(getStartedClaims.status, "reviewing"),
          ),
        );
      signal.throwIfAborted();
    }
    const [run] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, claim.orgId)))
      .limit(1);
    signal.throwIfAborted();
    if (!run) {
      return { kind: "reject", reason: "run_unavailable", evidence: null };
    }
    if (run.status === "completed") {
      return {
        kind: "approve",
        rewardKey: `workflow:${claim.beneficiaryUserId}`,
        evidence: `Workflow ${claim.workflowId}, completed run ${runId}`,
      };
    }
    if (run.status === "failed" || run.status === "cancelled") {
      return { kind: "reject", reason: "run_did_not_complete", evidence: null };
    }
    return { kind: "retry", reason: "run_in_progress" };
  },
);

/** IDs are supplied only by the isolated test harness; production scans globally. */
export const processGetStartedClaims$ = command(
  async (
    { set },
    options: { readonly claimIds?: readonly string[] },
    signal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);
    const { claimIds } = options;
    let processed = 0;
    for (let i = 0; i < 10; i++) {
      signal.throwIfAborted();
      const at = nowDate();
      const eligible = and(
        inArray(getStartedClaims.questKey, ["share", "workflow"]),
        inArray(getStartedClaims.status, ["pending", "reviewing"]),
        lte(getStartedClaims.nextAttemptAt, at),
        or(
          isNull(getStartedClaims.leaseExpiresAt),
          lte(getStartedClaims.leaseExpiresAt, at),
        ),
        claimIds ? inArray(getStartedClaims.id, [...claimIds]) : undefined,
      );
      // The candidate is advisory; eligibility is rechecked by UPDATE after a
      // concurrent owner commits. A lost candidate is left to the next scan.
      const candidate = db
        .select({ id: getStartedClaims.id })
        .from(getStartedClaims)
        .where(eligible)
        .orderBy(getStartedClaims.nextAttemptAt, getStartedClaims.id)
        .limit(1);
      const [claimed] = await db
        .update(getStartedClaims)
        .set({
          status: "reviewing",
          leaseId: randomUUID(),
          leaseExpiresAt: new Date(at.getTime() + 60_000),
          attempts: sql`${getStartedClaims.attempts} + 1`,
          updatedAt: at,
        })
        .where(and(eq(getStartedClaims.id, candidate), eligible))
        .returning();
      signal.throwIfAborted();
      if (!claimed) {
        break;
      }
      const result: Review = await set(reviewClaim$, claimed, signal);
      signal.throwIfAborted();
      if (!claimed.leaseId) {
        throw new Error("Get started review has no lease");
      }
      const lease = and(
        eq(getStartedClaims.id, claimed.id),
        eq(getStartedClaims.leaseId, claimed.leaseId),
        eq(getStartedClaims.status, "reviewing"),
      );
      let reviewed: GetStartedClaimRow | undefined;
      if (result.kind === "approve") {
        reviewed = await set(
          grantGetStartedClaim$,
          {
            claim: claimed,
            rewardKey: result.rewardKey,
            evidenceText: result.evidence,
          },
          signal,
        );
      } else if (result.kind === "reject") {
        [reviewed] = await db
          .update(getStartedClaims)
          .set({
            status: "rejected",
            reason: result.reason,
            evidenceText: result.evidence,
            reviewedAt: nowDate(),
            leaseId: null,
            leaseExpiresAt: null,
            updatedAt: nowDate(),
          })
          .where(lease)
          .returning();
      } else {
        const delay = Math.min(
          30 * 60_000,
          60_000 * 2 ** Math.min(claimed.attempts - 1, 5),
        );
        await db
          .update(getStartedClaims)
          .set({
            status: "pending",
            reason: result.reason,
            leaseId: null,
            leaseExpiresAt: null,
            nextAttemptAt: new Date(nowDate().getTime() + delay),
            updatedAt: nowDate(),
          })
          .where(lease);
      }
      signal.throwIfAborted();
      // Notify only after the result and any credit writes have committed.
      if (
        reviewed?.beneficiaryUserId &&
        ["granted", "rejected", "ineligible"].includes(reviewed.status)
      ) {
        await publishUserSignal(
          [reviewed.beneficiaryUserId],
          GET_STARTED_REWARDS_CHANGED_EVENT,
        );
        signal.throwIfAborted();
      }
      processed++;
    }
    return processed;
  },
);
