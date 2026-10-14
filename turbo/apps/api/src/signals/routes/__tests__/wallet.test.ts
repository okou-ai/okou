import { createHash, randomUUID } from "node:crypto";
import {
  walletCallbackContract,
  walletContract,
  walletUserContract,
  type WalletCreateSpend,
} from "@okouai/api-contracts/contracts/wallet";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeEach, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { walletRoutes } from "../wallet";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { channelsPublishedTo } from "./helpers/realtime-publications";

const context = testContext();
const mocks = createRouteMocks(context);
const sessionHeaders = Object.freeze({ authorization: "Bearer clerk-session" });
const client = () => {
  return setupApp({ context, routes: walletRoutes })(walletContract);
};
const userClient = () => {
  return setupApp({ context, routes: walletRoutes })(walletUserContract);
};
const callbackClient = () => {
  return setupApp({
    context,
    routes: [...walletRoutes, ...builtinConnectorsSlugCallbackRoutes],
  })(walletCallbackContract);
};

beforeEach(() => {
  mockEnv("LINK_OAUTH_CLIENT_ID", "wallet-client-fixture");
  mockEnv("LINK_OAUTH_CLIENT_SECRET", "wallet-secret-fixture");
  mockEnv("LINK_STRIPE_PUBLISHABLE_KEY", "pk_live_wallet_fixture");
});

