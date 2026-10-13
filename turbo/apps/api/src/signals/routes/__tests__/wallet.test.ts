import { createHash, randomUUID } from "node:crypto";
import {
  walletCallbackContract,
  walletContract,
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

const context = testContext();
const mocks = createRouteMocks(context);
const sessionHeaders = Object.freeze({ authorization: "Bearer clerk-session" });
const client = () => {
  return setupApp({ context, routes: walletRoutes })(walletContract);
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
  expect(url.searchParams.get("scope")).toBe("payment_methods.agentic");
  expect(started.body.url).not.toContain("wallet-secret-fixture");
  const state = url.searchParams.get("state") ?? "";
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
        scope: "payment_methods.agentic",
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
  await accept(
    callbackClient().callback({
      headers: sessionHeaders,
      query: { state, code: "wallet-code-fixture" },
    }),
    [400],
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
  const expired = await accept(
    client().connect({ headers: fixture.headers, body: {} }),
    [200],
  );
  mockNow(new Date(expired.body.expiresAt).getTime());
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

test.each([false, true])(
  "obtains a separate hosted approval link and preserves its intent across refresh (initial approval failure: %s)",
  async (failApproval) => {
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
    if (failApproval) {
      server.use(
        http.post(
          approvalPath,
          () => {
            return HttpResponse.json({}, { status: 503 });
          },
          { once: true },
        ),
      );
      const failed = await accept(
        client().createSpend({ headers: fixture.headers, body: input }),
        [502],
      );
      expect(failed.body.error.code).toBe("WALLET_PROVIDER_ERROR");
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
