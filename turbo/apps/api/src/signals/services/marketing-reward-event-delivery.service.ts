import { command } from "ccstate";
import { env } from "../../lib/env";
import {
  marketingRewardEventHash,
  marketingRewardEventReceiptSchema,
  marketingRewardSourceEventSchema,
  type MarketingRewardSourceEvent,
} from "../../lib/marketing-reward-events";
import { nowDate } from "../../lib/time";
import { captureMarketingInvitationAuthority$ } from "./marketing-invitation-observation.service";
import { settle } from "../utils";
import {
  claimBackgroundJob$,
  transitionBackgroundJob$,
} from "./background-job-command.service";
import {
  MARKETING_REWARD_EVENT_HANDLER_VERSION,
  MARKETING_REWARD_EVENT_JOB_KIND,
  MARKETING_REWARD_LINK_EVENT_HANDLER_VERSION,
  MARKETING_REWARD_INVITATION_EVENT_HANDLER_VERSION,
  MARKETING_REWARD_WORKFLOW_EVENT_HANDLER_VERSION,
  MARKETING_REWARD_CHECKIN_EVENT_HANDLER_VERSION,
  MARKETING_REWARD_INVITATION_AUTHORITY_HANDLER_VERSION,
} from "./marketing-reward-event-publication";

const requestEventReceipt$ = command(
  async (
    _,
    args: {
      readonly event: MarketingRewardSourceEvent;
      readonly origin: string;
      readonly secret: string;
    },
    signal: AbortSignal,
  ) => {
    const { event } = args;
    const response = await fetch(
      new URL("/api/internal/marketing/get-started/events", args.origin),
      {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${args.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(event),
        signal,
      },
    );
    signal.throwIfAborted();
    if (response.status !== 200) {
      throw new Error("Marketing did not acknowledge reward source storage");
    }
    const receipt = marketingRewardEventReceiptSchema.parse(
      await response.json(),
    );
    signal.throwIfAborted();
    if (
      receipt.eventId !== event.id ||
      receipt.environment !== event.environment ||
      receipt.hash !== marketingRewardEventHash(event)
    ) {
      throw new Error(
        "Marketing reward source receipt does not match the fact",
      );
    }
    return receipt;
  },
);

const deliverEventVersion$ = command(
  async (
    { set },
    args: {
      readonly origin: string;
      readonly secret: string;
      readonly handlerVersion: 1 | 2 | 3 | 4 | 5 | 6;
      readonly jobId?: string;
      readonly maxJobs?: number;
    },
    signal: AbortSignal,
  ): Promise<{ readonly processed: number }> => {
    let processed = 0;
    while (processed < (args.maxJobs ?? 10)) {
      const job = await set(
        claimBackgroundJob$,
        {
          kind: MARKETING_REWARD_EVENT_JOB_KIND,
          handlerVersion: args.handlerVersion,
          jobId: args.jobId,
        },
        signal,
      );
      signal.throwIfAborted();
      if (!job) {
        break;
      }
      const event = marketingRewardSourceEventSchema.parse(job.input);
      if (
        event.version !== job.handlerVersion ||
        event.id !== job.id ||
        event.orgId !== job.orgId ||
        event.userId !== job.userId ||
        event.environment !== env("ENV")
      ) {
        throw new Error("Reward source event does not match its durable owner");
      }
      const attempt = await settle(
        set(
          requestEventReceipt$,
          { event, origin: args.origin, secret: args.secret },
          AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        ),
        signal,
      );
      signal.throwIfAborted();
      processed += 1;
      if (!attempt.ok) {
        // Keep unacknowledged facts recoverable. Never persist provider bodies,
        // credentials or transport errors that could contain sensitive values.
        await set(
          transitionBackgroundJob$,
          job,
          {
            kind: "retry",
            error: "Marketing reward source storage was not acknowledged",
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
        signal.throwIfAborted();
        break;
      }
      // Local write failures remain visible. If completion is uncertain, the
      // existing lease recovery sends the same fact and recovers its receipt.
      await set(
        transitionBackgroundJob$,
        job,
        { kind: "complete", checkpoint: { receipt: attempt.value } },
        signal,
      );
      signal.throwIfAborted();
      if (args.jobId && event.type === "invitation.attributed") {
        await set(
          captureAndDeliverInvitation$,
          { claimId: event.claimId, origin: args.origin, secret: args.secret },
          signal,
        );
      }
    }
    return { processed };
  },
);

const captureAndDeliverInvitation$ = command(
  async (
    { set },
    args: {
      readonly claimId: string;
      readonly origin: string;
      readonly secret: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const observed = await set(
      captureMarketingInvitationAuthority$,
      { claimId: args.claimId },
      signal,
    );
    for (const jobId of observed.eventIds) {
      await set(
        deliverEventVersion$,
        {
          origin: args.origin,
          secret: args.secret,
          handlerVersion: MARKETING_REWARD_INVITATION_AUTHORITY_HANDLER_VERSION,
          jobId,
        },
        signal,
      );
    }
  },
);

/** Independent version queues retain bounded progress during a mixed rollout. */
export const deliverMarketingRewardEvents$ = command(
  async (
    { set },
    args: {
      readonly jobId?: string;
      readonly handlerVersion?: 1 | 2 | 3 | 4 | 5 | 6;
      readonly maxJobs?: number;
    },
    signal: AbortSignal,
  ): Promise<{ readonly processed: number }> => {
    const origin = env("MARKETING_REWARDS_EVENTS_ORIGIN");
    const secret = env("MARKETING_REWARDS_EVENTS_SECRET");
    if (!origin && !secret) {
      return { processed: 0 };
    }
    if (!origin || !secret) {
      throw new Error(
        "Marketing reward event delivery is partially configured",
      );
    }
    const maxJobs = args.maxJobs ?? 10;
    if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 100) {
      throw new Error("Reward delivery batch must be between 1 and 100");
    }
    const results = await Promise.all(
      (
        [
          MARKETING_REWARD_EVENT_HANDLER_VERSION,
          MARKETING_REWARD_LINK_EVENT_HANDLER_VERSION,
          MARKETING_REWARD_INVITATION_EVENT_HANDLER_VERSION,
          MARKETING_REWARD_WORKFLOW_EVENT_HANDLER_VERSION,
          MARKETING_REWARD_CHECKIN_EVENT_HANDLER_VERSION,
          MARKETING_REWARD_INVITATION_AUTHORITY_HANDLER_VERSION,
        ] as const
      )
        .filter((handlerVersion) => {
          return (
            args.handlerVersion === undefined ||
            args.handlerVersion === handlerVersion
          );
        })
        .map((handlerVersion) => {
          return set(
            deliverEventVersion$,
            { origin, secret, handlerVersion, jobId: args.jobId, maxJobs },
            signal,
          );
        }),
    );
    signal.throwIfAborted();
    return {
      processed: results.reduce((sum, result) => {
        return sum + result.processed;
      }, 0),
    };
  },
);