async function carrier(
  enabled = true,
  existingActor?: ApiTestUser,
  unattended = false,
) {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = existingActor ?? bdd.user();
  if (!actor.orgId) {
    throw new Error("Wallet carrier needs an organization");
  }
  mocks.clerk.session(actor.userId, actor.orgId);
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor, { tier: unattended ? "team" : "pro" });
  await api.ensurePersonalSubscriptionModel(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Wallet agent",
    visibility: "private",
  });
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId },
    { [FeatureSwitchKey.LinkWallet]: enabled },
  );
  const run = unattended
    ? await createWorkflowsBddApi(context).startEventAutomationRun(
        actor,
        agent.agentId,
      )
    : await api.createThreadRun(actor, {
        agentId: agent.agentId,
        prompt: "Prepare a test Link purchase approval",
      });
  await api.heartbeatRunner(runnerGroup);
  const claim = await api.claimRunnerJob(run.runId);
  const token = claim.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("Missing claimed run token");
  }
  onTestFinished(async () => {
    await api.requestCancelRun(actor, run.runId, [200]);
    await createWebhookCallbackApi(context).requestAgentComplete(
      { runId: run.runId, exitCode: 1, error: "Wallet test carrier canceled" },
      { authorization: `Bearer ${claim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
  });
  return {
    actor: { ...actor, orgId: actor.orgId },
    agentId: agent.agentId,
    prompt: claim.appendSystemPrompt ?? "",
    environmentNames: Object.keys(claim.platformEnvironment),
    headers: { authorization: `Bearer ${token}` },
  };
}

function tokenHandler(options: { scope?: string; expiresIn?: number } = {}) {
  return http.post("https://login.link.com/auth/token", () => {
    return HttpResponse.json({
      access_token: "wallet-access-fixture",
      refresh_token: "wallet-refresh-fixture",
      token_type: "Bearer",
      expires_in: options.expiresIn ?? 3600,
      scope: options.scope ?? "payment_methods.agentic",
    });
  });
}

async function connect(fixture: Awaited<ReturnType<typeof carrier>>) {
  mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);
  const request = await accept(
    client().connect({ headers: fixture.headers, body: {} }),
    [200],
  );
  const url = new URL(request.body.url);
  const state = url.searchParams.get("state");
  if (!state) {
    throw new Error("Missing OAuth state");
  }
  await accept(
    callbackClient().callback({
      headers: sessionHeaders,
      query: { state, code: "wallet-code-fixture", responseMode: "json" },
    }),
    [200],
  );
  return { state, url };
}
function purchase(): WalletCreateSpend {
  return {
    intentId: randomUUID(),
    amount: 3500,
    currency: "usd",
    merchantName: "Example Books",
    merchantUrl: "https://books.example.test",
    context:
      "Preparing the customer's explicitly requested purchase of one paperback book from Example Books, including the final shipping and tax total.",
    test: true,
  };
}
function spendProvider(input: WalletCreateSpend) {
  const id = `lsrq_${randomUUID()}`;
  let status:
    | "pending_approval"
    | "approved"
    | "denied"
    | "expired"
    | "canceled"
    | "submitted"
    | "succeeded" = "pending_approval";
  let amount = input.amount;
  let payload: Record<string, unknown> = {};
  const wire = () => {
    return {
      id,
      status,
      amount,
      currency: input.currency,
      merchant_name: input.merchantName,
      merchant_url: input.merchantUrl,
      approval_url: `https://app.link.com/activity/approve/${id}`,
      ...payload,
    };
  };
  server.use(
    http.post("https://api.link.com/spend_requests", () => {
      return HttpResponse.json(wire());
    }),
    http.get(`https://api.link.com/spend_requests/${id}`, ({ request }) => {
      expect(new URL(request.url).searchParams.has("include")).toBeFalsy();
      return HttpResponse.json(wire());
    }),
    http.post(`https://api.link.com/spend_requests/${id}/cancel`, () => {
      status = "canceled";
      return HttpResponse.json(wire());
    }),
  );
  return {
    approve: () => {
      status = "approved";
    },
    status: (value: typeof status) => {
      status = value;
    },
    changeAmount: () => {
      amount += 100;
    },
    payload: (value: Record<string, unknown>) => {
      payload = value;
    },
  };
}

test("is unavailable with a flag-off token and rejects a previously issued token after disabling the switch", async () => {
  const off = await carrier(false);
  expect(off.prompt).not.toContain("okou wallet");
  expect(
    off.environmentNames.filter((name) => {
      return name.startsWith("LINK_");
    }),
  ).toStrictEqual([]);
  await accept(client().status({ headers: off.headers }), [403]);
  await accept(
    userClient().connectStatus({
      headers: sessionHeaders,
      body: { agentId: off.agentId, state: "unknown-wallet-state".repeat(3) },
    }),
    [403],
  );
  const active = await carrier();
  expect(active.prompt).toContain("okou wallet guide");
  expect(active.prompt).toContain(
    "Account consent is not purchase approval; approved is not paid",
  );
  expect(
    active.environmentNames.filter((name) => {
      return name.startsWith("LINK_");
    }),
  ).toStrictEqual([]);
  await updateFeatureSwitchesForUser(
    context,
    { userId: active.actor.userId, orgId: active.actor.orgId },
    { [FeatureSwitchKey.LinkWallet]: false },
  );
  await accept(client().connect({ headers: active.headers, body: {} }), [403]);
});

test("accepts hosted PKCE consent after 20 minutes, binds the callback to the session owner, and consumes state once", async () => {
  const fixture = await carrier();
  let verifierMatches = false;
  const started = await accept(
    client().connect({ headers: fixture.headers, body: {} }),
    [200],
  );
  const url = new URL(started.body.url);
  expect(url.origin).toBe("https://login.link.com");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("redirect_uri")).toMatch(
    /\/connectors\/link\/callback$/,
  );
  expect(url.searchParams.get("scope")).toBe(
    "payment_methods.agentic userinfo:read",
  );
  expect(started.body.url).not.toContain("wallet-secret-fixture");
  const state = url.searchParams.get("state") ?? "";
  const statusRequest = {
    headers: sessionHeaders,
    body: { agentId: fixture.agentId, state },
  };
  expect(
    (await accept(userClient().connectStatus(statusRequest), [200])).body,
  ).toStrictEqual({ status: "pending" });
  expect(
    (
      await accept(
        userClient().connectStatus({
          ...statusRequest,
          body: { ...statusRequest.body, agentId: randomUUID() },
        }),
        [200],
      )
    ).body,
  ).toStrictEqual({ status: "unavailable" });
  await accept(
    userClient().connectStatus({
      ...statusRequest,
      headers: fixture.headers,
    }),
    [403],
  );
  server.use(
    http.post("https://login.link.com/auth/token", async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      verifierMatches =
        createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url") === url.searchParams.get("code_challenge");
      return HttpResponse.json({
        access_token: "wallet-access-fixture",
        refresh_token: "wallet-refresh-fixture",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "payment_methods.agentic userinfo:read",
      });
    }),
  );
  const other = createBddApi(context).user();
  if (!other.orgId) {
    throw new Error("Missing peer organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { userId: other.userId, orgId: other.orgId },
    { [FeatureSwitchKey.LinkWallet]: true },
  );
  expect(
    (await accept(userClient().connectStatus(statusRequest), [200])).body,
  ).toStrictEqual({ status: "unavailable" });
  await accept(
    callbackClient().callback({
      headers: sessionHeaders,
      query: { state, code: "wallet-code-fixture" },
    }),
    [400],
  );
  await flushWaitUntilForTest();
  expect(channelsPublishedTo(context.mocks, "wallet:changed")).toStrictEqual(
    [],
  );
  mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);
  mockNow(now() + 20 * 60_000);
  const callback = await accept(
    callbackClient().callback({
      headers: sessionHeaders,
      query: { state, code: "wallet-code-fixture" },
    }),
    [200],
  );
  expect(callback.body).toStrictEqual({ status: "success", username: null });
  expect(verifierMatches).toBeTruthy();
  await flushWaitUntilForTest();
  expect(channelsPublishedTo(context.mocks, "wallet:changed")).toStrictEqual([
    `user:${fixture.actor.userId}`,
  ]);
  expect(context.mocks.ably.publish).toHaveBeenCalledWith("wallet:changed", {
    agentId: fixture.agentId,
  });
  const authorized = await accept(
    userClient().connectStatus(statusRequest),
    [200],
  );
  expect(authorized.body).toStrictEqual({
    status: "authorized",
    authorizationId: expect.any(String),
  });
  expect(
    (await accept(userClient().connectStatus(statusRequest), [200])).body,
  ).toStrictEqual(authorized.body);
  await accept(
    callbackClient().callback({
      headers: sessionHeaders,
      query: { state, code: "wallet-code-fixture" },
    }),
    [400],
  );
  const status = await accept(
    client().status({ headers: fixture.headers }),
    [200],
  );
  expect(status.body).toStrictEqual({
    connected: true,
    nextAction: "create_spend",
    checkoutAvailable: false,
  });
});

