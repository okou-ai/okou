import { randomBytes, randomUUID } from "node:crypto";
import { emailInboundContract } from "@okouai/api-contracts/contracts/email";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { emailInboundRoutes } from "../email-inbound";

const context = testContext();

function inboundEmailClient() {
  return setupApp({ context, routes: emailInboundRoutes })(
    emailInboundContract,
  );
}

function resendInboundEvent(): Record<string, unknown> {
  return {
    type: "email.received",
    created_at: new Date(now()).toISOString(),
    data: {
      email_id: randomUUID(),
      from: "Sender <sender@example.test>",
      to: [`inbox-${randomUUID()}@inbound.example.test`],
      subject: "Hello",
    },
  };
}

describe("POST /api/email/inbound", () => {
  it("email-001 rejects inbound email events with missing or invalid Svix signatures", async () => {
    const client = inboundEmailClient();

    const missing = await accept(
      client.post({ headers: {}, body: resendInboundEvent() }),
      [401],
    );
    expect(missing.body).toStrictEqual({
      error: "Missing signature headers",
    });

    const invalid = await accept(
      client.post({
        headers: {
          "svix-id": `msg_${randomUUID()}`,
          "svix-timestamp": String(Math.floor(now() / 1000)),
          "svix-signature": `v1,${randomBytes(32).toString("base64")}`,
        },
        body: resendInboundEvent(),
      }),
      [401],
    );
    expect(invalid.body).toStrictEqual({ error: "Invalid signature" });
  });
});
