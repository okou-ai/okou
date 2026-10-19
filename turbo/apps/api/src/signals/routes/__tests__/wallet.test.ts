import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  walletCallbackContract,
  walletContract,
  walletUserContract,
  type WalletCreateSpend,
  walletSpendCredentialsSchema,
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
import { linkApprovalWorkflowRoutes } from "../link-approval-workflow";
import { cronProcessBackgroundJobsRoutes } from "../cron-process-background-jobs";
import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  channelsPublishedTo,
  countPublishedTo,
} from "./helpers/realtime-publications";

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
  enabled: boolean | null = null,
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
  if (enabled !== null) {
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId: actor.orgId },
      { [FeatureSwitchKey.LinkWallet]: enabled },
    );
  }
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
  let completed = false;
  onTestFinished(async () => {
    if (completed) {
      return;
    }
    await api.requestCancelRun(actor, run.runId, [200]);
    await createWebhookCallbackApi(context).requestAgentComplete(
      { runId: run.runId, exitCode: 1, error: "Wallet test carrier canceled" },
      { authorization: `Bearer ${claim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
  });
  return {
    run,
    api,
    runnerGroup,
    complete: async () => {
      await createWebhookCallbackApi(context).requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 0,
        },
        { authorization: `Bearer ${claim.sandboxToken}` },
        [200],
      );
      completed = true;
      await flushWaitUntilForTest();
    },
    actor: { ...actor, orgId: actor.orgId },
    agentId: agent.agentId,
    prompt: claim.appendSystemPrompt ?? "",
    environmentNames: Object.keys(claim.platformEnvironment),
    headers: { authorization: `Bearer ${token}` },
  };
}

function tokenHandler(
  options: { scope?: string; expiresIn?: number; actions?: string[] } = {},
) {
  return http.post("https://login.link.com/auth/token", () => {
    return HttpResponse.json({
      access_token: "wallet-access-fixture",
      refresh_token: "wallet-refresh-fixture",
      token_type: "Bearer",
      expires_in: options.expiresIn ?? 3600,
      scope: options.scope ?? "payment_methods.agentic userinfo:read",
      authorization_details: [
        {
          type: "source",
          actions: options.actions ?? ["read_link_transactions"],
        },
      ],
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
  let credentialPayload: Record<string, unknown> | undefined;
  const wire = () => {
    return {
      id,
      status,
      created_at: "2026-10-14T00:00:00Z",
      updated_at: "2026-10-14T00:00:00Z",
      amount,
      currency: input.currency,
      merchant_name: input.merchantName,
      merchant_url: input.merchantUrl,
      approval_url: `https://app.link.com/activity/approve/${id}`,
      ...payload,
    };
  };
  server.use(
    http.post("https://api.link.com/spend_requests", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      if ("expires_at" in body) {
        return HttpResponse.json(
          { error: { message: "expires_at is not supported for this client" } },
          { status: 400 },
        );
      }
      return HttpResponse.json(wire());
    }),
    http.get(`https://api.link.com/spend_requests/${id}`, ({ request }) => {
      const include = new URL(request.url).searchParams.get("include");
      if (include !== null) {
        expect(include).toBe("card");
        expect(credentialPayload).toBeDefined();
        return HttpResponse.json({ ...wire(), ...credentialPayload });
      }
      return HttpResponse.json(wire());
    }),
    http.post(`https://api.link.com/spend_requests/${id}/cancel`, () => {
      status = "canceled";
      return HttpResponse.json(wire());
    }),
  );
  return {
    id,
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
    credentials: (value: Record<string, unknown>) => {
      credentialPayload = value;
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
  await updateFeatureSwitchesForUser(
    context,
    { userId: off.actor.userId, orgId: off.actor.orgId },
    { [FeatureSwitchKey.LinkWallet]: true },
  );
  const missingCapability = await accept(
    client().transactions({ headers: off.headers, query: {} }),
    [403],
  );
  expect(missingCapability.body.error.code).toBe("MISSING_CAPABILITY");
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
  await accept(
    client().spendCredentials({
      headers: active.headers,
      params: { id: randomUUID() },
      body: {},
    }),
    [403],
  );
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
  ).toStrictEqual({ status: "pending" });
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
    orgId: fixture.actor.orgId,
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
  expect(status.body).toMatchObject({
    connected: true,
    nextAction: "create_spend",
    checkoutAvailable: false,
  });
});