test("denies declined and expired OAuth requests and missing payment scopes", async () => {
  const fixture = await carrier();
  server.use(tokenHandler({ scope: "userinfo:read" }));
  const started = await accept(
    client().connect({ headers: fixture.headers, body: {} }),
    [200],
  );
  const state = new URL(started.body.url).searchParams.get("state") ?? "";
  await accept(
    callbackClient().callback({
      headers: sessionHeaders,
      query: { state, code: "wallet-code-fixture" },
    }),
    [403],
  );
  expect(
    (
      await accept(
        userClient().connectStatus({
          headers: sessionHeaders,
          body: { agentId: fixture.agentId, state },
        }),
        [200],
      )
    ).body,
  ).toStrictEqual({ status: "failed" });
  await flushWaitUntilForTest();
  expect(channelsPublishedTo(context.mocks, "wallet:changed")).toStrictEqual([
    `user:${fixture.actor.userId}`,
  ]);
  const declined = await accept(
    client().connect({ headers: fixture.headers, body: {} }),
    [200],
  );
  const declinedState =
    new URL(declined.body.url).searchParams.get("state") ?? "";
  const denial = await accept(
    callbackClient().callback({
      headers: sessionHeaders,
      query: { state: declinedState, error: "access_denied" },
    }),
    [200],
  );
  expect(denial.body.status).toBe("error");
  await flushWaitUntilForTest();
  expect(channelsPublishedTo(context.mocks, "wallet:changed")).toStrictEqual([
    `user:${fixture.actor.userId}`,
    `user:${fixture.actor.userId}`,
  ]);
  expect(
    (
      await accept(
        userClient().connectStatus({
          headers: sessionHeaders,
          body: { agentId: fixture.agentId, state: declinedState },
        }),
        [200],
      )
    ).body,
  ).toStrictEqual({ status: "failed" });
  const expired = await accept(
    client().connect({ headers: fixture.headers, body: {} }),
    [200],
  );
  mockNow(new Date(expired.body.expiresAt).getTime());
  expect(
    (
      await accept(
        userClient().connectStatus({
          headers: sessionHeaders,
          body: {
            agentId: fixture.agentId,
            state: new URL(expired.body.url).searchParams.get("state") ?? "",
          },
        }),
        [200],
      )
    ).body,
  ).toStrictEqual({ status: "expired" });
  await accept(
    callbackClient().callback({
      headers: sessionHeaders,
      query: {
        state: new URL(expired.body.url).searchParams.get("state") ?? "",
        code: "wallet-code-fixture",
      },
    }),
    [400],
  );
});

test("tracks the exact wallet consent instead of an older grant, including replacement and revocation", async () => {
  const fixture = await carrier();
  server.use(
    tokenHandler(),
    http.post("https://login.link.com/auth/revoke", () => {
      return HttpResponse.json({});
    }),
  );
  const first = await connect(fixture);
  const readStatus = async (state: string) => {
    return (
      await accept(
        userClient().connectStatus({
          headers: sessionHeaders,
          body: { agentId: fixture.agentId, state },
        }),
        [200],
      )
    ).body;
  };
  await expect(readStatus(first.state)).resolves.toStrictEqual({
    status: "authorized",
    authorizationId: expect.any(String),
  });
  const second = await accept(
    client().connect({ headers: fixture.headers, body: {} }),
    [200],
  );
  const secondState = new URL(second.body.url).searchParams.get("state") ?? "";
  await expect(readStatus(secondState)).resolves.toStrictEqual({
    status: "pending",
  });
  await accept(
    callbackClient().callback({
      headers: sessionHeaders,
      query: { state: secondState, code: "new-wallet-code" },
    }),
    [200],
  );
  await expect(readStatus(first.state)).resolves.toStrictEqual({
    status: "unavailable",
  });
  await expect(readStatus(secondState)).resolves.toStrictEqual({
    status: "authorized",
    authorizationId: expect.any(String),
  });
  await accept(
    client().disconnect({ headers: fixture.headers, body: {} }),
    [200],
  );
  await expect(readStatus(secondState)).resolves.toStrictEqual({
    status: "unavailable",
  });
  await flushWaitUntilForTest();
  expect(channelsPublishedTo(context.mocks, "wallet:changed")).toStrictEqual([
    `user:${fixture.actor.userId}`,
    `user:${fixture.actor.userId}`,
    `user:${fixture.actor.userId}`,
  ]);
});

test("deduplicates immutable intent details, returns the exact approval URL, and never exposes credentials", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  const input = purchase();
  const provider = spendProvider(input);
  provider.payload({
    card: { number: "fixture-pan", cvc: "fixture-cvc" },
    access_token: "fixture-token",
    shared_payment_token: "fixture-spt",
  });
  const created = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  expect(created.body.status).toBe("pending_approval");
  expect(created.body.approvalUrl).toMatch(
    /^https:\/\/app\.link\.com\/activity\/approve\//,
  );
  const repeated = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  expect(repeated.body.id).toBe(created.body.id);
  await accept(
    client().createSpend({
      headers: fixture.headers,
      body: { ...input, amount: input.amount + 1 },
    }),
    [409],
  );
  await accept(
    client().createSpend({
      headers: fixture.headers,
      body: { ...input, merchantUrl: "https://other.example.test" },
    }),
    [409],
  );
  expect(JSON.stringify(repeated.body)).not.toMatch(
    /fixture-pan|fixture-cvc|fixture-token|fixture-spt|wallet-access-fixture/,
  );
  provider.approve();
  const approved = await accept(
    client().getSpend({
      headers: fixture.headers,
      params: { id: created.body.id },
    }),
    [200],
  );
  const raw = setupRawAppRequest({ context, routes: walletRoutes });
  expect(
    (
      await raw(`/api/wallet/spend/${created.body.id}?include=card`, {
        method: "GET",
        headers: fixture.headers,
      })
    ).status,
  ).toBe(400);
  expect(approved.body.nextAction).toBe("secure_checkout_unavailable");
  expect(approved.body.approvalUrl).toBeNull();
  provider.changeAmount();
  await accept(
    client().getSpend({
      headers: fixture.headers,
      params: { id: created.body.id },
    }),
    [409],
  );
});

