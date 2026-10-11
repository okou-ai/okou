import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { bankingUserContract } from "@okouai/api-contracts/contracts/banking";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { createBddApi } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { bankingRoutes } from "../banking";

const context = testContext();
const secret = randomBytes(32).toString("hex");
const baseUrl = "https://api.finicity.com";
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function account(institutionLoginId: string, repairRequired = false) {
  return {
    id: `account-${institutionLoginId}`,
    name: "Checking",
    institutionName: institutionLoginId,
    institutionLoginId,
    type: "checking",
    status: repairRequired ? "error" : "active",
    aggregationStatusCode: repairRequired ? 103 : 0,
  };
}

async function pendingConnect() {
  const bdd = createBddApi(context);
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Banking requires an organization");
  }
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Webhook Banking Agent",
    visibility: "private",
  });
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId },
    { [FeatureSwitchKey.Banking]: true },
  );
  const customerId = `customer-${randomUUID()}`;
  const accountsUrl = `${baseUrl}/aggregation/v1/customers/${customerId}/accounts`;
  server.use(
    http.post(`${baseUrl}/aggregation/v2/partners/authentication`, () => {
      return HttpResponse.json({ token: "test-app-token" });
    }),
    http.post(`${baseUrl}/aggregation/v2/customers/testing`, () => {
      return HttpResponse.json({ id: customerId });
    }),
    http.post(`${baseUrl}/connect/v2/generate`, () => {
      return HttpResponse.json({
        link: "https://connect.example.test/session",
      });
    }),
    http.post(`${baseUrl}/connect/v2/generate/fix`, () => {
      return HttpResponse.json({ link: "https://connect.example.test/fix" });
    }),
    http.get(accountsUrl, () => {
      return HttpResponse.json({ accounts: [account("bank")] });
    }),
  );
  const client = setupApp({ context, routes: bankingRoutes })(
    bankingUserContract,
  );
  const started = await accept(
    client.createConnectSession({
      headers,
      body: { agentId: agent.agentId, mode: "connect" },
    }),
    [200],
  );
  const status = async () => {
    return await accept(
      client.accessRequestStatus({
        headers,
        params: { agentId: agent.agentId },
      }),
      [200],
    );
  };
  const initial = await status();
  const connectionId = initial.body.connection?.id;
  if (!connectionId) {
    throw new Error(
      "Expected the public connect status to return a connection",
    );
  }
  const event = (eventType: string, sessionId = started.body.sessionId) => {
    return {
      eventId: `event-${randomUUID()}`,
      eventType,
      customerId,
      webhookData: {
        uniqueCustomerId: connectionId,
        uniqueRequestId: sessionId,
      },
    };
  };
  return { client, agentId: agent.agentId, accountsUrl, status, event };
}

async function postWebhook(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
  return await createApp({
    signal: context.signal,
    routes: bankingRoutes,
  }).request("/api/webhooks/finicity", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-finicity-signature": signature,
    },
    body: rawBody,
  });
}

beforeEach(() => {
  mockEnv("FINICITY_APP_KEY", "test-app-key");
  mockEnv("FINICITY_APP_SECRET", secret);
  mockEnv("FINICITY_PARTNER_ID", "test-partner");
});