test("denies declined and expired OAuth requests and unrecognized scopes", async () => {
  const fixture = await carrier();
  server.use(tokenHandler({ scope: "unrecognized:read" }));
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
  expect(approved.body.nextAction).toBe("retrieve_credentials");
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

test("keeps purchase ownership scoped to the user, organization and agent", async () => {
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
  await accept(
    client().spendCredentials({
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
    const credentials = await accept(
      client().spendCredentials({
        headers: fixture.headers,
        params: { id: created.body.id },
        body: {},
      }),
      [409],
    );
    expect(credentials.body.error.code).toBe("WALLET_SPEND_NOT_APPROVED");
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
    userClient().disconnect({ headers: sessionHeaders, body: {} }),
    [502],
  );
  expect(
    (await accept(client().status({ headers: fixture.headers }), [200])).body
      .connected,
  ).toBeFalsy();
  expect(
    (await accept(userClient().status({ headers: sessionHeaders }), [200]))
      .body,
  ).toMatchObject({ connected: false, revocationPending: true });
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
    userClient().disconnect({ headers: sessionHeaders, body: {} }),
    [200],
  );
  expect(
    (await accept(userClient().status({ headers: sessionHeaders }), [200]))
      .body,
  ).toMatchObject({ connected: false, revocationPending: false });
});

test("refreshes rotating credentials only on the backend and isolates requests from a replaced authorization", async () => {
  const fixture = await carrier();
  server.use(tokenHandler({ expiresIn: 30 }));
  await connect(fixture);
  server.use(tokenHandler({ scope: "payment_methods.agentic" }));
  const input = purchase();
  spendProvider(input);
  const created = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  // Provider token scopes are not the authorization-request snapshot. Refresh
  // must preserve the scopes the user reviewed, even when Link returns fewer.
  expect(
    (await accept(userClient().status({ headers: sessionHeaders }), [200]))
      .body,
  ).toMatchObject({
    connected: true,
    connectionStatus: "connected",
    scopeChange: null,
  });
  await connect(fixture);
  const oldAuthorization = await accept(
    client().getSpend({
      headers: fixture.headers,
      params: { id: created.body.id },
    }),
    [409],
  );
  expect(oldAuthorization.body.error.code).toBe("WALLET_AUTHORIZATION_CHANGED");
  const credentials = await accept(
    client().spendCredentials({
      headers: fixture.headers,
      params: { id: created.body.id },
      body: {},
    }),
    [409],
  );
  expect(credentials.body.error.code).toBe("WALLET_AUTHORIZATION_CHANGED");
});

test("keeps the existing wallet usable when a reconnect is started and declined", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  const reconnect = await accept(
    userClient().connect({ headers: sessionHeaders, body: {} }),
    [200],
  );
  expect(
    (await accept(userClient().status({ headers: sessionHeaders }), [200]))
      .body,
  ).toMatchObject({
    connected: true,
    connectionStatus: "connected",
    scopeChange: null,
  });
  const declined = await accept(
    callbackClient().callback({
      headers: sessionHeaders,
      query: {
        state: new URL(reconnect.body.url).searchParams.get("state") ?? "",
        error: "access_denied",
        responseMode: "json",
      },
    }),
    [200],
  );
  expect(declined.body.status).toBe("error");
  expect(
    (await accept(userClient().status({ headers: sessionHeaders }), [200]))
      .body,
  ).toMatchObject({
    connected: true,
    connectionStatus: "connected",
    scopeChange: null,
  });
  const input = purchase();
  spendProvider(input);
  await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
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

test("shares a workspace wallet across agents while isolating purchase approvals", async () => {
  const fixture = await carrier();
  server.use(
    tokenHandler(),
    http.post("https://login.link.com/auth/revoke", () => {
      return HttpResponse.json({});
    }),
  );
  await connect(fixture);
  const input = { ...purchase(), test: false };
  const provider = spendProvider(input);
  const created = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  provider.approve();
  await accept(
    client().getSpend({
      headers: fixture.headers,
      params: { id: created.body.id },
    }),
    [200],
  );
  const otherAgent = await carrier(true, fixture.actor);
  expect(
    (await accept(client().status({ headers: otherAgent.headers }), [200])).body
      .connected,
  ).toBeTruthy();
  await accept(
    client().getSpend({
      headers: otherAgent.headers,
      params: { id: created.body.id },
    }),
    [404],
  );
  await accept(
    client().spendCredentials({
      headers: otherAgent.headers,
      params: { id: created.body.id },
      body: {},
    }),
    [404],
  );
  const secondPurchase = { ...purchase(), test: false };
  spendProvider(secondPurchase);
  const second = await accept(
    client().createSpend({ headers: otherAgent.headers, body: secondPurchase }),
    [200],
  );
  const testPurchase = purchase();
  spendProvider(testPurchase);
  const testRequest = await accept(
    client().createSpend({ headers: fixture.headers, body: testPurchase }),
    [200],
  );
  const hiddenCursor = await accept(
    userClient().transactions({
      headers: sessionHeaders,
      query: { cursor: testRequest.body.id },
    }),
    [200],
  );
  expect(hiddenCursor.body).toStrictEqual({
    transactions: [],
    nextCursor: null,
  });
  const firstPage = await accept(
    userClient().transactions({ headers: sessionHeaders, query: { limit: 1 } }),
    [200],
  );
  expect(firstPage.headers.get("cache-control")).toBe("no-store");
  expect(firstPage.body.transactions).toStrictEqual([
    {
      id: second.body.id,
      merchantName: secondPurchase.merchantName,
      amount: secondPurchase.amount,
      currency: "usd",
      status: "pending_approval",
      test: false,
      createdAt: expect.any(String),
    },
  ]);
  expect(firstPage.body.nextCursor).toBe(second.body.id);
  // A new request between pages must not duplicate or displace earlier entries.
  const newestPurchase = { ...purchase(), test: false };
  spendProvider(newestPurchase);
  await accept(
    client().createSpend({ headers: otherAgent.headers, body: newestPurchase }),
    [200],
  );
  const secondPage = await accept(
    userClient().transactions({
      headers: sessionHeaders,
      query: { cursor: second.body.id, limit: 1 },
    }),
    [200],
  );
  expect(secondPage.body.transactions).toStrictEqual([
    {
      id: created.body.id,
      merchantName: input.merchantName,
      amount: input.amount,
      currency: "usd",
      status: "approved",
      test: false,
      createdAt: expect.any(String),
    },
  ]);
  expect(secondPage.body.nextCursor).toBeNull();
  const bdd = createBddApi(context);
  for (const peer of [
    bdd.user({ orgId: fixture.actor.orgId }),
    bdd.user({ userId: fixture.actor.userId }),
  ]) {
    mocks.clerk.session(peer.userId, peer.orgId, peer.orgRole);
    for (const cursor of [undefined, second.body.id]) {
      const isolated = await accept(
        userClient().transactions({
          headers: sessionHeaders,
          query: { cursor },
        }),
        [200],
      );
      expect(isolated.body).toStrictEqual({
        transactions: [],
        nextCursor: null,
      });
    }
  }
  mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);
  await accept(
    userClient().transactions({ headers: fixture.headers, query: {} }),
    [403],
  );
  for (const query of [{ limit: 0 }, { limit: 101 }, { cursor: "invalid" }]) {
    await accept(
      userClient().transactions({ headers: sessionHeaders, query }),
      [400],
    );
  }
  const missing = await accept(
    userClient().transactions({
      headers: sessionHeaders,
      query: { cursor: randomUUID() },
    }),
    [200],
  );
  expect(missing.body).toStrictEqual({ transactions: [], nextCursor: null });
  await accept(
    userClient().disconnect({ headers: sessionHeaders, body: {} }),
    [200],
  );
  const history = await accept(
    userClient().transactions({ headers: sessionHeaders, query: {} }),
    [200],
  );
  expect(history.body.transactions).toHaveLength(3);
  for (const headers of [fixture.headers, otherAgent.headers]) {
    expect(
      (await accept(client().status({ headers }), [200])).body.connected,
    ).toBeFalsy();
    await accept(client().createSpend({ headers, body: purchase() }), [409]);
  }
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
    client().spendCredentials({
      headers: fixture.headers,
      params: { id: randomUUID() },
      body: {},
    }),
    [403],
  );
  await accept(
    client().createSpend({ headers: fixture.headers, body: purchase() }),
    [403],
  );
});

function virtualCard() {
  return {
    id: "card_fixture",
    brand: "visa",
    number: "4000009990001984",
    cvc: "123",
    exp_month: 12,
    exp_year: 2030,
    billing_address: {
      name: "Wallet Test",
      line1: "123 Test Street",
      city: "San Francisco",
      state: "CA",
      postal_code: "94103",
      country: "US",
    },
    valid_until: new Date(now() + 30 * 60_000).toISOString(),
  };
}

test("releases only the approved purchase's card through the explicit uncached credentials endpoint", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  const input = purchase();
  const provider = spendProvider(input);
  const created = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  const request = {
    headers: fixture.headers,
    params: { id: created.body.id },
    body: {},
  };
  const pending = await accept(client().spendCredentials(request), [409]);
  expect(pending.body.error.code).toBe("WALLET_SPEND_NOT_APPROVED");
  const card = virtualCard();
  provider.approve();
  provider.credentials({
    card,
    access_token: "private-oauth-fixture",
    shared_payment_token: "private-spt-fixture",
  });
  const response = await accept(client().spendCredentials(request), [200]);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("content-disposition")).toContain("attachment;");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const credentials = walletSpendCredentialsSchema.parse(
    JSON.parse(await response.body.text()),
  );
  expect(credentials).toStrictEqual({
    spend: {
      ...created.body,
      status: "approved",
      approvalUrl: null,
      nextAction: "retrieve_credentials",
    },
    card: {
      brand: card.brand,
      number: card.number,
      cvc: card.cvc,
      expMonth: card.exp_month,
      expYear: card.exp_year,
      billingAddress: {
        name: "Wallet Test",
        line1: "123 Test Street",
        city: "San Francisco",
        state: "CA",
        postalCode: "94103",
        country: "US",
      },
      validUntil: card.valid_until,
    },
  });
  expect(JSON.stringify(credentials)).not.toMatch(
    /private-oauth-fixture|private-spt-fixture/,
  );
  const ordinary = await accept(
    client().getSpend({ headers: fixture.headers, params: request.params }),
    [200],
  );
  expect(JSON.stringify(ordinary.body)).not.toContain(card.number);
  expect(ordinary.body).not.toHaveProperty("card");
  provider.credentials({
    card: {
      brand: card.brand,
      number: card.number,
      exp_month: card.exp_month,
      exp_year: card.exp_year,
    },
  });
  const minimal = await accept(client().spendCredentials(request), [200]);
  expect(
    walletSpendCredentialsSchema.parse(JSON.parse(await minimal.body.text()))
      .card,
  ).toStrictEqual({
    brand: card.brand,
    number: card.number,
    expMonth: card.exp_month,
    expYear: card.exp_year,
  });
  await accept(client().cancelSpend(request), [200]);
  const canceled = await accept(client().spendCredentials(request), [409]);
  expect(canceled.body.error.code).toBe("WALLET_SPEND_NOT_APPROVED");
});