test("keeps ownership scoped to the user, organization and agent", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  const input = purchase();
  spendProvider(input);
  const created = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  const peer = await carrier();
  await accept(
    client().getSpend({
      headers: peer.headers,
      params: { id: created.body.id },
    }),
    [404],
  );
  await accept(
    client().cancelSpend({
      headers: peer.headers,
      params: { id: created.body.id },
      body: {},
    }),
    [404],
  );
  const status = await accept(
    client().status({ headers: peer.headers }),
    [200],
  );
  expect(status.body.connected).toBeFalsy();
});

test.each(["denied", "expired", "submitted", "succeeded"] as const)(
  "reports %s without treating it as approval or retrying a payment",
  async (state) => {
    const fixture = await carrier();
    server.use(tokenHandler());
    await connect(fixture);
    const input = purchase();
    const provider = spendProvider(input);
    const created = await accept(
      client().createSpend({ headers: fixture.headers, body: input }),
      [200],
    );
    provider.status(state);
    const result = await accept(
      client().getSpend({
        headers: fixture.headers,
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(result.body.nextAction).toBe(
      state === "submitted"
        ? "payment_pending"
        : state === "succeeded"
          ? "verify_order"
          : "stop",
    );
    await accept(
      client().cancelSpend({
        headers: fixture.headers,
        params: { id: created.body.id },
        body: {},
      }),
      [409],
    );
  },
);

test("cancels unused requests and disables locally before a failed revocation, allowing explicit revocation retry", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  const input = purchase();
  spendProvider(input);
  const created = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  const canceled = await accept(
    client().cancelSpend({
      headers: fixture.headers,
      params: { id: created.body.id },
      body: {},
    }),
    [200],
  );
  expect(canceled.body.status).toBe("canceled");
  server.use(
    http.post("https://login.link.com/auth/revoke", () => {
      return HttpResponse.json({}, { status: 503 });
    }),
  );
  await accept(
    client().disconnect({ headers: fixture.headers, body: {} }),
    [502],
  );
  expect(
    (await accept(client().status({ headers: fixture.headers }), [200])).body
      .connected,
  ).toBeFalsy();
  await accept(
    client().createSpend({ headers: fixture.headers, body: purchase() }),
    [409],
  );
  server.use(
    http.post("https://login.link.com/auth/revoke", () => {
      return new HttpResponse(null, { status: 200 });
    }),
  );
  await accept(
    client().disconnect({ headers: fixture.headers, body: {} }),
    [200],
  );
});

test("refreshes rotating credentials only on the backend and isolates requests from a replaced authorization", async () => {
  const fixture = await carrier();
  server.use(tokenHandler({ expiresIn: 30 }));
  await connect(fixture);
  server.use(tokenHandler());
  const input = purchase();
  spendProvider(input);
  const created = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  await connect(fixture);
  const oldAuthorization = await accept(
    client().getSpend({
      headers: fixture.headers,
      params: { id: created.body.id },
    }),
    [409],
  );
  expect(oldAuthorization.body.error.code).toBe("WALLET_AUTHORIZATION_CHANGED");
});

test("prevents an in-flight OAuth callback from resurrecting a disconnected grant", async () => {
  const fixture = await carrier();
  const started = await accept(
    client().connect({ headers: fixture.headers, body: {} }),
    [200],
  );
  const tokenStarted = createDeferredPromise<void>(context.signal);
  const finishToken = createDeferredPromise<void>(context.signal);
  onTestFinished(() => {
    if (!finishToken.settled()) {
      finishToken.resolve();
    }
  });
  server.use(
    http.post("https://login.link.com/auth/revoke", () => {
      return new HttpResponse(null, { status: 200 });
    }),
  );
  server.use(
    http.post("https://login.link.com/auth/token", async () => {
      tokenStarted.resolve();
      await finishToken.promise;
      return HttpResponse.json({
        access_token: "wallet-access-fixture",
        refresh_token: "wallet-refresh-fixture",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "payment_methods.agentic",
      });
    }),
  );
  const callback = callbackClient().callback({
    headers: sessionHeaders,
    query: {
      state: new URL(started.body.url).searchParams.get("state") ?? "",
      code: "wallet-code-fixture",
    },
  });
  await tokenStarted.promise;
  await accept(
    client().disconnect({ headers: fixture.headers, body: {} }),
    [200],
  );
  finishToken.resolve();
  await accept(callback, [409]);
  expect(
    (await accept(client().status({ headers: fixture.headers }), [200])).body
      .connected,
  ).toBeFalsy();
});

test("does not share a wallet grant with another agent of the same user", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  const input = purchase();
  spendProvider(input);
  const created = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  const otherAgent = await carrier(true, fixture.actor);
  expect(
    (await accept(client().status({ headers: otherAgent.headers }), [200])).body
      .connected,
  ).toBeFalsy();
  await accept(
    client().getSpend({
      headers: otherAgent.headers,
      params: { id: created.body.id },
    }),
    [404],
  );
});

test("denies unattended automation runs even when the user's switch is enabled", async () => {
  const fixture = await carrier(true, undefined, true);
  const denied = await accept(
    client().status({ headers: fixture.headers }),
    [403],
  );
  expect(denied.body.error.code).toBe("WALLET_INTERACTIVE_RUN_REQUIRED");
  await accept(client().connect({ headers: fixture.headers, body: {} }), [403]);
  await accept(
    client().createSpend({ headers: fixture.headers, body: purchase() }),
    [403],
  );
});

test("recovers a lost creation response with the same provider idempotency key and the same intent", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  const input = purchase();
  const providerId = `lsrq_${randomUUID()}`;
  const keys: unknown[] = [];
  const wire = {
    id: providerId,
    status: "pending_approval",
    amount: input.amount,
    currency: input.currency,
    merchant_name: input.merchantName,
    merchant_url: input.merchantUrl,
    approval_url: `https://app.link.com/activity/approve/${providerId}`,
  };
  server.use(
    http.post("https://api.link.com/spend_requests", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      keys.push(body.idempotency_key);
      expect(body.request_approval).toBeTruthy();
      return keys.length === 1
        ? HttpResponse.error()
        : HttpResponse.json(
            { error: { duplicate_spend_request: wire } },
            { status: 409 },
          );
    }),
  );
  await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [502],
  );
  const recovered = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(keys[0]).toBe(`okou_wallet_${recovered.body.id}`);
  expect(recovered.body.intentId).toBe(input.intentId);
});

