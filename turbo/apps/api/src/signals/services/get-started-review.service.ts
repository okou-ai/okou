import { chatEvents } from "@okouai/db/schema/chat-event";
import { GET_STARTED_REWARDS_CHANGED_EVENT } from "@okouai/api-contracts/contracts/get-started";
import { safeUrlParse } from "../utils";
import { randomUUID } from "node:crypto";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import {
  grantGetStartedClaim,
  getStartedRewardsEnabled,
  type GetStartedClaimRow,
} from "./get-started-rewards.service";
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

async function reviewClaim(
  db: Db,
  claim: GetStartedClaimRow,
  signal: AbortSignal,
): Promise<Review> {
  if (claim.questKey === "share") {
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
    if (!/\bokou\b/i.test(post.text)) {
      return {
        kind: "reject",
        reason: "post_must_mention_okou",
        evidence: post.text,
      };
    }
    return {
      kind: "approve",
      rewardKey: `share:${post.id}`,
      evidence: post.text,
    };
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
        ),
      );
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
}

/** IDs are supplied only by the isolated test harness; production scans globally. */
export async function processGetStartedClaims(
  db: Db,
  options: { readonly claimIds?: readonly string[] },
  signal: AbortSignal,
): Promise<number> {
  const { claimIds } = options;
  let processed = 0;
  for (let i = 0; i < 10; i++) {
    signal.throwIfAborted();
    const at = nowDate();
    const claimed = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(getStartedClaims)
        .where(
          and(
            inArray(getStartedClaims.questKey, ["share", "workflow"]),
            inArray(getStartedClaims.status, ["pending", "reviewing"]),
            lte(getStartedClaims.nextAttemptAt, at),
            or(
              isNull(getStartedClaims.leaseExpiresAt),
              lte(getStartedClaims.leaseExpiresAt, at),
            ),
            claimIds ? inArray(getStartedClaims.id, [...claimIds]) : undefined,
          ),
        )
        .orderBy(getStartedClaims.nextAttemptAt, getStartedClaims.id)
        .for("update", { skipLocked: true })
        .limit(1);
      if (!row) {
        return null;
      }
      const [leased] = await tx
        .update(getStartedClaims)
        .set({
          status: "reviewing",
          leaseId: randomUUID(),
          leaseExpiresAt: new Date(at.getTime() + 60_000),
          attempts: sql`${getStartedClaims.attempts} + 1`,
          updatedAt: at,
        })
        .where(eq(getStartedClaims.id, row.id))
        .returning();
      if (!leased) {
        throw new Error("Get started review lease was not persisted");
      }
      return leased;
    });
    signal.throwIfAborted();
    if (!claimed) {
      break;
    }
    const enabled = await getStartedRewardsEnabled(
      db,
      claimed.orgId,
      claimed.beneficiaryUserId ?? claimed.actorUserId,
    );
    signal.throwIfAborted();
    const result: Review = enabled
      ? await reviewClaim(db, claimed, signal)
      : { kind: "retry", reason: "feature_disabled" };
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
      reviewed = await db.transaction(async (tx) => {
        return await grantGetStartedClaim(
          tx,
          claimed,
          result.rewardKey,
          result.evidence,
        );
      });
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
    // Notify only after the result and any credit writes have committed.
    if (
      reviewed?.beneficiaryUserId &&
      ["granted", "rejected", "ineligible"].includes(reviewed.status)
    ) {
      await publishUserSignal(
        [reviewed.beneficiaryUserId],
        GET_STARTED_REWARDS_CHANGED_EVENT,
      );
    }
    processed++;
  }
  return processed;
}