test.each([
  { kind: "changed status", status: 409, code: "WALLET_SPEND_NOT_APPROVED" },
  { kind: "changed amount", status: 409, code: "WALLET_APPROVAL_MISMATCH" },
  { kind: "changed merchant", status: 409, code: "WALLET_APPROVAL_MISMATCH" },
  { kind: "missing card", status: 409, code: "WALLET_CREDENTIALS_UNAVAILABLE" },
  { kind: "malformed card", status: 502, code: "WALLET_INVALID_RESPONSE" },
  { kind: "expired card", status: 409, code: "WALLET_CREDENTIALS_EXPIRED" },
] as const)(
  "withholds credentials for $kind in the expanded Link response",
  async ({ kind, status, code }) => {
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
    const card = virtualCard();
    provider.credentials({
      ...(kind === "changed status" ? { status: "canceled" } : {}),
      ...(kind === "changed amount" ? { amount: input.amount + 1 } : {}),
      ...(kind === "changed merchant"
        ? { merchant_url: "https://other.example.test" }
        : {}),
      ...(kind === "missing card"
        ? {}
        : {
            card: {
              ...card,
              ...(kind === "malformed card"
                ? { exp_month: "private-card-field" }
                : {}),
              ...(kind === "expired card"
                ? { valid_until: new Date(now() - 1000).toISOString() }
                : {}),
            },
          }),
    });
    const response = await accept(
      client().spendCredentials({
        headers: fixture.headers,
        params: { id: created.body.id },
        body: {},
      }),
      [status],
    );
    expect(response.body.error.code).toBe(code);
    expect(JSON.stringify(response.body)).not.toMatch(
      /4000009990001984|private-card-field|123 Test Street/,
    );
  },
);