test("fails closed for a non-Link action URL instead of exposing a phishing link", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  const input = purchase();
  const provider = spendProvider(input);
  provider.payload({ approval_url: "https://phishing.example.test/approval" });
  const denied = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [502],
  );
  expect(denied.status).toBe(502);
});

test.each([null, 503, 401] as const)(
  "obtains a separate hosted approval link and preserves its intent across refresh (initial approval failure: %s)",
  async (failureStatus) => {
    const fixture = await carrier();
    server.use(tokenHandler({ expiresIn: 120 }));
    await connect(fixture);
    const input = purchase();
    const provider = spendProvider(input);
    provider.payload({ status: "created", approval_url: undefined });
    const approvalUrl =
      "https://app.link.com/approve?request=fixture%2Fapproval&key=exact";
    const approvalPath =
      "https://api.link.com/spend_requests/:id/request_approval";
    server.use(
      http.post(approvalPath, ({ params }) => {
        return HttpResponse.json({ id: params.id, approval_link: approvalUrl });
      }),
    );
    if (failureStatus !== null) {
      server.use(
        http.post(
          approvalPath,
          () => {
            return HttpResponse.json(
              { error: "insufficient_scope" },
              { status: failureStatus },
            );
          },
          { once: true },
        ),
      );
      const failed = await accept(
        client().createSpend({ headers: fixture.headers, body: input }),
        [failureStatus === 401 ? 409 : 502],
      );
      expect(failed.body.error.code).toBe(
        failureStatus === 401
          ? "WALLET_PROVIDER_AUTH_REJECTED"
          : "WALLET_PROVIDER_ERROR",
      );
      expect(failed.body.error.message).toContain("operation: spend_approval");
      expect(failed.body.error.message).toContain(
        "provider: insufficient_scope",
      );
    }
    const created = await accept(
      client().createSpend({ headers: fixture.headers, body: input }),
      [200],
    );
    expect(created.body).toMatchObject({
      intentId: input.intentId,
      status: "pending_approval",
      approvalUrl,
      nextAction: "wait_for_user",
    });

    // A repeated create must use the credentials it just rotated, not read the
    // same request graph's earlier credential snapshot a second time.
    mockNow(now() + 70_000);
    server.use(tokenHandler());
    provider.payload({ status: "pending_approval", approval_url: undefined });
    const repeated = await accept(
      client().createSpend({ headers: fixture.headers, body: input }),
      [200],
    );
    expect(repeated.body).toMatchObject({
      id: created.body.id,
      intentId: input.intentId,
      status: "pending_approval",
      approvalUrl,
    });
  },
);

