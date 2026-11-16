import { command } from "ccstate";
import { env } from "../../lib/env";
import {
  marketingRewardEventHash,
  marketingRewardEventReceiptSchema,
  marketingRewardOAuthEventSchema,
  type MarketingRewardOAuthEvent,
} from "../../lib/marketing-reward-events";
import { nowDate } from "../../lib/time";
import { settle } from "../utils";
import {
  claimBackgroundJob$,
  transitionBackgroundJob$,
} from "./background-job-command.service";
import {
  MARKETING_REWARD_EVENT_HANDLER_VERSION,
  MARKETING_REWARD_EVENT_JOB_KIND,
} from "./marketing-reward-event-publication";

const requestEventReceipt$ = command(
  async (
    _,
    args: {
      readonly event: MarketingRewardOAuthEvent;
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

/** Cron owns recovery. A lost receipt retries the identical stored event. */
export const deliverMarketingRewardEvents$ = command(
  async (
    { set },
    _args: Record<string, never>,
    signal: AbortSignal,
  ): Promise<{ readonly processed: number }> => {
    const origin = env("MARKETING_REWARDS_EVENTS_ORIGIN");
    const secret = env("MARKETING_REWARDS_EVENTS_SECRET");
    if (!origin && !secret) return { processed: 0 };
    if (!origin || !secret) {
      throw new Error(
        "Marketing reward event delivery is partially configured",
      );
    }
    let processed = 0;
    while (processed < 10) {
      const job = await set(
        claimBackgroundJob$,
        {
          kind: MARKETING_REWARD_EVENT_JOB_KIND,
          handlerVersion: MARKETING_REWARD_EVENT_HANDLER_VERSION,
        },
        signal,
      );
      signal.throwIfAborted();
      if (!job) break;
      const event = marketingRewardOAuthEventSchema.parse(job.input);
      if (
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
          { event, origin, secret },
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
    }
    return { processed };
  },
);