test("withholds retrieved credentials when the wallet is disconnected during the Link request", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  const input = purchase();
  const provider = spendProvider(input);
  const created = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  const started = createDeferredPromise<void>(context.signal);
  const finish = createDeferredPromise<void>(context.signal);
  onTestFinished(() => {
    if (!finish.settled()) {
      finish.resolve();
    }
  });
  server.use(
    http.post("https://login.link.com/auth/revoke", () => {
      return new HttpResponse(null, { status: 200 });
    }),
    http.get(
      `https://api.link.com/spend_requests/${provider.id}`,
      async ({ request }) => {
        const expanded = new URL(request.url).searchParams.has("include");
        if (expanded) {
          started.resolve();
          await finish.promise;
        }
        return HttpResponse.json({
          id: provider.id,
          status: "approved",
          amount: input.amount,
          currency: input.currency,
          merchant_name: input.merchantName,
          merchant_url: input.merchantUrl,
          created_at: "2026-10-14T00:00:00Z",
          updated_at: "2026-10-14T00:00:00Z",
          ...(expanded ? { card: virtualCard() } : {}),
        });
      },
    ),
  );
  const credentials = client().spendCredentials({
    headers: fixture.headers,
    params: { id: created.body.id },
    body: {},
  });
  await started.promise;
  await accept(
    client().disconnect({ headers: fixture.headers, body: {} }),
    [200],
  );
  finish.resolve();
  const response = await accept(credentials, [409]);
  expect(response.body.error.code).toBe("WALLET_AUTHORIZATION_CHANGED");
  expect(JSON.stringify(response.body)).not.toContain("4000009990001984");
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
    created_at: "2026-10-14T00:00:00Z",
    updated_at: "2026-10-14T00:00:00Z",
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

test("reports SDK response validation without exposing provider values and keeps the intent recoverable", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  const input = purchase();
  const provider = spendProvider(input);
  provider.payload({ created_at: { value: "private-provider-fixture" } });

  const rejected = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [502],
  );
  expect(rejected.body.error.code).toBe("WALLET_INVALID_RESPONSE");
  expect(rejected.body.error.message).toContain("stage: response_schema");
  expect(rejected.body.error.message).toContain("created_at:invalid_type");
  expect(rejected.body.error.message).toMatch(/reference: [\da-f-]{36}/);
  expect(JSON.stringify(rejected.body)).not.toContain(
    "private-provider-fixture",
  );

  provider.payload({});
  const recovered = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  expect(recovered.body.intentId).toBe(input.intentId);
  expect(recovered.body.status).toBe("pending_approval");
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
  const notificationsBefore = countPublishedTo(context.mocks, {
    channel: `user:${fixture.actor.userId}`,
    topic: "wallet:changed",
  });
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
  expect(
    (await accept(userClient().status({ headers: sessionHeaders }), [200]))
      .body,
  ).toMatchObject({
    connected: false,
    connectionStatus: "reconnect-required",
    scopeChange: null,
  });
  expect(
    countPublishedTo(context.mocks, {
      channel: `user:${fixture.actor.userId}`,
      topic: "wallet:changed",
    }),
  ).toBe(notificationsBefore + 1);
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

test("manages a personal workspace wallet from a member session without an agent or run", async () => {
  const bdd = createBddApi(context);
  const owner = bdd.user({ orgRole: "org:member" });
  if (!owner.orgId) {
    throw new Error("Missing organization");
  }
  mocks.clerk.session(owner.userId, owner.orgId, owner.orgRole);
  server.use(
    tokenHandler(),
    http.post("https://login.link.com/auth/revoke", () => {
      return HttpResponse.json({});
    }),
  );
  expect(
    (await accept(userClient().status({ headers: sessionHeaders }), [200])).body
      .connected,
  ).toBeFalsy();
  const started = await accept(
    userClient().connect({ headers: sessionHeaders, body: {} }),
    [200],
  );
  const state = new URL(started.body.url).searchParams.get("state") ?? "";
  await accept(
    callbackClient().callback({
      headers: sessionHeaders,
      query: { state, code: "session-wallet-code", responseMode: "json" },
    }),
    [200],
  );
  expect(
    (
      await accept(
        userClient().connectStatus({
          headers: sessionHeaders,
          body: { state },
        }),
        [200],
      )
    ).body.status,
  ).toBe("authorized");
  expect(
    (await accept(userClient().status({ headers: sessionHeaders }), [200])).body
      .connected,
  ).toBeTruthy();
  // Settings grants connection management, never purchase execution.
  await accept(
    client().createSpend({ headers: sessionHeaders, body: purchase() }),
    [403],
  );
  for (const peer of [
    bdd.user({ orgId: owner.orgId }),
    bdd.user({ userId: owner.userId }),
  ]) {
    mocks.clerk.session(peer.userId, peer.orgId, peer.orgRole);
    expect(
      (await accept(userClient().status({ headers: sessionHeaders }), [200]))
        .body.connected,
    ).toBeFalsy();
    expect(
      (
        await accept(
          userClient().connectStatus({
            headers: sessionHeaders,
            body: { state },
          }),
          [200],
        )
      ).body.status,
    ).toBe("unavailable");
    await accept(
      userClient().disconnect({ headers: sessionHeaders, body: {} }),
      [200],
    );
  }
  mocks.clerk.session(owner.userId, owner.orgId, owner.orgRole);
  expect(
    (await accept(userClient().status({ headers: sessionHeaders }), [200])).body
      .connected,
  ).toBeTruthy();
  await accept(
    userClient().disconnect({ headers: sessionHeaders, body: {} }),
    [200],
  );
  expect(
    (await accept(userClient().status({ headers: sessionHeaders }), [200])).body
      .connected,
  ).toBeFalsy();
});

test("gates session wallet management and rejects run tokens on settings endpoints", async () => {
  const fixture = await carrier(false);
  for (const headers of [sessionHeaders, fixture.headers]) {
    const denied = await accept(userClient().status({ headers }), [403]);
    expect(denied.status).toBe(403);
    await accept(userClient().connect({ headers, body: {} }), [403]);
    await accept(userClient().disconnect({ headers, body: {} }), [403]);
    await accept(userClient().transactions({ headers, query: {} }), [403]);
    await accept(userClient().paymentMethods({ headers, query: {} }), [403]);
  }
});

test("reads Link transactions with explicit financial consent and keeps a grant without payment access unable to spend", async () => {
  const fixture = await carrier();
  server.use(
    tokenHandler({
      scope: "userinfo:read financial_insights.transactions.read",
      actions: ["read_link_transactions"],
    }),
  );
  const consent = await connect(fixture);
  expect(consent.url.searchParams.get("scope")).toBe(
    "payment_methods.agentic userinfo:read",
  );
  expect(
    (await accept(userClient().status({ headers: sessionHeaders }), [200])).body
      .scopeChange,
  ).toBeNull();
  expect(
    JSON.parse(consent.url.searchParams.get("authorization_details") ?? "null"),
  ).toStrictEqual([{ type: "source", actions: ["read_link_transactions"] }]);
  expect(
    (await accept(client().status({ headers: fixture.headers }), [200])).body,
  ).toMatchObject({
    connected: true,
    // Captured CLI builds parse only connect/create_spend; reads are additive.
    nextAction: "connect",
    checkoutAvailable: false,
    authorization: {
      known: true,
      sourceActions: ["read_link_transactions"],
      capabilities: {
        payments: false,
        paymentMethods: false,
        userInfo: true,
        transactions: true,
      },
    },
  });
  expect(
    (
      await accept(
        client().createSpend({ headers: fixture.headers, body: purchase() }),
        [403],
      )
    ).body.error.code,
  ).toBe("WALLET_SCOPE_REQUIRED");
  await accept(client().paymentMethods({ headers: fixture.headers }), [403]);
  await accept(userClient().paymentMethods({ headers: sessionHeaders }), [403]);
  let providerQuery: Record<string, string> = {};
  server.use(
    http.get("https://api.link.com/transactions", ({ request }) => {
      providerQuery = Object.fromEntries(new URL(request.url).searchParams);
      return HttpResponse.json({
        data: [
          {
            id: "txn_first",
            source_id: null,
            amount: -3500,
            currency: "usd",
            created_date: "2026-10-14",
            description: "Example Books",
            origin: "link",
            category: "shopping",
            status: "posted",
            card: { number: "private-pan" },
            access_token: "private-token",
          },
        ],
        has_more: true,
      });
    }),
  );
  const result = await accept(
    client().transactions({
      headers: fixture.headers,
      query: {
        startDate: "2026-10-01",
        endDate: "2026-10-15",
        limit: 1,
        startingAfter: "txn_previous",
        category: "shopping",
      },
    }),
    [200],
  );
  expect(providerQuery).toStrictEqual({
    origin: "link",
    date_start: "2026-10-01",
    date_end: "2026-10-15",
    limit: "1",
    starting_after: "txn_previous",
    category: "shopping",
  });
  expect(result.body).toStrictEqual({
    data: [
      {
        id: "txn_first",
        sourceId: null,
        amount: -3500,
        currency: "usd",
        date: "2026-10-14",
        description: "Example Books",
        origin: "link",
        category: "shopping",
        status: "posted",
      },
    ],
    hasMore: true,
    nextCursor: "txn_first",
  });
  expect(result.headers.get("cache-control")).toBe("no-store");
  const sessionActivity = await accept(
    userClient().activity({
      headers: sessionHeaders,
      query: {
        startDate: "2026-10-01",
        endDate: "2026-10-15",
        limit: 1,
        startingAfter: "txn_previous",
        category: "shopping",
      },
    }),
    [200],
  );
  expect(sessionActivity.body).toStrictEqual(result.body);
  expect(sessionActivity.headers.get("cache-control")).toBe("no-store");
  await accept(
    userClient().activity({ headers: fixture.headers, query: {} }),
    [403],
  );
  const peer = createBddApi(context).user({ orgId: fixture.actor.orgId });
  mocks.clerk.session(peer.userId, peer.orgId, peer.orgRole);
  await accept(
    userClient().activity({ headers: sessionHeaders, query: {} }),
    [409],
  );
  mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

  server.use(
    http.get("https://api.link.com/transactions", () => {
      return HttpResponse.json([]);
    }),
  );
  expect(
    (
      await accept(
        client().transactions({ headers: fixture.headers, query: {} }),
        [200],
      )
    ).body,
  ).toStrictEqual({ data: [], hasMore: null, nextCursor: null });
  const raw = setupRawAppRequest({ context, routes: walletRoutes });
  for (const query of [
    "origin=external_connection",
    "startDate=2026-10-15&endDate=2026-10-01",
    "startDate=2026-02-30",
    "limit=101",
    "include=card",
  ]) {
    expect(
      (
        await raw(`/api/wallet/transactions?${query}`, {
          method: "GET",
          headers: fixture.headers,
        })
      ).status,
    ).toBe(400);
  }
});

test("does not infer financial actions from a scope or from a pending consent upgrade", async () => {
  const fixture = await carrier();
  server.use(
    tokenHandler({
      scope:
        "payment_methods.agentic userinfo:read financial_insights.transactions.read",
      actions: [],
    }),
  );
  await connect(fixture);
  await accept(
    client().transactions({ headers: fixture.headers, query: {} }),
    [403],
  );
  await accept(
    userClient().activity({ headers: sessionHeaders, query: {} }),
    [403],
  );
  expect(
    (await accept(userClient().status({ headers: sessionHeaders }), [200]))
      .body,
  ).toMatchObject({
    connected: true,
    connectionStatus: "scope-mismatch",
    scopeChange: { addedScopes: ["read_link_transactions"] },
  });
  const upgrade = await accept(
    client().connect({
      headers: fixture.headers,
      body: {},
    }),
    [200],
  );
  expect(new URL(upgrade.body.url).searchParams.get("scope")).toContain(
    "payment_methods.agentic",
  );
  await accept(
    client().transactions({ headers: fixture.headers, query: {} }),
    [403],
  );
  expect(
    (await accept(client().status({ headers: fixture.headers }), [200])).body
      .authorization?.capabilities.payments,
  ).toBeTruthy();
  const denied = await accept(
    callbackClient().callback({
      headers: sessionHeaders,
      query: {
        state: new URL(upgrade.body.url).searchParams.get("state") ?? "",
        error: "access_denied",
        responseMode: "json",
      },
    }),
    [200],
  );
  expect(denied.body.status).toBe("error");
  expect(
    (await accept(client().status({ headers: fixture.headers }), [200])).body
      .authorization?.capabilities.payments,
  ).toBeTruthy();
});

test("projects saved methods and user limits without exposing credential or address fields", async () => {
  const fixture = await carrier();
  server.use(tokenHandler({ scope: "payment_methods.agentic userinfo:read" }));
  await connect(fixture);
  const method = {
    id: "pm_fixture",
    type: "card",
    name: "Visa",
    is_default: true,
    card_details: {
      brand: "visa",
      last4: "4242",
      exp_month: 12,
      exp_year: 2030,
      number: "private-pan",
      cvc: "private-cvc",
    },
    billing_address: { line1: "private-address" },
    access_token: "private-token",
    capabilities: {
      agentic_payments: { eligible: true, ineligibility_reasons: [] },
    },
  };
  const actionUrl =
    "https://app.link.com/identity_verification?session=keep%2Fexact";
  server.use(
    http.get("https://api.link.com/payment-details", () => {
      return HttpResponse.json({ payment_details: [method] });
    }),
    http.get("https://api.link.com/payment-details/pm_fixture", () => {
      return HttpResponse.json(method);
    }),
    http.get("https://api.link.com/payment-details/pm_missing", () => {
      return new HttpResponse(null, { status: 404 });
    }),
    http.get("https://api.link.com/userinfo", () => {
      return HttpResponse.json({
        id: "user_fixture",
        name: "Wallet User",
        email: "wallet@example.test",
        address: { line1: "private-address" },
        agent_wallet_spend_limits: {
          per_transaction: { limit: 5000 },
          daily: { limit: 10_000, used: 3500, remaining: 6500 },
          thirty_day: { limit: null, used: 3500, remaining: null },
        },
        agent_wallet_step_up: {
          status: "identity_verification",
          action_url: actionUrl,
        },
      });
    }),
  );
  const listed = await accept(
    client().paymentMethods({ headers: fixture.headers }),
    [200],
  );
  const retrieved = await accept(
    client().paymentMethod({
      headers: fixture.headers,
      params: { id: "pm_fixture" },
    }),
    [200],
  );
  expect(listed.body.data).toStrictEqual([retrieved.body]);
  const sessionMethods = await accept(
    userClient().paymentMethods({ headers: sessionHeaders }),
    [200],
  );
  expect(sessionMethods.body).toStrictEqual(listed.body);
  expect(sessionMethods.headers.get("cache-control")).toBe("no-store");
  await accept(
    userClient().paymentMethods({ headers: fixture.headers }),
    [403],
  );
  const bdd = createBddApi(context);
  const peer = bdd.user({ orgId: fixture.actor.orgId });
  const outsider = bdd.user();
  for (const other of [peer, outsider]) {
    mocks.clerk.session(other.userId, other.orgId, other.orgRole);
    await accept(
      userClient().paymentMethods({ headers: sessionHeaders }),
      [409],
    );
  }
  mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);
  expect(retrieved.body.card).toStrictEqual({
    brand: "visa",
    last4: "4242",
    expMonth: 12,
    expYear: 2030,
  });
  await accept(
    client().paymentMethod({
      headers: fixture.headers,
      params: { id: "pm_missing" },
    }),
    [404],
  );
  const info = await accept(
    client().userInfo({ headers: fixture.headers }),
    [200],
  );
  expect(info.body.spendLimits?.daily).toStrictEqual({
    limit: 10_000,
    used: 3500,
    remaining: 6500,
  });
  expect(info.body.verification?.actionUrl).toBe(actionUrl);
  expect(
    JSON.stringify([
      listed.body,
      sessionMethods.body,
      retrieved.body,
      info.body,
    ]),
  ).not.toMatch(/private-pan|private-cvc|private-token|private-address/);
  server.use(
    http.get("https://api.link.com/payment-details", () => {
      return HttpResponse.json({ payment_details: [] });
    }),
  );
  expect(
    (
      await accept(
        userClient().paymentMethods({ headers: sessionHeaders }),
        [200],
      )
    ).body,
  ).toStrictEqual({ data: [] });
});

