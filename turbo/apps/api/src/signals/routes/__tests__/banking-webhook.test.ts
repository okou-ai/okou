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
import { flushWaitUntilForTest } from "../../context/wait-until";
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
  const agentBody = {
    displayName: "Webhook Banking Agent",
    visibility: "private",
  } as const;
  const agent = await bdd.createAgent(actor, agentBody);
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
  return {
    client,
    agentId: agent.agentId,
    userId: actor.userId,
    accountsUrl,
    status,
    event,
  };
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
  it("notifies only the owner after connect, signed webhook updates, and grant changes", async () => {
    const fixture = await pendingConnect();
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();
    const expectNotification = async () => {
      await flushWaitUntilForTest();
      expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
        ["bankingAccessChanged", null],
      ]);
      expect(context.mocks.ably.channelGet.mock.calls).toStrictEqual([
        [`user:${fixture.userId}`],
      ]);
      context.mocks.ably.publish.mockClear();
      context.mocks.ably.channelGet.mockClear();
    };

    const session = await accept(
      fixture.client.createConnectSession({
        headers,
        body: { agentId: fixture.agentId, mode: "connect" },
      }),
      [200],
    );
    await expectNotification();
    expect((await fixture.status()).body.session).toMatchObject({
      id: session.body.sessionId,
      status: "pending",
    });

    const added = fixture.event("added", session.body.sessionId);
    expect((await postWebhook(added)).status).toBe(200);
    await expectNotification();
    const connected = await fixture.status();
    expect(connected.body.connection?.accounts).toHaveLength(1);
    const accountId = connected.body.connection?.accounts[0]?.id;
    if (!accountId) {
      throw new Error("Expected a publicly connected account");
    }
    const done = fixture.event("done", session.body.sessionId);
    expect((await postWebhook(done)).status).toBe(200);
    await expectNotification();
    expect((await fixture.status()).body.session?.status).toBe("completed");
    expect((await postWebhook(done)).status).toBe(200);
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    const grantBody = {
      agentId: fixture.agentId,
      accountIds: [accountId],
      duration: "7d" as const,
      purpose: "Review checking account",
    };
    const granted = await accept(
      fixture.client.saveAgentGrant({ headers, body: grantBody }),
      [200],
    );
    await expectNotification();
    expect(granted.body.grant?.status).toBe("active");
    const revoked = await accept(
      fixture.client.revokeAgentGrant({
        headers,
        body: { agentId: fixture.agentId },
      }),
      [200],
    );
    await expectNotification();
    expect(revoked.body.grant?.status).toBe("revoked");

    context.mocks.ably.publish.mockRejectedValue(new Error("Ably unavailable"));
    await accept(
      fixture.client.saveAgentGrant({ headers, body: grantBody }),
      [200],
    );
    await expectNotification();
    expect((await fixture.status()).body.grant?.status).toBe("active");
  });

  it.each(["unavailable", "invalid-response"] as const)(
    "notifies the owner after a connect session fails with %s",
    async (outcome) => {
      const fixture = await pendingConnect();
      await flushWaitUntilForTest();
      context.mocks.ably.publish.mockClear();
      context.mocks.ably.channelGet.mockClear();
      server.use(
        http.post(`${baseUrl}/connect/v2/generate`, () => {
          return outcome === "unavailable"
            ? HttpResponse.json({ message: "Unavailable" }, { status: 503 })
            : HttpResponse.json({});
        }),
      );
      await accept(
        fixture.client.createConnectSession({
          headers,
          body: { agentId: fixture.agentId, mode: "connect" },
        }),
        [502],
      );
      await flushWaitUntilForTest();
      expect((await fixture.status()).body.session?.status).toBe("failed");
      expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
        ["bankingAccessChanged", null],
        ["bankingAccessChanged", null],
      ]);
      expect(context.mocks.ably.channelGet.mock.calls).toStrictEqual([
        [`user:${fixture.userId}`],
        [`user:${fixture.userId}`],
      ]);
    },
  );

  it.each(["success", "failure"] as const)(
    "preserves a replacement while an older connect provider response ends in %s",
    async (outcome) => {
      const fixture = await pendingConnect();
      const requested = createDeferredPromise<string>(context.signal);
      const response = createDeferredPromise<void>(context.signal);
      let firstRequest = true;
      server.use(
        http.post(`${baseUrl}/connect/v2/generate`, async ({ request }) => {
          if (firstRequest) {
            firstRequest = false;
            const body = await request.json();
            const parsed = body as {
              webhookData: { uniqueRequestId: string };
            };
            requested.resolve(parsed.webhookData.uniqueRequestId);
            await response.promise;
            if (outcome === "failure") {
              return HttpResponse.json(
                { message: "Provider unavailable" },
                { status: 503 },
              );
            }
          }
          return HttpResponse.json({
            link: "https://connect.example.test/new",
          });
        }),
      );
      const start = () => {
        return fixture.client.createConnectSession({
          headers,
          body: { agentId: fixture.agentId, mode: "connect" },
        });
      };
      const older = start();
      onTestFinished(async () => {
        if (!response.settled()) {
          response.resolve();
        }
        await older;
      });
      const olderId = await requested.promise;
      const replacement = await accept(start(), [200]);
      expect(replacement.body.sessionId).not.toBe(olderId);
      expect((await fixture.status()).body.session).toMatchObject({
        id: replacement.body.sessionId,
        mode: "connect",
        status: "pending",
      });
      response.resolve();
      const finished = await older;
      if (outcome === "success") {
        expect(finished.status).toBe(200);
        if (finished.status === 200) {
          expect(finished.body.sessionId).toBe(olderId);
        }
      } else {
        expect(finished.status).toBe(502);
      }
      expect((await postWebhook(fixture.event("added", olderId))).status).toBe(
        200,
      );
      const current = await fixture.status();
      expect(current.body.session).toMatchObject({
        id: replacement.body.sessionId,
        status: "pending",
      });
      expect(current.body.connection?.accounts).toStrictEqual([]);
      expect(
        (await postWebhook(fixture.event("added", replacement.body.sessionId)))
          .status,
      ).toBe(200);
      expect(
        (await postWebhook(fixture.event("done", replacement.body.sessionId)))
          .status,
      ).toBe(200);
      expect((await fixture.status()).body.session).toMatchObject({
        id: replacement.body.sessionId,
        status: "completed",
      });
      const retry = await accept(start(), [200]);
      expect(retry.body.sessionId).not.toBe(replacement.body.sessionId);
      expect((await fixture.status()).body.session).toMatchObject({
        id: retry.body.sessionId,
        status: "pending",
      });
    },
  );

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

  it("updates account metadata, removes absent accounts and restores their identities", async () => {
    const fixture = await pendingConnect();
    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json({
          accounts: [account("bank", true), account("other")],
        });
      }),
    );
    expect((await postWebhook(fixture.event("added"))).status).toBe(200);
    const initial = await fixture.status();
    expect(initial.body.connection?.status).toBe("repair_required");
    const bank = initial.body.connection?.accounts.find((entry) => {
      return entry.institutionName === "bank";
    });
    const other = initial.body.connection?.accounts.find((entry) => {
      return entry.institutionName === "other";
    });
    if (!bank || !other) {
      throw new Error("Expected both provider accounts in public status");
    }
    expect(bank.repairRequired).toBeTruthy();

    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json({
          accounts: [{ ...account("other"), name: "Savings", type: "savings" }],
        });
      }),
    );
    expect((await postWebhook(fixture.event("added"))).status).toBe(200);
    const removed = await fixture.status();
    expect(removed.body.session?.status).toBe("pending");
    expect(removed.body.connection?.status).toBe("active");
    expect(removed.body.connection?.repairInstitutions).toStrictEqual([]);
    expect(removed.body.connection?.accounts).toStrictEqual([
      expect.objectContaining({
        id: other.id,
        name: "Savings",
        type: "savings",
        repairRequired: false,
      }),
    ]);

    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json({
          accounts: [
            { ...account("bank"), name: "Restored Checking" },
            { ...account("other"), name: "Savings", type: "savings" },
          ],
        });
      }),
    );
    expect((await postWebhook(fixture.event("done"))).status).toBe(200);
    const restored = await fixture.status();
    expect(restored.body.session?.status).toBe("completed");
    expect(restored.body.connection?.status).toBe("active");
    expect(restored.body.connection?.repairInstitutions).toStrictEqual([]);
    expect(restored.body.connection?.accounts).toHaveLength(2);
    expect(restored.body.connection?.accounts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: bank.id,
          name: "Restored Checking",
          repairRequired: false,
        }),
        expect.objectContaining({ id: other.id, name: "Savings" }),
      ]),
    );
  });

  it("clears an empty provider directory and restores the same account identity", async () => {
    const fixture = await pendingConnect();
    expect((await postWebhook(fixture.event("added"))).status).toBe(200);
    const initial = await fixture.status();
    const original = initial.body.connection?.accounts[0];
    if (!original) {
      throw new Error("Expected a publicly connected account");
    }
    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json({ accounts: [] });
      }),
    );
    expect((await postWebhook(fixture.event("added"))).status).toBe(200);
    const empty = await fixture.status();
    expect(empty.body.connection).toMatchObject({
      status: "active",
      accounts: [],
    });
    expect(empty.body.session?.status).toBe("pending");
    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json({ accounts: [account("bank")] });
      }),
    );
    expect((await postWebhook(fixture.event("added"))).status).toBe(200);
    expect((await fixture.status()).body.connection?.accounts).toStrictEqual([
      expect.objectContaining({ id: original.id, repairRequired: false }),
    ]);
  });

  it("uses the last duplicate account while retaining any provider repair requirement", async () => {
    const fixture = await pendingConnect();
    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json({
          accounts: [
            account("bank", true),
            { ...account("bank"), name: "Latest savings", type: "savings" },
          ],
        });
      }),
    );
    expect((await postWebhook(fixture.event("added"))).status).toBe(200);
    const status = await fixture.status();
    expect(status.body.connection?.status).toBe("repair_required");
    expect(status.body.connection?.accounts).toStrictEqual([
      expect.objectContaining({
        name: "Latest savings",
        type: "savings",
        repairRequired: false,
      }),
    ]);
  });

  it("rejects an invalid overwritten provider account without consuming the event", async () => {
    const fixture = await pendingConnect();
    expect((await postWebhook(fixture.event("added"))).status).toBe(200);
    const initial = await fixture.status();
    const added = fixture.event("added");
    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json({
          accounts: [
            account("other"),
            { ...account("bank", true), name: "x".repeat(257) },
            { ...account("bank"), name: "Latest checking" },
          ],
        });
      }),
    );
    expect((await postWebhook(added)).status).toBe(500);
    expect((await fixture.status()).body).toStrictEqual(initial.body);
    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json({
          accounts: [{ ...account("bank"), name: "Latest checking" }],
        });
      }),
    );
    expect((await postWebhook(added)).status).toBe(200);
    expect((await fixture.status()).body.connection?.accounts).toStrictEqual([
      expect.objectContaining({
        id: initial.body.connection?.accounts[0]?.id,
        name: "Latest checking",
        repairRequired: false,
      }),
    ]);
  });

  it("keeps a grant revoked when an already captured account refresh finishes", async () => {
    const fixture = await pendingConnect();
    expect((await postWebhook(fixture.event("added"))).status).toBe(200);
    const initial = await fixture.status();
    const accountId = initial.body.connection?.accounts[0]?.id;
    if (!accountId) {
      throw new Error("Expected a publicly connected account");
    }
    await accept(
      fixture.client.saveAgentGrant({
        headers,
        body: {
          agentId: fixture.agentId,
          accountIds: [accountId],
          duration: "7d",
          purpose: "Review checking account",
        },
      }),
      [200],
    );
    const requested = createDeferredPromise<void>(context.signal);
    const response = createDeferredPromise<void>(context.signal);
    server.use(
      http.get(fixture.accountsUrl, async () => {
        requested.resolve();
        await response.promise;
        return HttpResponse.json({
          accounts: [{ ...account("bank"), name: "Refreshed checking" }],
        });
      }),
    );
    const refresh = postWebhook(fixture.event("added"));
    onTestFinished(async () => {
      if (!response.settled()) {
        response.resolve();
      }
      await refresh;
    });
    await requested.promise;
    const revoked = await accept(
      fixture.client.revokeAgentGrant({
        headers,
        body: { agentId: fixture.agentId },
      }),
      [200],
    );
    expect(revoked.body.grant?.status).toBe("revoked");
    response.resolve();
    expect((await refresh).status).toBe(200);
    const refreshed = await fixture.status();
    expect(refreshed.body.grant).toStrictEqual(revoked.body.grant);
    expect(refreshed.body.connection?.accounts).toStrictEqual([
      expect.objectContaining({ id: accountId, name: "Refreshed checking" }),
    ]);
  });

  it("cancels connect when added and done return only unhealthy accounts", async () => {
    const fixture = await pendingConnect();
    server.use(
      http.get(fixture.accountsUrl, () => {
        return HttpResponse.json({ accounts: [account("bank", true)] });
      }),
    );
    expect((await postWebhook(fixture.event("added"))).status).toBe(200);
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();
    expect((await postWebhook(fixture.event("done"))).status).toBe(200);
    const cancelled = await fixture.status();
    expect(cancelled.body.session?.status).toBe("cancelled");
    expect(cancelled.body.connection?.accounts).toStrictEqual([
      expect.objectContaining({ repairRequired: true }),
    ]);
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
      ["bankingAccessChanged", null],
    ]);
    expect(context.mocks.ably.channelGet.mock.calls).toStrictEqual([
      [`user:${fixture.userId}`],
    ]);
  });

  it("allows retry after provider failure without consuming the event", async () => {
    const fixture = await pendingConnect();
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
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
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
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
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();
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
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
      ["bankingAccessChanged", null],
    ]);
    expect(context.mocks.ably.channelGet.mock.calls).toStrictEqual([
      [`user:${fixture.userId}`],
    ]);
  });

  it("rejects malformed signed events and ignores wrong customer correlation", async () => {
    const fixture = await pendingConnect();
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
