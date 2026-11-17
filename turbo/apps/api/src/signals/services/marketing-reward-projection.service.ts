import { marketingRewardReceiptSchema } from "@okouai/api-contracts/contracts/marketing-reward-settlement";
import { command } from "ccstate";
import type { ClaimedBackgroundJob } from "./background-job.service";
import { literal, object, uuid, enum as zEnum } from "zod";
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

const projectionSchema = object({
  version: literal(1),
  environment: zEnum(["production", "preview", "development"]),
  intentId: uuid(),
  receipt: marketingRewardReceiptSchema,
}).strict();

const publishProjection$ = command(
  async (
    { set },
    job: ClaimedBackgroundJob,
    signal: AbortSignal,
  ): Promise<void> => {
    const input = projectionSchema.parse(job.input);
    if (
      input.environment !== env("ENV") ||
      input.receipt.orgId !== job.orgId ||
      input.receipt.actorUserId !== job.userId
    ) {
      throw new Error("Reward projection job ownership mismatch");
    }
    const published = await settle(
      publishMarketingRewardProjection(input.receipt, signal),
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

/** Four independent leases give later notifications progress when one publish fails. */
export const deliverMarketingRewardProjections$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const jobs: ClaimedBackgroundJob[] = [];
    for (let index = 0; index < 4; index += 1) {
      const job = await set(
        claimBackgroundJob$,
        { kind: MARKETING_REWARD_PROJECTION_JOB_KIND, handlerVersion: 1 },
        signal,
      );
      if (!job) {
        break;
      }
      jobs.push(job);
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