describe("Finicity webhook outcomes", () => {
  it("keeps unknown events pending and preserves added/done results on replay", async () => {
    const fixture = await pendingConnect();
    const unknown = fixture.event("institutionSelected");
    expect((await postWebhook(unknown)).status).toBe(200);
    expect((await postWebhook(unknown)).status).toBe(200);
    const untouched = await fixture.status();
    expect(untouched.body.session?.status).toBe("pending");
    expect(untouched.body.connection?.accounts).toStrictEqual([]);

    const added = { ...fixture.event("added"), eventTimestamp: 1_767_225_600 };
    expect((await postWebhook(added)).status).toBe(200);
    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json({ accounts: [account("bank", true)] });
      }),
    );
    expect((await postWebhook(added)).status).toBe(200);
    const replayed = await fixture.status();
    expect(replayed.body.session?.status).toBe("pending");
    expect(replayed.body.connection?.accounts).toStrictEqual([
      expect.objectContaining({ repairRequired: false }),
    ]);

    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json({ accounts: [account("bank")] });
      }),
    );
    const done = {
      ...fixture.event("done"),
      reason: "userSubmit".repeat(10),
      eventTimestamp: "2026-01-01T00:00:00Z",
    };
    expect((await postWebhook(done)).status).toBe(200);
    expect((await fixture.status()).body.session?.status).toBe("completed");
    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json({ accounts: [] });
      }),
    );
    expect((await postWebhook(done)).status).toBe(200);
    const completed = await fixture.status();
    expect(completed.body.session?.status).toBe("completed");
    expect(completed.body.connection?.accounts).toHaveLength(1);
  });

  it("cancels connect when added and done return only unhealthy accounts", async () => {
    const fixture = await pendingConnect();
    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json({ accounts: [account("bank", true)] });
      }),
    );
    expect((await postWebhook(fixture.event("added"))).status).toBe(200);
    expect((await postWebhook(fixture.event("done"))).status).toBe(200);
    const cancelled = await fixture.status();
    expect(cancelled.body.session?.status).toBe("cancelled");
    expect(cancelled.body.connection?.accounts).toStrictEqual([
      expect.objectContaining({ repairRequired: true }),
    ]);
  });

  it("allows retry after provider failure without consuming the event", async () => {
    const fixture = await pendingConnect();
    const added = fixture.event("added");
    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json(
          { message: "Provider unavailable" },
          { status: 503 },
        );
      }),
    );
    expect((await postWebhook(added)).status).toBe(500);
    const failed = await fixture.status();
    expect(failed.body.session?.status).toBe("pending");
    expect(failed.body.connection?.accounts).toStrictEqual([]);
    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json({ accounts: [account("bank")] });
      }),
    );
    expect((await postWebhook(added)).status).toBe(200);
    expect((await postWebhook(fixture.event("done"))).status).toBe(200);
    expect((await fixture.status()).body.session?.status).toBe("completed");
  });

  it("completes a done request captured before added when its provider response arrives later", async () => {
    const fixture = await pendingConnect();
    const requested = createDeferredPromise<void>(context.signal);
    const response = createDeferredPromise<void>(context.signal);
    let firstRequest = true;
    server.use(
      http.get(fixture.accountsUrl, async () => {
        if (firstRequest) {
          firstRequest = false;
          requested.resolve();
          await response.promise;
        }
        return HttpResponse.json({ accounts: [account("bank")] });
      }),
    );
    const done = postWebhook(fixture.event("done"));
    onTestFinished(async () => {
      if (!response.settled()) {
        response.resolve();
      }
      await done;
    });
    await requested.promise;
    expect((await postWebhook(fixture.event("added"))).status).toBe(200);
    expect((await fixture.status()).body.session?.status).toBe("pending");
    response.resolve();
    expect((await done).status).toBe(200);
    expect((await fixture.status()).body.session?.status).toBe("completed");
  });

  it("does not revive a session when a captured added request arrives after done-only cancellation", async () => {
    const fixture = await pendingConnect();
    const requested = createDeferredPromise<void>(context.signal);
    const response = createDeferredPromise<void>(context.signal);
    let firstRequest = true;
    server.use(
      http.get(fixture.accountsUrl, async () => {
        if (firstRequest) {
          firstRequest = false;
          requested.resolve();
          await response.promise;
        }
        return HttpResponse.json({ accounts: [account("bank")] });
      }),
    );
    const addedEvent = fixture.event("added");
    const added = postWebhook(addedEvent);
    onTestFinished(async () => {
      if (!response.settled()) {
        response.resolve();
      }
      await added;
    });
    await requested.promise;
    expect((await postWebhook(fixture.event("done"))).status).toBe(200);
    expect((await fixture.status()).body.session?.status).toBe("cancelled");
    response.resolve();
    expect((await added).status).toBe(200);
    expect((await postWebhook(addedEvent)).status).toBe(200);
    expect((await fixture.status()).body.session?.status).toBe("cancelled");
  });

  it("keeps concurrent duplicate added callbacks pending until done", async () => {
    const fixture = await pendingConnect();
    const added = fixture.event("added");
    const responses = await Promise.all([
      postWebhook(added),
      postWebhook(added),
    ]);
    expect(
      responses.map((response) => {
        return response.status;
      }),
    ).toStrictEqual([200, 200]);
    const pending = await fixture.status();
    expect(pending.body.session?.status).toBe("pending");
    expect(pending.body.connection?.accounts).toHaveLength(1);
    expect((await postWebhook(fixture.event("done"))).status).toBe(200);
    expect((await fixture.status()).body.session?.status).toBe("completed");
  });

  it("completes fix only for a healthy account at its requested institution without requiring added", async () => {
    const fixture = await pendingConnect();
    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json({
          accounts: [account("bank", true), account("other")],
        });
      }),
    );
    expect((await postWebhook(fixture.event("added"))).status).toBe(200);
    expect((await postWebhook(fixture.event("done"))).status).toBe(200);
    const repair = await fixture.status();
    expect(repair.body.connection?.repairInstitutions).toStrictEqual([
      { institutionLoginId: "bank", institutionName: "bank" },
    ]);
    const startFix = async () => {
      return await accept(
        fixture.client.createConnectSession({
          headers,
          body: {
            agentId: fixture.agentId,
            mode: "fix",
            institutionLoginId: "bank",
          },
        }),
        [200],
      );
    };
    const cancelled = await startFix();
    expect(
      (await postWebhook(fixture.event("done", cancelled.body.sessionId)))
        .status,
    ).toBe(200);
    expect((await fixture.status()).body.session).toMatchObject({
      mode: "fix",
      status: "cancelled",
    });

    const repaired = await startFix();
    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json({
          accounts: [account("bank"), account("other")],
        });
      }),
    );
    expect(
      (await postWebhook(fixture.event("done", repaired.body.sessionId)))
        .status,
    ).toBe(200);
    const completed = await fixture.status();
    expect(completed.body.session).toMatchObject({
      id: repaired.body.sessionId,
      mode: "fix",
      status: "completed",
    });
    expect(completed.body.connection?.repairInstitutions).toStrictEqual([]);
  });

  it("rejects malformed signed events and ignores wrong customer correlation", async () => {
    const fixture = await pendingConnect();
    expect((await postWebhook({ eventType: "added" })).status).toBe(400);
    expect(
      (
        await postWebhook({
          ...fixture.event("added"),
          customerId: "another-customer",
        })
      ).status,
    ).toBe(200);
    const unchanged = await fixture.status();
    expect(unchanged.body.session?.status).toBe("pending");
    expect(unchanged.body.connection?.accounts).toStrictEqual([]);
  });
});
