import { backgroundJobs } from "@okouai/db/schema/background-job";
import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { v5 as uuidV5 } from "uuid";
import { env } from "../../lib/env";
import { marketingRewardCheckinEventSchema } from "../../lib/marketing-reward-events";
import { writeDb$ } from "../external/db";
import { startMarketingRewardEventDelivery$ } from "./marketing-reward-event-delivery.service";
import {
  MARKETING_REWARD_CHECKIN_EVENT_HANDLER_VERSION,
  MARKETING_REWARD_EVENT_JOB_KIND,
} from "./marketing-reward-event-publication";

const checkinNamespace = "138d466f-471c-4b24-9611-d223ef2cac62";

/** Only the authenticated check-in action records a request, independently of its funding. */
export const requestMarketingRewardCheckin$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestedAt: Date;
    },
    signal: AbortSignal,
  ) => {
    const occurredAt = args.requestedAt.toISOString();
    const day = occurredAt.slice(0, 10);
    const environment = env("ENV");
    const id = uuidV5(
      JSON.stringify([environment, args.userId, day]),
      checkinNamespace,
    );
    const input = marketingRewardCheckinEventSchema.parse({
      version: 5,
      id,
      environment,
      type: "checkin.requested",
      occurredAt,
      orgId: args.orgId,
      userId: args.userId,
    });
    // The business key is user + UTC day, independent of the selected org.
    // Return the first snapshot without resetting its input or delivery state.
    const [job] = await set(writeDb$)
      .insert(backgroundJobs)
      .values({
        id,
        kind: MARKETING_REWARD_EVENT_JOB_KIND,
        handlerVersion: MARKETING_REWARD_CHECKIN_EVENT_HANDLER_VERSION,
        userId: args.userId,
        orgId: args.orgId,
        input,
      })
      .onConflictDoUpdate({
        target: backgroundJobs.id,
        set: { id: sql`${backgroundJobs.id}` },
      })
      .returning();
    signal.throwIfAborted();
    if (!job) {
      throw new Error("Check-in request was not persisted");
    }
    const request = marketingRewardCheckinEventSchema.parse(job.input);
    if (
      job.kind !== MARKETING_REWARD_EVENT_JOB_KIND ||
      job.handlerVersion !== request.version ||
      job.id !== request.id ||
      request.id !== id ||
      job.userId !== request.userId ||
      request.userId !== args.userId ||
      job.orgId !== request.orgId ||
      request.environment !== environment ||
      request.occurredAt.slice(0, 10) !== day
    ) {
      throw new Error("Check-in request does not match its durable owner");
    }
    // The exact retained request can make progress immediately; cron still
    // recovers transport failures and requests interrupted after their commit.
    set(
      startMarketingRewardEventDelivery$,
      {
        jobId: job.id,
        handlerVersion: MARKETING_REWARD_CHECKIN_EVENT_HANDLER_VERSION,
      },
      signal,
    );
    return request;
  },
);
