import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function member() {
  return { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` };
}

function uploadsClient(actor: {
  readonly userId: string;
  readonly orgId: string | null;
}) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  return setupApp({
    context,
    routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
  })(uploadsContract);
}

describe("POST /api/uploads/complete", () => {
  it("uploads-complete-005 completes an ordinary session upload without a run artifact association", async () => {
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/uploads/plain.txt",
    );
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const { constructor, input } = command as {
        readonly constructor: { readonly name: string };
        readonly input?: { readonly Key?: string };
      };
      if (
        constructor.name === "GetObjectCommand" &&
        !input?.Key?.startsWith("private-artifacts/")
      ) {
        return Promise.reject(
          Object.assign(new Error("Missing object"), {
            name: "NoSuchKey",
          }),
        );
      }
      if (constructor.name === "HeadObjectCommand") {
        return Promise.resolve({
          ContentLength: 5,
          ContentType: "text/plain",
        });
      }
      if (constructor.name === "GetObjectCommand") {
        return Promise.resolve({
          ContentLength: 5,
          ContentType: "text/plain",
          Body: Readable.from([Buffer.from("hello")]),
        });
      }
      if (constructor.name === "PutObjectCommand") {
        return Promise.resolve({ ETag: '"etag-1"' });
      }
      return Promise.resolve({});
    });

    const client = uploadsClient(member());
    const prepared = await accept(
      client.prepare({
        headers,
        body: {
          filename: "plain.txt",
          contentType: "text/plain",
          size: 5,
        },
      }),
      [200],
    );

    const completed = await accept(
      client.complete({
        headers,
        body: { id: prepared.body.id },
      }),
      [200],
    );

    expect(completed.body).toMatchObject({
      id: prepared.body.id,
      filename: "plain.txt",
      size: 5,
    });
  });

  it("uploads-complete-015 rejects suspended orgs before completing the upload", async () => {
    const actor = member();
    const suffix = randomUUID();
    const customerId = `cus_unfunded_pro_${suffix}`;
    const subscription = {
      id: `sub_unfunded_pro_${suffix}`,
      customer: customerId,
      status: "active",
      metadata: {},
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      trial_end: null,
      items: { data: [{ price: { id: "price_bdd_pro" } }] },
    };

    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureStripeBillingEnv();
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: actor.orgId },
    });
    await webhooks.postStripeEvent(
      {
        id: `evt_pro_created_${suffix}`,
        type: "customer.subscription.created",
        created: Math.floor(now() / 1000),
        data: { object: subscription },
      },
      [200],
    );
    await webhooks.postStripeEvent(
      {
        id: `evt_pro_suspended_${suffix}`,
        type: "customer.subscription.updated",
        created: Math.floor(now() / 1000),
        data: { object: { ...subscription, status: "canceled" } },
      },
      [200],
    );
    await flushWaitUntilForTest();

    const response = await accept(
      uploadsClient(actor).complete({
        headers,
        body: { id: randomUUID() },
      }),
      [402],
    );

    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });
});