test("paginates owner-isolated recorded spend history and retains it after reauthorization", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  const firstInput = purchase();
  const provider = spendProvider(firstInput);
  const first = await accept(
    client().createSpend({ headers: fixture.headers, body: firstInput }),
    [200],
  );
  provider.approve();
  provider.payload({
    payment_status_details: {
      outcome: "success",
      amount: 3000,
      currency: "usd",
      created: 1_791_936_000,
      refund_details: {
        amount: 500,
        currency: "usd",
        state: "succeeded",
        created: 1_791_936_100,
      },
    },
    payment_history: [
      {
        outcome: "failure",
        amount: 3000,
        currency: "usd",
        code: "card_declined",
        decline_code: "insufficient_funds",
      },
    ],
    card: { number: "private-pan" },
  });
  const updated = await accept(
    client().getSpend({
      headers: fixture.headers,
      params: { id: first.body.id },
    }),
    [200],
  );
  expect(updated.body.payment).toMatchObject({
    amount: 3000,
    outcome: "success",
    refund: { amount: 500 },
  });
  expect(updated.body.paymentHistory?.[0]?.declineCode).toBe(
    "insufficient_funds",
  );
  expect(updated.body.amount).toBe(3500);
  const secondInput = { ...purchase(), test: false };
  spendProvider(secondInput);
  const second = await accept(
    client().createSpend({ headers: fixture.headers, body: secondInput }),
    [200],
  );
  const one = await accept(
    client().listSpends({ headers: fixture.headers, query: { limit: 1 } }),
    [200],
  );
  expect(one.body.hasMore).toBeTruthy();
  const two = await accept(
    client().listSpends({
      headers: fixture.headers,
      query: { limit: 1, startingAfter: one.body.nextCursor ?? "" },
    }),
    [200],
  );
  expect(two.body.hasMore).toBeFalsy();
  expect(
    new Set(
      [...one.body.data, ...two.body.data].map((row) => {
        return row.id;
      }),
    ),
  ).toStrictEqual(new Set([first.body.id, second.body.id]));
  expect(one.body.data[0]).toMatchObject({
    statusSource: "recorded",
    canRefresh: true,
  });
  expect(
    (
      await accept(
        client().listSpends({
          headers: fixture.headers,
          query: { mode: "test", status: "approved" },
        }),
        [200],
      )
    ).body.data.map((row) => {
      return row.id;
    }),
  ).toStrictEqual([first.body.id]);
  const other = await carrier(true, fixture.actor);
  await connect(other);
  expect(
    (
      await accept(
        client().listSpends({ headers: other.headers, query: {} }),
        [200],
      )
    ).body.data,
  ).toStrictEqual([]);
  await accept(
    client().listSpends({
      headers: other.headers,
      query: { startingAfter: first.body.id },
    }),
    [400],
  );
  server.use(
    tokenHandler({
      scope: "userinfo:read",
      actions: ["read_link_transactions"],
    }),
  );
  await connect(fixture);
  const recorded = await accept(
    client().listSpends({ headers: fixture.headers, query: {} }),
    [200],
  );
  expect(recorded.body.data).toHaveLength(2);
  expect(
    recorded.body.data.every((row) => {
      return !row.canRefresh;
    }),
  ).toBeTruthy();
});

