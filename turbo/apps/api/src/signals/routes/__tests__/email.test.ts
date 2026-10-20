import { beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const resendMocks = context.mocks.resend;
const webhooks = createWebhookCallbackApi(context);

const INBOUND_SECRET = "whsec_test";

interface WebhookEvent {
  readonly type: string;
  readonly data?: {
    readonly email_id?: string;
    readonly to?: readonly string[];
    readonly from?: string;
    readonly subject?: string;
  };
}

async function postInbound(event: WebhookEvent) {
  return await webhooks.requestResendInboundWebhook(
    event,
    webhooks.signedResendWebhookHeaders(event),
    [200],
  );
}

beforeEach(() => {
  resendMocks.send.mockReset();
  resendMocks.send.mockResolvedValue({ data: { id: "resend-test-id" } });
  mockEnv("RESEND_API_KEY", "test-resend-key");
  mockEnv("RESEND_WEBHOOK_SECRET", INBOUND_SECRET);
  mockEnv("RESEND_FROM_DOMAIN", "okou.io");
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
});

describe("POST /api/email/inbound", () => {
  it("rejects missing or invalid Svix signatures", async () => {
    const missingHeaders = await webhooks.requestResendInboundWebhook(
      { type: "email.received" },
      {},
      [401],
    );
    expect(missingHeaders.body).toStrictEqual({
      error: "Missing signature headers",
    });

    const event = { type: "email.received" };
    const invalidSignature = await webhooks.requestResendInboundWebhook(
      event,
      {
        ...webhooks.signedResendWebhookHeaders(event),
        "svix-signature": "v1,bad-signature",
      },
      [401],
    );
    expect(invalidSignature.body).toStrictEqual({
      error: "Invalid signature",
    });
  });

  it("acknowledges unrelated signed Resend events without background work", async () => {
    const response = await postInbound({
      type: "email.sent",
      data: { email_id: "email_sent" },
    });

    expect(response.body).toStrictEqual({ received: true });
    await flushWaitUntilForTest();
    expect(resendMocks.send).not.toHaveBeenCalled();
  });
});