test.each([
  ["auto_resume", "wait_for_user"],
  ["create_new_spend_request", "new_approval_required"],
  ["create_new_spend_request_after_completion", "new_approval_required"],
] as const)(
  "reports Link action resolution %s without treating it as approval",
  async (resolution, nextAction) => {
    const fixture = await carrier();
    server.use(tokenHandler());
    await connect(fixture);
    const input = purchase();
    const provider = spendProvider(input);
    const created = await accept(
      client().createSpend({ headers: fixture.headers, body: input }),
      [200],
    );
    const actionUrl =
      "https://hooks.stripe.com/redirect/authenticate?client=fixture%2Fexact";
    provider.payload({
      status: "requires_action",
      status_details: {
        requires_action: {
          next_action: {
            type: "authentication",
            resolution,
            action_url: actionUrl,
          },
        },
      },
      card: { number: "4242424242424242", cvc: "123" },
      payment_token: "secret-payment-fixture",
    });
    const result = await accept(
      client().getSpend({
        headers: fixture.headers,
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(result.body).toMatchObject({
      status: "requires_action",
      nextAction,
      approvalUrl: null,
      action: { type: "authentication", resolution, url: actionUrl },
    });
    expect(JSON.stringify(result.body)).not.toContain("4242424242424242");
    expect(JSON.stringify(result.body)).not.toContain("secret-payment-fixture");
  },
);

test("finishes revocation if disconnect races a rotating refresh, without resurrecting access", async () => {
  const fixture = await carrier();
  server.use(tokenHandler({ expiresIn: 30 }));
  await connect(fixture);
  const refreshStarted = createDeferredPromise<void>(context.signal);
  const finishRefresh = createDeferredPromise<void>(context.signal);
  onTestFinished(() => {
    if (!finishRefresh.settled()) {
      finishRefresh.resolve();
    }
  });
  server.use(
    http.post("https://login.link.com/auth/revoke", () => {
      return new HttpResponse(null, { status: 200 });
    }),
  );
  server.use(
    http.post("https://login.link.com/auth/token", async () => {
      refreshStarted.resolve();
      await finishRefresh.promise;
      return HttpResponse.json({
        access_token: "wallet-new-access-fixture",
        refresh_token: "wallet-new-refresh-fixture",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "payment_methods.agentic",
      });
    }),
  );
  const creation = client().createSpend({
    headers: fixture.headers,
    body: purchase(),
  });
  await refreshStarted.promise;
  const unconfirmed = await accept(
    client().disconnect({ headers: fixture.headers, body: {} }),
    [503],
  );
  expect(unconfirmed.body.error.code).toBe("WALLET_REVOCATION_UNCONFIRMED");
  finishRefresh.resolve();
  await accept(creation, [409]);
  expect(
    (await accept(client().status({ headers: fixture.headers }), [200])).body
      .connected,
  ).toBeFalsy();
  await accept(
    client().disconnect({ headers: fixture.headers, body: {} }),
    [200],
  );
});

test("cannot attest approval when Link omits the bound amount, currency or merchant", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  const input = purchase();
  const provider = spendProvider(input);
  const created = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  provider.approve();
  for (const field of ["amount", "currency", "merchant_name", "merchant_url"]) {
    provider.payload({ [field]: undefined });
    const denied = await accept(
      client().getSpend({
        headers: fixture.headers,
        params: { id: created.body.id },
      }),
      [502],
    );
    expect(denied.body.error.code).toBe("WALLET_INVALID_RESPONSE");
  }
});

test("returns a configuration error without exposing secrets or requiring disabled environments to configure Link", async () => {
  const fixture = await carrier();
  mockEnv("LINK_OAUTH_CLIENT_SECRET", undefined);
  const response = await accept(
    client().connect({ headers: fixture.headers, body: {} }),
    [503],
  );
  expect(response.body.error.code).toBe("WALLET_NOT_CONFIGURED");
  expect(JSON.stringify(response.body)).not.toContain("wallet-secret-fixture");
});

test("keeps a rejected spend intent recoverable without prescribing repeated wallet consent", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  const input = purchase();
  spendProvider(input);
  server.use(
    http.post(
      "https://api.link.com/spend_requests",
      () => {
        return HttpResponse.json(
          { error: { code: "unauthorized_client" } },
          { status: 401, headers: { "request-id": "req_walletDiagnostic" } },
        );
      },
      { once: true },
    ),
  );
  const rejected = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [409],
  );
  expect(rejected.body.error.code).toBe("WALLET_PROVIDER_AUTH_REJECTED");
  expect(rejected.body.error.message).toContain("operation: spend_create");
  expect(rejected.body.error.message).toContain(
    "provider: unauthorized_client",
  );
  expect(rejected.body.error.message).toMatch(/reference: [\da-f-]{36}/);
  const status = await accept(
    client().status({ headers: fixture.headers }),
    [200],
  );
  expect(status.body.connected).toBeTruthy();
  const recovered = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  expect(recovered.body).toMatchObject({
    intentId: input.intentId,
    status: "pending_approval",
  });
});

test.each([
  {
    body: {
      error: { message: "Invalid access token: liwlaccess_private_fixture" },
    },
    source: "error.message",
    reason: "invalid_access_token",
  },
  {
    body: { error: { message: "Access token has expired." } },
    source: "error.message",
    reason: "access_token_expired",
  },
  {
    body: { error: "expired_token" },
    source: "error",
    reason: "token_expired",
  },
  {
    body: {
      error: {
        message: "Access token is missing required scopes: balances:read",
      },
    },
    source: "error.message",
    reason: "insufficient_scope",
  },
  {
    body: { message: "Missing authorization header" },
    source: "message",
    reason: "missing_authorization",
  },
  {
    body: { error_description: "refresh_token is invalid" },
    source: "error_description",
    reason: "invalid_refresh_token",
  },
  {
    body: {
      error: { message: "Invalid client secret: private-client-fixture" },
    },
    source: "error.message",
    reason: "invalid_client_secret",
  },
  {
    body: {
      error: { message: "Unrecognized error for private-user@example.test" },
    },
    source: "error.message",
    reason: "unrecognized",
  },
])(
  "reports safe message diagnostics for $reason without changing consent or retrying",
  async ({ body, source, reason }) => {
    const fixture = await carrier();
    server.use(tokenHandler());
    await connect(fixture);
    let creates = 0;
    server.use(
      http.post("https://api.link.com/spend_requests", () => {
        creates += 1;
        return HttpResponse.json(body, { status: 401 });
      }),
    );
    const rejected = await accept(
      client().createSpend({ headers: fixture.headers, body: purchase() }),
      [409],
    );
    expect(rejected.body.error.code).toBe("WALLET_PROVIDER_AUTH_REJECTED");
    expect(rejected.body.error.message).toContain(`message source: ${source}`);
    expect(rejected.body.error.message).toContain(`reason: ${reason}`);
    expect(rejected.body.error.message).not.toMatch(
      /liwlaccess_private_fixture|private-client-fixture|private-user@example.test|balances:read/,
    );
    expect(creates).toBe(1);
    const status = await accept(
      client().status({ headers: fixture.headers }),
      [200],
    );
    expect(status.body.connected).toBeTruthy();
  },
);