test("withholds wallet data if consent is revoked while a read is in flight", async () => {
  const fixture = await carrier();
  server.use(tokenHandler({ scope: "userinfo:read" }));
  await connect(fixture);
  const started = createDeferredPromise<void>(context.signal);
  const finish = createDeferredPromise<void>(context.signal);
  onTestFinished(() => {
    if (!finish.settled()) {
      finish.resolve();
    }
  });
  server.use(
    http.get("https://api.link.com/userinfo", async () => {
      started.resolve();
      await finish.promise;
      return HttpResponse.json({ name: "private-profile" });
    }),
    http.post("https://login.link.com/auth/revoke", () => {
      return new HttpResponse(null, { status: 200 });
    }),
  );
  const reading = client().userInfo({ headers: fixture.headers });
  await started.promise;
  await accept(
    client().disconnect({ headers: fixture.headers, body: {} }),
    [200],
  );
  finish.resolve();
  const result = await accept(reading, [409]);
  expect(result.body.error.code).toBe("WALLET_AUTHORIZATION_CHANGED");
  expect(JSON.stringify(result.body)).not.toContain("private-profile");
});

test.each([
  {
    name: "retains financial reads",
    scope: "userinfo:read financial_insights.transactions.read",
    actions: ["read_link_transactions"],
    status: 200 as const,
  },
  {
    name: "removes ungranted financial actions",
    scope: "userinfo:read",
    actions: [],
    status: 403 as const,
  },
])(
  "refreshing a grant without payment access $name",
  async ({ scope, actions, status }) => {
    const fixture = await carrier();
    server.use(
      tokenHandler({
        scope: "userinfo:read",
        actions: ["read_link_transactions"],
        expiresIn: 1,
      }),
    );
    await connect(fixture);
    let read = false;
    server.use(
      tokenHandler({ scope, actions }),
      http.get("https://api.link.com/transactions", () => {
        read = true;
        return HttpResponse.json({ data: [], has_more: false });
      }),
    );
    await accept(
      client().transactions({ headers: fixture.headers, query: {} }),
      [status],
    );
    expect(read).toBe(status === 200);
    const state = await accept(
      client().status({ headers: fixture.headers }),
      [200],
    );
    expect(state.body.authorization?.capabilities.payments).toBeFalsy();
    expect(state.body.authorization?.capabilities.transactions).toBe(
      status === 200,
    );
  },
);

test("reading a recorded request never sends an approval request; retrying its original purchase can recover", async () => {
  const fixture = await carrier();
  server.use(tokenHandler());
  await connect(fixture);
  const input = purchase();
  const provider = spendProvider(input);
  provider.payload({ status: "created", approval_url: undefined });
  const approvalPath =
    "https://api.link.com/spend_requests/:id/request_approval";
  server.use(
    http.post(approvalPath, () => {
      return HttpResponse.json(
        { error: "temporarily_unavailable" },
        { status: 503 },
      );
    }),
  );
  await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [502],
  );
  const history = await accept(
    client().listSpends({ headers: fixture.headers, query: {} }),
    [200],
  );
  const requestId = history.body.data[0]?.id;
  expect(requestId).toBeDefined();
  let approvalRequests = 0;
  const approvalUrl = "https://app.link.com/approve?request=fixture";
  server.use(
    http.post(approvalPath, () => {
      approvalRequests += 1;
      return HttpResponse.json({ id: provider.id, approval_link: approvalUrl });
    }),
  );
  const read = await accept(
    client().getSpend({
      headers: fixture.headers,
      params: { id: requestId ?? "" },
    }),
    [200],
  );
  expect(read.body.status).toBe("created");
  expect(read.body.approvalUrl).toBeNull();
  expect(approvalRequests).toBe(0);
  const resumed = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  expect(resumed.body.id).toBe(requestId);
  expect(resumed.body.approvalUrl).toBe(approvalUrl);
  expect(approvalRequests).toBe(1);
});

test("requests payment, profile and transaction consent from both CLI and settings", async () => {
  const fixture = await carrier();
  server.use(
    tokenHandler({
      scope:
        "payment_methods.agentic userinfo:read financial_insights.transactions.read",
    }),
  );
  for (const request of [
    () => {
      return client().connect({ headers: fixture.headers, body: {} });
    },
    () => {
      return userClient().connect({ headers: sessionHeaders, body: {} });
    },
  ]) {
    const started = await accept(request(), [200]);
    const url = new URL(started.body.url);
    const scopes = url.searchParams.get("scope")?.split(" ");
    expect(scopes).toStrictEqual(
      expect.arrayContaining(["payment_methods.agentic", "userinfo:read"]),
    );
    expect(
      JSON.parse(url.searchParams.get("authorization_details") ?? "null"),
    ).toStrictEqual([{ type: "source", actions: ["read_link_transactions"] }]);
    await accept(
      callbackClient().callback({
        headers: sessionHeaders,
        query: {
          state: url.searchParams.get("state") ?? "",
          code: "wallet-code-fixture",
          responseMode: "json",
        },
      }),
      [200],
    );
    expect(
      (await accept(userClient().status({ headers: sessionHeaders }), [200]))
        .body,
    ).toMatchObject({
      connectionStatus: "connected",
      scopeChange: null,
      authorization: {
        capabilities: { payments: true, userInfo: true, transactions: true },
      },
    });
  }
});

const APPROVAL_WORKER_SECRET = randomBytes(32).toString("hex");

async function trackedPurchase(startFails = false, expiresIn = 3600) {
  await setupApp({ context, routes: walletRoutes, isolatePg: true });
  const fixture = await carrier();
  mockEnv("LINK_APPROVAL_WORKER_URL", "https://approval.example.test");
  mockEnv("LINK_APPROVAL_WORKER_SECRET", APPROVAL_WORKER_SECRET);
  mockEnv(
    "LINK_APPROVAL_CONTROL_SECRET",
    "link-approval-control-test-secret-0002",
  );
  await updateFeatureSwitchesForUser(context, fixture.actor, {
    [FeatureSwitchKey.LinkWalletApprovalContinuation]: true,
  });
  const starts: unknown[] = [];
  server.use(
    tokenHandler({ expiresIn }),
    http.post("https://approval.example.test/start", async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer link-approval-control-test-secret-0002",
      );
      starts.push(await request.json());
      return startFails && starts.length === 1
        ? HttpResponse.json(
            { error: "Temporary Worker outage" },
            { status: 503 },
          )
        : HttpResponse.json({ ok: true });
    }),
  );
  await connect(fixture);
  const input = purchase();
  const provider = spendProvider(input);
  const created = await accept(
    client().createSpend({ headers: fixture.headers, body: input }),
    [200],
  );
  await flushWaitUntilForTest();
  expect(created.body.autoContinue).toBeTruthy();
  expect(starts).toStrictEqual([
    { spendId: created.body.id, deadline: created.body.expiresAt },
  ]);
  return { ...fixture, input, provider, spend: created.body, starts };
}

