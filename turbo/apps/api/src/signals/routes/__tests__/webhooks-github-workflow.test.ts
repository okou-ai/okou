import { createHmac, randomUUID } from "node:crypto";

import { webhookGithubContract } from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { setupRawAppRequest } from "../../../__tests__/test-helpers";
import { webhooksGithubRoutes } from "../webhooks-github";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();

describe("POST /api/webhooks/github for workflow automations", () => {
  it("webhooks-github-workflow-010 rejects a workflow job event signed with another secret", async () => {
    createWebhookCallbackApi(context).configureGithubWebhookSecret();
    const body = JSON.stringify({ action: "queued", workflow_job: null });
    const request = setupRawAppRequest({
      context,
      routes: webhooksGithubRoutes,
    });

    // The signature covers the exact raw bytes, which the typed client would
    // re-encode as a JSON string.
    const response = await request(webhookGithubContract.post.path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": `delivery-${randomUUID()}`,
        "x-github-event": "workflow_job",
        "x-hub-signature-256": `sha256=${createHmac("sha256", "another-secret")
          .update(body)
          .digest("hex")}`,
      },
      body,
    });

    expect(response.status).toBe(401);
    expect(response.body).toStrictEqual({ error: "Invalid signature" });
  });
});