test("preserves a structured token error when its optional message is malformed", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  server.use(
    http.post("https://api.link.com/spend_requests", () => {
      return HttpResponse.json(
        { error: { code: "invalid_token", message: null } },
        { status: 401 },
      );
    }),
  );
  const rejected = await accept(
    client().createSpend({ headers: fixture.headers, body: purchase() }),
    [409],
  );
  expect(rejected.body.error.code).toBe("WALLET_RECONNECT_REQUIRED");
  expect(rejected.body.error.message).toContain("provider: invalid_token");
});

test("identifies OAuth client rejection separately from a wallet needing consent", async () => {
  const fixture = await carrier();
  const started = await accept(
    client().connect({ headers: fixture.headers, body: {} }),
    [200],
  );
  const state = new URL(started.body.url).searchParams.get("state");
  if (!state) {
    throw new Error("Missing OAuth state");
  }
  server.use(
    http.post("https://login.link.com/auth/token", () => {
      return HttpResponse.json({ error: "invalid_client" }, { status: 401 });
    }),
  );
  const rejected = await accept(
    callbackClient().callback({
      headers: sessionHeaders,
      query: { state, code: "wallet-code-fixture", responseMode: "json" },
    }),
    [409],
  );
  expect(rejected.body.error.code).toBe("WALLET_PROVIDER_AUTH_REJECTED");
  expect(rejected.body.error.message).toContain("operation: oauth_exchange");
  expect(rejected.body.error.message).toContain("provider: invalid_client");
});

test("requires reconnecting when Link explicitly rejects a rotating refresh grant", async () => {
  const fixture = await carrier();
  server.use(tokenHandler({ expiresIn: 30 }));
  await connect(fixture);
  server.use(
    http.post("https://login.link.com/auth/token", () => {
      return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
    }),
  );
  const rejected = await accept(
    client().createSpend({ headers: fixture.headers, body: purchase() }),
    [409],
  );
  expect(rejected.body.error.code).toBe("WALLET_RECONNECT_REQUIRED");
  expect(rejected.body.error.message).toContain("operation: oauth_refresh");
  expect(rejected.body.error.message).toContain("provider: invalid_grant");
  const status = await accept(
    client().status({ headers: fixture.headers }),
    [200],
  );
  expect(status.body.connected).toBeFalsy();
});

test("keeps Link credentials and provider free text out of diagnostic responses", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  server.use(
    http.post("https://api.link.com/spend_requests", () => {
      return HttpResponse.json(
        {
          error: {
            code: "wallet-access-fixture",
            message:
              "wallet-secret-fixture wallet-refresh-fixture private-address-fixture",
          },
          card: { number: "private-card-fixture", cvc: "private-cvc-fixture" },
        },
        {
          status: 401,
          headers: {
            "request-id": "wallet-secret-fixture",
            "www-authenticate": 'Bearer error="wallet-refresh-fixture"',
          },
        },
      );
    }),
  );
  const rejected = await accept(
    client().createSpend({ headers: fixture.headers, body: purchase() }),
    [409],
  );
  expect(rejected.body.error.code).toBe("WALLET_PROVIDER_AUTH_REJECTED");
  expect(rejected.body.error.message).toContain("provider: unrecognized");
  const exposed = JSON.stringify(rejected.body);
  for (const secret of [
    "wallet-access-fixture",
    "wallet-refresh-fixture",
    "wallet-secret-fixture",
    "private-address-fixture",
    "private-card-fixture",
    "private-cvc-fixture",
  ]) {
    expect(exposed).not.toContain(secret);
  }
});

test("preserves authentication rejection when Link returns an oversized error document", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  server.use(
    http.post("https://api.link.com/spend_requests", () => {
      return new HttpResponse("x".repeat(20 * 1024), {
        status: 401,
        headers: { "content-type": "text/html" },
      });
    }),
  );
  const rejected = await accept(
    client().createSpend({ headers: fixture.headers, body: purchase() }),
    [409],
  );
  expect(rejected.body.error.code).toBe("WALLET_PROVIDER_AUTH_REJECTED");
  expect(rejected.body.error.message).toContain("operation: spend_create");
  expect(rejected.body.error.message).toContain("provider: unavailable");
});

test("explains an unfamiliar Link validation failure and preserves the intent for recovery", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  const input = purchase();
  spendProvider(input);
  server.use(
    http.post(
      "https://api.link.com/spend_requests",
      () => {
        return HttpResponse.json(
          {
            error: {
              type: "invalid_request_error",
              param: "expires_at",
              message:
                "Parameter 'expires_at' must be in the future for test requests.",
            },
          },
          { status: 400, headers: { "request-id": "req_walletValidation" } },
        );
      },
      { once: true },
    ),
  );
  const rejected = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [502],
  );
  expect(rejected.body.error.code).toBe("WALLET_PROVIDER_ERROR");
  expect(rejected.body.error.message).toContain("HTTP 400");
  expect(rejected.body.error.message).toContain("parameter: expires_at");
  expect(rejected.body.error.message).toContain(
    'detail: Parameter "expires_at" must be in the future for test requests.',
  );
  expect(rejected.body.error.message).toMatch(/reference: [\da-f-]{36}/);
  const recovered = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  expect(recovered.body.intentId).toBe(input.intentId);
});