async function pollPurchase(
  spendId: string,
  options: { timestamp?: string; signature?: string } = {},
) {
  const body = JSON.stringify({ spendId });
  const timestamp = options.timestamp ?? String(Math.floor(now() / 1000));
  const signature =
    options.signature ??
    createHmac("sha256", APPROVAL_WORKER_SECRET)
      .update(`${timestamp}.${body}`)
      .digest("hex");
  return await setupRawAppRequest({
    context,
    routes: linkApprovalWorkflowRoutes,
  })("/api/internal/link-approval/poll", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-link-approval-timestamp": timestamp,
      "x-link-approval-signature": signature,
    },
    body,
  });
}

async function approvalCard(
  fixture: Awaited<ReturnType<typeof trackedPurchase>>,
  threadId = fixture.run.threadId,
) {
  return await accept(
    userClient().spendStatus({
      headers: sessionHeaders,
      body: {
        agentId: fixture.agentId,
        threadId,
        approvalUrl: fixture.spend.approvalUrl ?? "https://app.link.com/",
      },
    }),
    [200],
  );
}

test("an approval Workflow continues the original web chat once and retains interactive wallet access", async () => {
  const fixture = await trackedPurchase();
  expect((await approvalCard(fixture)).body.status).toBe("pending");
  expect((await approvalCard(fixture, randomUUID())).body.status).toBe(
    "unavailable",
  );
  expect((await pollPurchase(fixture.spend.id)).body).toStrictEqual({
    state: "waiting",
  });
  fixture.provider.approve();
  // The original run must be allowed to finish presenting the approval URL.
  expect((await pollPurchase(fixture.spend.id)).body).toStrictEqual({
    state: "waiting",
  });
  expect((await approvalCard(fixture)).body.status).toBe("approved");
  await fixture.complete();
  const responses = await Promise.all([
    pollPurchase(fixture.spend.id),
    pollPurchase(fixture.spend.id),
  ]);
  for (const response of responses) {
    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ state: "done" });
  }
  await flushWaitUntilForTest();
  expect((await approvalCard(fixture)).body.status).toBe("continued");
  const { events } = await createChatFilesBddApi(context).listThreadEvents(
    fixture.actor,
    fixture.run.threadId,
  );
  const input = events.filter((event) => {
    return event.id === fixture.spend.id;
  });
  expect(input).toHaveLength(1);
  expect(JSON.stringify(input)).toContain(
    "Link 付款审批已通过：Example Books，金额上限 35.00 USD。请继续完成这笔购买。",
  );
  expect(JSON.stringify(input)).not.toMatch(
    /wallet-access-fixture|wallet-refresh-fixture|card_number/,
  );
  const resumed = events.find((event) => {
    return event.revokesEventId === fixture.spend.id;
  });
  expect(resumed?.runId).toBeTruthy();
  if (!resumed?.runId) {
    throw new Error("Missing approval continuation run");
  }
  const claim = await fixture.api.claimRunnerJob(resumed.runId);
  const headers = {
    authorization: `Bearer ${claim.platformEnvironment.OKOU_TOKEN}`,
  };
  await accept(
    client().getSpend({ headers, params: { id: fixture.spend.id } }),
    [200],
  );
  expect((await pollPurchase(fixture.spend.id)).body).toStrictEqual({
    state: "done",
  });
});

test("manual approved-status inspection consumes the purchase continuation before a Workflow can enqueue it", async () => {
  const fixture = await trackedPurchase();
  fixture.provider.approve();
  await accept(
    client().getSpend({
      headers: fixture.headers,
      params: { id: fixture.spend.id },
    }),
    [200],
  );
  await fixture.complete();
  expect((await pollPurchase(fixture.spend.id)).body).toStrictEqual({
    state: "done",
  });
  await flushWaitUntilForTest();
  const { events } = await createChatFilesBddApi(context).listThreadEvents(
    fixture.actor,
    fixture.run.threadId,
  );
  expect(
    events.some((event) => {
      return (
        event.revokesEventId === fixture.spend.id &&
        event.eventType === "control.revoke"
      );
    }),
  ).toBeTruthy();
  expect(JSON.stringify(events)).not.toContain("Link 付款审批已通过");
});

test("pending manual inspection does not stop the watch and a cancelled purchase never continues", async () => {
  const fixture = await trackedPurchase();
  await accept(
    client().getSpend({
      headers: fixture.headers,
      params: { id: fixture.spend.id },
    }),
    [200],
  );
  expect((await pollPurchase(fixture.spend.id)).body).toStrictEqual({
    state: "waiting",
  });
  await accept(
    client().cancelSpend({
      headers: fixture.headers,
      params: { id: fixture.spend.id },
    }),
    [200],
  );
  await fixture.complete();
  expect((await pollPurchase(fixture.spend.id)).body).toStrictEqual({
    state: "done",
  });
});

