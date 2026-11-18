import { marketingRewardReceiptSchema } from "@okouai/api-contracts/contracts/marketing-reward-settlement";
import { marketingRewardProgressSourceSchema } from "@okouai/api-contracts/contracts/marketing-reward-notification";
import { command } from "ccstate";
import type { ClaimedBackgroundJob } from "./background-job.service";
import {
  discriminatedUnion,
  literal,
  object,
  string,
  uuid,
  enum as zEnum,
} from "zod";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { publishMarketingRewardProjection } from "../external/realtime";
import { settle } from "../utils";
import {
  claimBackgroundJob$,
  transitionBackgroundJob$,
} from "./background-job-command.service";

export const MARKETING_REWARD_PROJECTION_JOB_KIND =
  "marketing-reward-projection-refresh";

const financialProjectionSchema = object({
  version: literal(1),
  environment: zEnum(["production", "preview", "development"]),
  intentId: uuid(),
  receipt: marketingRewardReceiptSchema,
}).strict();
const progressProjectionSchema = object({
  version: literal(2),
  environment: zEnum(["production", "preview", "development"]),
  source: marketingRewardProgressSourceSchema,
  target: object({
    actorUserId: string().min(1).max(256),
    beneficiaryUserId: string().min(1).max(256),
    orgId: string().min(1).max(256),
    rewardTarget: literal("user"),
  }).strict(),
}).strict();
const projectionSchema = discriminatedUnion("version", [
  financialProjectionSchema,
  progressProjectionSchema,
]);

const publishProjection$ = command(
  async (
    { set },
    job: ClaimedBackgroundJob,
    signal: AbortSignal,
  ): Promise<void> => {
    const input = projectionSchema.parse(job.input);
    const target = input.version === 1 ? input.receipt : input.target;
    if (
      input.version !== job.handlerVersion ||
      input.environment !== env("ENV") ||
      target.orgId !== job.orgId ||
      target.actorUserId !== job.userId
    ) {
      throw new Error("Reward projection job ownership mismatch");
    }
    const published = await settle(
      publishMarketingRewardProjection(target, signal),
    );
    signal.throwIfAborted();
    if (!published.ok) {
      await set(
        transitionBackgroundJob$,
        job,
        {
          kind: "retry",
          error: "Reward projection refresh was not acknowledged",
          availableAt: new Date(
            nowDate().getTime() +
              Math.min(
                15 * 60_000,
                30_000 * 2 ** Math.min(job.failureCount, 5),
              ),
          ),
        },
        signal,
      );
      return;
    }
    await set(
      transitionBackgroundJob$,
      job,
      { kind: "complete", checkpoint: { published: true } },
      signal,
    );
  },
);

/** A committed notification can be delivered without waiting for a queue sweep. */
export const deliverMarketingRewardProjection$ = command(
  async (
    { set },
    { jobId, handlerVersion }: { jobId: string; handlerVersion: 1 | 2 },
    signal: AbortSignal,
  ): Promise<void> => {
    const job = await set(
      claimBackgroundJob$,
      { jobId, kind: MARKETING_REWARD_PROJECTION_JOB_KIND, handlerVersion },
      signal,
    );
    if (job) {
      await set(publishProjection$, job, signal);
    }
    signal.throwIfAborted();
  },
);

/** Four independent leases per version preserve progress when one publish fails. */
export const deliverMarketingRewardProjections$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const jobs: ClaimedBackgroundJob[] = [];
    for (const handlerVersion of [1, 2]) {
      for (let index = 0; index < 4; index += 1) {
        const job = await set(
          claimBackgroundJob$,
          { kind: MARKETING_REWARD_PROJECTION_JOB_KIND, handlerVersion },
          signal,
        );
        if (!job) {
          break;
        }
        jobs.push(job);
      }
    }
    const outcomes = await Promise.allSettled(
      jobs.map((job) => {
        return set(publishProjection$, job, signal);
      }),
    );
    signal.throwIfAborted();
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
    }
    return jobs.length;
  },
);
