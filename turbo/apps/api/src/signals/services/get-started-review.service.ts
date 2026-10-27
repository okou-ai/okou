import { GET_STARTED_REWARDS_CHANGED_EVENT } from "@okouai/api-contracts/contracts/get-started";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { command } from "ccstate";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { grantGetStartedClaim$ } from "./get-started-member-reward.service";
import type { GetStartedClaimRow } from "./get-started-rewards.service";

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

const reviewClaim$ = command(
  async (
    { set },
    claim: GetStartedClaimRow,
    signal: AbortSignal,
  ): Promise<Review> => {
    const db = set(writeDb$);
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

/** Process eligible pending claims through the production worker. */
export const processGetStartedClaims$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    let processed = 0;
    for (let i = 0; i < 10; i++) {
      signal.throwIfAborted();
      const at = nowDate();
      const eligible = and(
        eq(getStartedClaims.questKey, "workflow"),
        inArray(getStartedClaims.status, ["pending", "reviewing"]),
        lte(getStartedClaims.nextAttemptAt, at),
        or(
          isNull(getStartedClaims.leaseExpiresAt),
          lte(getStartedClaims.leaseExpiresAt, at),
        ),
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
