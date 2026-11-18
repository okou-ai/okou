import { createHash } from "node:crypto";
import {
  marketingRewardIntentSchema,
  type MarketingRewardIntent,
} from "@okouai/api-contracts/contracts/marketing-reward-settlement";
import { http, HttpResponse } from "msw";
import { mockEnv } from "../../../../lib/env";
import {
  marketingRewardSourceEventSchema,
  type MarketingRewardSourceEvent,
} from "../../../../lib/marketing-reward-events";
import { server } from "../../../../mocks/server";

/** External Marketing consumer: observe the real HTTP feed and retain its exact facts. */
export function marketingRewardConsumer() {
  const received: MarketingRewardSourceEvent[] = [];
  mockEnv(
    "MARKETING_REWARDS_EVENTS_ORIGIN",
    "https://marketing-consumer.example.test",
  );
  mockEnv(
    "MARKETING_REWARDS_EVENTS_SECRET",
    "consumer-intake-12345678901234567890123456789",
  );
  server.use(
    http.post(
      "https://marketing-consumer.example.test/api/internal/marketing/get-started/events",
      async ({ request }) => {
        const event = marketingRewardSourceEventSchema.parse(
          await request.json(),
        );
        received.push(event);
        return HttpResponse.json({
          version: 1,
          environment: event.environment,
          eventId: event.id,
          hash: createHash("sha256")
            .update(JSON.stringify(event))
            .digest("hex"),
          receivedAt: "2026-11-17T04:00:00.000Z",
        });
      },
    ),
  );
  return { received };
}

/** The caller computes the published wire identity independently of App's validator. */
export function campaignRequest(
  terms: Omit<MarketingRewardIntent, "id">,
): MarketingRewardIntent {
  const identity = [
    terms.version,
    terms.environment,
    terms.policy,
    terms.sourceEventId.toLowerCase(),
    terms.questKey,
    terms.sourceKey,
    terms.rewardKey,
    terms.orgId,
    terms.actorUserId,
    terms.beneficiaryUserId,
    terms.rewardTarget,
    terms.rewardAmount,
    terms.completedAt,
  ];
  const bytes = createHash("sha256")
    .update("marketing:get-started-intent:v1\0")
    .update(JSON.stringify(identity))
    .digest()
    .subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 15) | 128, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 63) | 128, 8);
  const hex = bytes.toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return marketingRewardIntentSchema.parse({ ...terms, id });
}
