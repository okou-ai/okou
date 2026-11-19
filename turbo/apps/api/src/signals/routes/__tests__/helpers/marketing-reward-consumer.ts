import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { marketingRewardSettlementRoutes } from "../../marketing-reward-settlement";
import { createHash } from "node:crypto";
import {
  marketingRewardSettlementContract,
  marketingRewardIntentSchema,
  type MarketingRewardIntent,
} from "@okouai/api-contracts/contracts/marketing-reward-settlement";
import { http, HttpResponse } from "msw";
import { env, mockEnv } from "../../../../lib/env";
import {
  marketingRewardCheckinEventSchema,
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

/** External campaign requests the real financial capability for an authenticated check-in. */
export function marketingCheckinCampaign(context: TestContext) {
  const consumer = marketingRewardConsumer();
  const secret = "checkin-campaign-financial-test-1234567890123456789";
  mockEnv("MARKETING_REWARDS_CAMPAIGN_SECRET", secret);
  mockEnv("MARKETING_REWARDS_SETTLEMENT_SECRET", secret);
  server.use(
    http.post(
      "https://marketing-consumer.example.test/api/internal/marketing/get-started/check-in",
      async ({ request }) => {
        const source = marketingRewardCheckinEventSchema.parse(
          await request.json(),
        );
        const day = source.occurredAt.slice(0, 10);
        const result = await accept(
          setupApp({ context, routes: marketingRewardSettlementRoutes })(
            marketingRewardSettlementContract,
          ).settle({
            headers: { authorization: `Bearer ${secret}` },
            body: campaignRequest({
              version: 1,
              environment: source.environment,
              policy: "get-started-v1",
              sourceEventId: source.id,
              questKey: "checkin",
              sourceKey: day,
              rewardKey: `checkin:${source.userId}:${day}`,
              orgId: source.orgId,
              actorUserId: source.userId,
              beneficiaryUserId: source.userId,
              rewardTarget: "user",
              rewardAmount: 100,
              completedAt: source.occurredAt,
            }),
          }),
          [200, 202],
        );
        return HttpResponse.json(result.body, { status: result.status });
      },
    ),
  );
  return consumer;
}

/** Marketing's financial request is exercised through the real authenticated App endpoint. */
export function settleMarketingRequest(
  context: TestContext,
  terms: Omit<MarketingRewardIntent, "id">,
) {
  const secret =
    env("MARKETING_REWARDS_SETTLEMENT_SECRET") ??
    "external-campaign-settlement-123456789012345678901";
  mockEnv("MARKETING_REWARDS_SETTLEMENT_SECRET", secret);
  return accept(
    setupApp({ context, routes: marketingRewardSettlementRoutes })(
      marketingRewardSettlementContract,
    ).settle({
      headers: { authorization: `Bearer ${secret}` },
      body: campaignRequest(terms),
    }),
    [200],
  );
}
