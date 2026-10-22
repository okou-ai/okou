import { createHmac, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { webhookOpenaiImagesContract } from "@okouai/api-contracts/contracts/webhooks";
import { http, HttpResponse } from "msw";

import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { webhooksOpenaiImagesRoutes } from "../webhooks-openai-images";

const context = testContext();
const secretBytes = Buffer.from("openai-webhook-route-test-secret");
const secret = `whsec_${secretBytes.toString("base64")}`;

function signedHeaders(rawBody: string, timestamp = nowDate()) {
  const id = `evt_${randomUUID()}`;
  const seconds = String(Math.floor(timestamp.getTime() / 1000));
  const signature = createHmac("sha256", secretBytes)
    .update(`${id}.${seconds}.${rawBody}`)
    .digest("base64");
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": seconds,
    "webhook-signature": `v1,${signature}`,
  };
}

function apiClient() {
  return setupApp({ context, routes: webhooksOpenaiImagesRoutes })(
    webhookOpenaiImagesContract,
  );
}

beforeEach(() => {
  mockEnv("OPENAI_IMAGE_WEBHOOK_SECRET", secret);
});

describe("POST /api/webhooks/openai/images", () => {
  it("rejects a body changed after signing", async () => {
    const body = JSON.stringify({
      id: `evt_${randomUUID()}`,
      type: "response.completed",
      data: { id: "resp_original" },
    });
    const response = await apiClient().post({
      extraHeaders: signedHeaders(body),
      body: body.replace("resp_original", "resp_tampered"),
    });
    expect(response.status).toBe(401);
  });

  it("rejects an expired correctly signed event", async () => {
    const body = JSON.stringify({
      id: `evt_${randomUUID()}`,
      type: "response.completed",
      data: { id: `resp_${randomUUID()}` },
    });
    const response = await apiClient().post({
      extraHeaders: signedHeaders(body, new Date(now() - 10 * 60 * 1000)),
      body,
    });
    expect(response.status).toBe(401);
  });

  it.each([
    "response.completed",
    "response.failed",
    "response.incomplete",
    "response.cancelled",
  ])("accepts duplicate %s receipts without provider I/O", async (type) => {
    let providerRequests = 0;
    server.use(
      http.all("https://api.openai.com/*", () => {
        providerRequests++;
        return HttpResponse.json({ error: "Receipt ingestion must not fetch" });
      }),
    );
    const body = JSON.stringify({
      id: `evt_${randomUUID()}`,
      type,
      data: { id: `resp_${randomUUID()}` },
    });
    const headers = signedHeaders(body);
    const client = apiClient();
    const first = await client.post({ extraHeaders: headers, body });
    expect(first.status).toBe(200);
    expect(first.body).toBe("OK");
    const duplicate = await client.post({ extraHeaders: headers, body });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toBe("OK");
    expect(providerRequests).toBe(0);
  });
});