test.each([
  { status: 403, message: "Test mode is not enabled for this client." },
  { status: 429, message: "Too many pending spend requests. Try again later." },
  { status: 503, message: "The wallet service is temporarily unavailable." },
])(
  "preserves the explanation for Link HTTP $status without reconnecting",
  async ({ status, message }) => {
    const fixture = await carrier();
    server.use(tokenHandler());
    await connect(fixture);
    server.use(
      http.post("https://api.link.com/spend_requests", () => {
        return HttpResponse.json({ error: { message } }, { status });
      }),
    );
    const rejected = await accept(
      client().createSpend({ headers: fixture.headers, body: purchase() }),
      [502],
    );
    expect(rejected.body.error.message).toContain(`HTTP ${status}`);
    expect(rejected.body.error.message).toContain(`detail: ${message}`);
    const connected = await accept(
      client().status({ headers: fixture.headers }),
      [200],
    );
    expect(connected.body.connected).toBeTruthy();
  },
);

test.each([
  {
    kind: "network",
    response: () => {
      return HttpResponse.error();
    },
    stage: "transport",
    detail: "transport: network",
  },
  {
    kind: "invalid JSON",
    response: () => {
      return new HttpResponse("not JSON", {
        headers: { "content-type": "application/json" },
      });
    },
    stage: "response_body",
    detail: "body: invalid_json",
  },
  {
    kind: "oversized JSON",
    response: () => {
      return new HttpResponse("x".repeat(130 * 1024));
    },
    stage: "response_body",
    detail: "body: too_large",
  },
  {
    kind: "invalid spend schema",
    response: () => {
      return HttpResponse.json({ status: "pending_approval" });
    },
    stage: "response_schema",
    detail: "id:invalid_type",
  },
])(
  "returns a diagnostic reference for $kind",
  async ({ response, stage, detail }) => {
    const fixture = await carrier();
    server.use(tokenHandler());
    await connect(fixture);
    server.use(http.post("https://api.link.com/spend_requests", response));
    const rejected = await accept(
      client().createSpend({ headers: fixture.headers, body: purchase() }),
      [502],
    );
    expect(rejected.body.error.message).toContain(`stage: ${stage}`);
    expect(rejected.body.error.message).toContain(detail);
    expect(rejected.body.error.message).toMatch(/reference: [\da-f-]{36}/);
  },
);

test("redacts provider echoes in returned diagnostics", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  const input = purchase();
  const secret = "wallet-access-fixture";
  server.use(
    http.post("https://api.link.com/spend_requests", () => {
      return HttpResponse.json(
        {
          error: {
            code: secret,
            param: "private-account-fixture",
            message: `Request rejected for ${secret} ${encodeURIComponent(secret)} ${Buffer.from(secret).toString("base64")} ${input.context} ${input.merchantName} ${input.merchantUrl}; user@example.test; "private address"; card number: 4242 4242 4242 4242; CVC: 123; John Smith; https://app.link.com/approve?token=private-query-fixture`,
          },
          card: { number: "private-card-fixture", cvc: "private-cvc-fixture" },
        },
        { status: 400 },
      );
    }),
  );
  const rejected = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [502],
  );
  const exposed = JSON.stringify(rejected.body);
  for (const value of [
    secret,
    Buffer.from(secret).toString("base64"),
    input.context,
    input.merchantName,
    input.merchantUrl,
    "user@example.test",
    "private address",
    "4242",
    "CVC: 123",
    "John Smith",
    "private-query-fixture",
    "private-card-fixture",
    "private-cvc-fixture",
    "private-account-fixture",
  ]) {
    expect(exposed).not.toContain(value);
  }
  expect(rejected.body.error.message).toContain("Request rejected for");
});

test("keeps independent diagnostics when one optional provider field is malformed", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  server.use(
    http.post("https://api.link.com/spend_requests", () => {
      return HttpResponse.json(
        {
          error: {
            code: "invalid_request_error",
            param: "totals[0].amount",
            message: null,
          },
          detail: "The total amount must match the requested amount.",
        },
        { status: 400 },
      );
    }),
  );
  const rejected = await accept(
    client().createSpend({ headers: fixture.headers, body: purchase() }),
    [502],
  );
  expect(rejected.body.error.message).toContain(
    "provider: invalid_request_error",
  );
  expect(rejected.body.error.message).toContain("parameter: totals.[].amount");
  expect(rejected.body.error.message).toContain("message source: detail");
  expect(rejected.body.error.message).toContain(
    "The total amount must match the requested amount.",
  );
});

test("retains a bounded plain-text provider rejection without exposing its identifiers", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  server.use(
    http.post("https://api.link.com/spend_requests", () => {
      return new HttpResponse(
        "Account verification is required for customer@example.test.",
        { status: 400, headers: { "content-type": "text/plain" } },
      );
    }),
  );
  const rejected = await accept(
    client().createSpend({ headers: fixture.headers, body: purchase() }),
    [502],
  );
  expect(rejected.body.error.message).toContain(
    "message source: response.text",
  );
  expect(rejected.body.error.message).toContain(
    "Account verification is required",
  );
  expect(rejected.body.error.message).not.toContain("customer@example.test");
});