test("cancelling a watched purchase from another chat fails before contacting Link", async () => {
  const fixture = await trackedPurchase();
  await fixture.complete();
  const other = await fixture.api.createThreadRun(fixture.actor, {
    agentId: fixture.agentId,
    prompt: "Inspect an existing purchase from another chat",
  });
  await fixture.api.heartbeatRunner(fixture.runnerGroup);
  const claim = await fixture.api.claimRunnerJob(other.runId);
  onTestFinished(async () => {
    await fixture.api.requestCancelRun(fixture.actor, other.runId, [200]);
    await createWebhookCallbackApi(context).requestAgentComplete(
      {
        runId: other.runId,
        exitCode: 1,
        error: "Wallet test carrier canceled",
      },
      { authorization: `Bearer ${claim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
  });
  const headers = {
    authorization: `Bearer ${claim.platformEnvironment.OKOU_TOKEN}`,
  };
  let cancellations = 0;
  server.use(
    http.post(
      `https://api.link.com/spend_requests/${fixture.provider.id}/cancel`,
      () => {
        cancellations++;
        return HttpResponse.json({}, { status: 503 });
      },
    ),
  );
  await accept(
    client().getSpend({ headers, params: { id: fixture.spend.id } }),
    [200],
  );
  const result = await accept(
    client().cancelSpend({ headers, params: { id: fixture.spend.id } }),
    [409],
  );
  expect(result.body.error.code).toBe("WALLET_ORIGINAL_THREAD_REQUIRED");
  expect(cancellations).toBe(0);
  expect((await pollPurchase(fixture.spend.id)).body).toStrictEqual({
    state: "waiting",
  });
});

test("a final approval observation uses the original deadline and timeout never invents a denial", async () => {
  const fixture = await trackedPurchase();
  mockNow(new Date(fixture.spend.expiresAt).getTime());
  expect((await pollPurchase(fixture.spend.id)).body).toStrictEqual({
    state: "done",
  });
  const current = await accept(
    client().getSpend({
      headers: fixture.headers,
      params: { id: fixture.spend.id },
    }),
    [200],
  );
  expect(current.body.status).toBe("pending_approval");
  expect(current.body.autoContinue).toBeFalsy();
  expect((await approvalCard(fixture)).body.status).toBe("stopped");
  fixture.provider.approve();
  await fixture.complete();
  mockNow(new Date(fixture.spend.expiresAt).getTime() + 120_001);
  expect((await pollPurchase(fixture.spend.id)).body).toStrictEqual({
    state: "done",
  });
  const { events } = await createChatFilesBddApi(context).listThreadEvents(
    fixture.actor,
    fixture.run.threadId,
  );
  expect(
    events.some((event) => {
      return event.id === fixture.spend.id;
    }),
  ).toBeFalsy();
});

test("an approved purchase waiting for its active chat notifies the card when automatic waiting expires", async () => {
  const fixture = await trackedPurchase();
  fixture.provider.approve();
  expect((await pollPurchase(fixture.spend.id)).body).toStrictEqual({
    state: "waiting",
  });
  expect((await approvalCard(fixture)).body.status).toBe("approved");
  await flushWaitUntilForTest();
  context.mocks.ably.publish.mockClear();

  mockNow(new Date(fixture.spend.expiresAt).getTime());
  expect((await pollPurchase(fixture.spend.id)).body).toStrictEqual({
    state: "waiting",
  });
  await flushWaitUntilForTest();
  expect(context.mocks.ably.publish).toHaveBeenCalledWith("wallet:changed", {
    orgId: fixture.actor.orgId,
  });
  expect((await approvalCard(fixture)).body.status).toBe("stopped");
});

test("approval callbacks authenticate exact bodies and stop after the feature is disabled", async () => {
  const fixture = await trackedPurchase();
  expect(
    (await pollPurchase(fixture.spend.id, { signature: "0".repeat(64) }))
      .status,
  ).toBe(401);
  expect(
    (
      await pollPurchase(fixture.spend.id, {
        timestamp: String(Math.floor(now() / 1000) - 301),
      })
    ).status,
  ).toBe(401);
  await updateFeatureSwitchesForUser(context, fixture.actor, {
    [FeatureSwitchKey.LinkWalletApprovalContinuation]: false,
  });
  const pending = await accept(
    client().getSpend({
      headers: fixture.headers,
      params: { id: fixture.spend.id },
    }),
    [200],
  );
  expect(pending.body.autoContinue).toBeFalsy();
  const repeated = await accept(
    client().createSpend({ headers: fixture.headers, body: fixture.input }),
    [200],
  );
  expect(repeated.body.autoContinue).toBeFalsy();
  await flushWaitUntilForTest();
  expect(fixture.starts).toHaveLength(1);
  fixture.provider.approve();
  await fixture.complete();
  expect((await pollPurchase(fixture.spend.id)).body).toStrictEqual({
    state: "done",
  });
});

test("cron repairs a failed durable approval Workflow start without querying Link", async () => {
  const fixture = await trackedPurchase(true);
  let reads = 0;
  server.use(
    http.get(
      `https://api.link.com/spend_requests/${fixture.provider.id}`,
      () => {
        reads++;
        return HttpResponse.json(
          { error: { message: "Unexpected provider poll" } },
          { status: 500 },
        );
      },
    ),
  );
  await accept(
    setupApp({ context, routes: cronProcessBackgroundJobsRoutes })(
      cronProcessBackgroundJobsContract,
    ).process({
      headers: { authorization: "Bearer test-cron-secret" },
    }),
    [200],
  );
  expect(fixture.starts).toStrictEqual([
    { spendId: fixture.spend.id, deadline: fixture.spend.expiresAt },
    { spendId: fixture.spend.id, deadline: fixture.spend.expiresAt },
  ]);
  expect(reads).toBe(0);
});

test("approval polling distinguishes resumable Link actions from actions requiring a new approval", async () => {
  const fixture = await trackedPurchase();
  fixture.provider.payload({
    status: "requires_action",
    status_details: {
      requires_action: {
        next_action: {
          type: "payment_method_update",
          resolution: "auto_resume",
          action_url: "https://app.link.com/payment-methods",
        },
      },
    },
  });
  expect((await pollPurchase(fixture.spend.id)).body).toStrictEqual({
    state: "waiting",
  });
  expect((await approvalCard(fixture)).body.status).toBe("pending");
  fixture.provider.payload({
    status: "requires_action",
    status_details: {
      requires_action: {
        next_action: {
          type: "payment_method_update",
          resolution: "create_new_spend_request",
          action_url: "https://app.link.com/payment-methods",
        },
      },
    },
  });
  expect((await pollPurchase(fixture.spend.id)).body).toStrictEqual({
    state: "done",
  });
  expect((await approvalCard(fixture)).body.status).toBe("stopped");
});

test("approval polling waits while a manual query rotates the same wallet grant", async () => {
  const fixture = await trackedPurchase(false, 120);
  mockNow(now() + 65_000);
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  server.use(
    http.post("https://login.link.com/auth/token", async () => {
      entered.resolve();
      await release.promise;
      return HttpResponse.json({
        access_token: "wallet-rotated-access-fixture",
        refresh_token: "wallet-rotated-refresh-fixture",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "payment_methods.agentic userinfo:read",
        authorization_details: [
          { type: "source", actions: ["read_link_transactions"] },
        ],
      });
    }),
  );
  const manual = client().getSpend({
    headers: fixture.headers,
    params: { id: fixture.spend.id },
  });
  await entered.promise;
  const duringRefresh = await pollPurchase(fixture.spend.id);
  release.resolve();
  expect((await manual).status).toBe(200);
  expect(duringRefresh.body).toStrictEqual({ state: "waiting" });
  expect((await pollPurchase(fixture.spend.id)).body).toStrictEqual({
    state: "waiting",
  });
});

test("a provider outage remains retryable and cannot manufacture approval or denial", async () => {
  const fixture = await trackedPurchase();
  server.use(
    http.get(
      `https://api.link.com/spend_requests/${fixture.provider.id}`,
      () => {
        return HttpResponse.json(
          { error: { message: "Temporarily unavailable" } },
          { status: 503 },
        );
      },
    ),
  );
  const response = await pollPurchase(fixture.spend.id);
  expect(response.status).toBe(500);
  expect(response.body).not.toStrictEqual({ state: "done" });
  expect((await approvalCard(fixture)).body.status).toBe("pending");

  await flushWaitUntilForTest();
  context.mocks.ably.publish.mockClear();
  mockNow(new Date(fixture.spend.expiresAt).getTime());
  expect((await pollPurchase(fixture.spend.id)).status).toBe(500);
  await flushWaitUntilForTest();
  expect(context.mocks.ably.publish).toHaveBeenCalledWith("wallet:changed", {
    orgId: fixture.actor.orgId,
  });
  expect((await approvalCard(fixture)).body.status).toBe("stopped");
});

test("a disconnected grant stops the approval watch and cannot start a purchase run", async () => {
  const fixture = await trackedPurchase();
  server.use(
    http.post("https://login.link.com/auth/revoke", () => {
      return HttpResponse.json({});
    }),
  );
  await accept(
    client().disconnect({ headers: fixture.headers, body: {} }),
    [200],
  );
  fixture.provider.approve();
  await fixture.complete();
  expect((await pollPurchase(fixture.spend.id)).body).toStrictEqual({
    state: "done",
  });
  const { events } = await createChatFilesBddApi(context).listThreadEvents(
    fixture.actor,
    fixture.run.threadId,
  );
  expect(
    events.some((event) => {
      return event.id === fixture.spend.id;
    }),
  ).toBeFalsy();
});
