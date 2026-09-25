import {
  bankingContract,
  bankingPublicContract,
  bankingUserContract,
} from "@okouai/api-contracts/contracts/banking";
import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  bankingAccounts$,
  bankingBalances$,
  bankingTransactions$,
} from "../services/banking.service";
import {
  bankingAccessRequestStatus$,
  handleFinicityWebhook$,
  revokeBankingAgentGrant$,
  saveBankingAgentGrant$,
  startBankingConnectSession$,
  verifyFinicityWebhookSignature,
} from "../services/banking-connect.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { env } from "../../lib/env";

function okouTokenRequired() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Banking gateway access requires an agent run token",
        code: "FORBIDDEN",
      },
    },
  };
}

const bankingDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Banking is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const bankingEnabled$ = command(async ({ get }) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.Banking, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
});

const accountsBody$ = bodyResultOf(bankingContract.accounts);
const balancesBody$ = bodyResultOf(bankingContract.balances);
const transactionsBody$ = bodyResultOf(bankingContract.transactions);
const accessRequestParams$ = pathParamsOf(
  bankingUserContract.accessRequestStatus,
);
const connectSessionBody$ = bodyResultOf(
  bankingUserContract.createConnectSession,
);
const saveGrantBody$ = bodyResultOf(bankingUserContract.saveAgentGrant);
const revokeGrantBody$ = bodyResultOf(bankingUserContract.revokeAgentGrant);

const accountsInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    return okouTokenRequired();
  }
  if (!(await set(bankingEnabled$))) {
    return bankingDisabled;
  }
  signal.throwIfAborted();

  const bodyResult = await get(accountsBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  return await set(bankingAccounts$, { auth, body: bodyResult.data }, signal);
});

const balancesInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    return okouTokenRequired();
  }
  if (!(await set(bankingEnabled$))) {
    return bankingDisabled;
  }
  signal.throwIfAborted();

  const bodyResult = await get(balancesBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  return await set(bankingBalances$, { auth, body: bodyResult.data }, signal);
});

const transactionsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "agent") {
      return okouTokenRequired();
    }
    if (!(await set(bankingEnabled$))) {
      return bankingDisabled;
    }
    signal.throwIfAborted();

    const bodyResult = await get(transactionsBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    return await set(
      bankingTransactions$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

const bankingAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "banking:read",
  accept: ["agent"],
} as const;

const bankingUserAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;

const accessRequestStatusInner$ = command(async ({ get, set }) => {
  if (!(await set(bankingEnabled$))) {
    return bankingDisabled;
  }
  const auth = get(organizationAuthContext$);
  const params = get(accessRequestParams$);
  return await set(bankingAccessRequestStatus$, {
    owner: { orgId: auth.orgId, userId: auth.userId },
    agentId: params.agentId,
  });
});

const createConnectSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await set(bankingEnabled$))) {
      return bankingDisabled;
    }
    const body = await get(connectSessionBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const configuredAppUrl = env("APP_URL");
    const redirectOrigin = new URL(configuredAppUrl).origin;
    const webhookOrigin = new URL(
      env("FINICITY_WEBHOOK_BASE_URL") ?? configuredAppUrl,
    ).origin;
    return await set(
      startBankingConnectSession$,
      {
        owner: { orgId: auth.orgId, userId: auth.userId },
        body: body.data,
        redirectOrigin,
        webhookOrigin,
      },
      signal,
    );
  },
);

const saveAgentGrantInner$ = command(async ({ get, set }) => {
  if (!(await set(bankingEnabled$))) {
    return bankingDisabled;
  }
  const body = await get(saveGrantBody$);
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  return await set(saveBankingAgentGrant$, {
    owner: { orgId: auth.orgId, userId: auth.userId },
    body: body.data,
  });
});

const revokeAgentGrantInner$ = command(async ({ get, set }) => {
  if (!(await set(bankingEnabled$))) {
    return bankingDisabled;
  }
  const body = await get(revokeGrantBody$);
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  return await set(revokeBankingAgentGrant$, {
    owner: { orgId: auth.orgId, userId: auth.userId },
    agentId: body.data.agentId,
  });
});

const connectReturn$ = command(() => {
  const { assistantName } = PUBLIC_BRAND_PRESENTATION;
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Return to ${assistantName}</title>
  </head>
  <body style="font-family:ui-sans-serif,system-ui,sans-serif;margin:0;display:grid;min-height:100vh;place-items:center;background:#fafafa;color:#18181b">
    <main style="max-width:28rem;padding:2rem;text-align:center">
      <h1 style="font-size:1.25rem;margin:0 0 .75rem">Return to Chat</h1>
      <p style="color:#71717a;line-height:1.5;margin:0">You can close this window and continue in ${assistantName} Chat.</p>
    </main>
    <script>window.close()</script>
  </body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
    },
  });
});

const finicityWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    if (!env("FINICITY_APP_SECRET")) {
      return Response.json(
        { error: "Mastercard Open Finance is not configured" },
        { status: 503 },
      );
    }
    const request = get(request$);
    const signature = request.raw.headers.get("x-finicity-signature");
    const rawBody = await request.text();
    signal.throwIfAborted();
    if (!signature || !verifyFinicityWebhookSignature(rawBody, signature)) {
      return Response.json(
        { error: "Invalid webhook signature" },
        { status: 401 },
      );
    }
    const result = await set(handleFinicityWebhook$, rawBody, signal);
    if (result.kind === "bad_request") {
      return Response.json(
        { error: "Invalid Mastercard webhook event" },
        { status: 400 },
      );
    }
    if (result.kind === "processing_failed") {
      return Response.json(
        { error: "Mastercard webhook processing failed" },
        { status: 500 },
      );
    }
    return new Response("OK", { status: 200 });
  },
);

export const bankingRoutes: readonly RouteEntry[] = [
  {
    route: bankingContract.accounts,
    handler: authRoute(bankingAuth, accountsInner$),
  },
  {
    route: bankingContract.balances,
    handler: authRoute(bankingAuth, balancesInner$),
  },
  {
    route: bankingContract.transactions,
    handler: authRoute(bankingAuth, transactionsInner$),
  },
  {
    route: bankingUserContract.accessRequestStatus,
    handler: authRoute(bankingUserAuth, accessRequestStatusInner$),
  },
  {
    route: bankingUserContract.createConnectSession,
    handler: authRoute(bankingUserAuth, createConnectSessionInner$),
  },
  {
    route: bankingUserContract.saveAgentGrant,
    handler: authRoute(bankingUserAuth, saveAgentGrantInner$),
  },
  {
    route: bankingUserContract.revokeAgentGrant,
    handler: authRoute(bankingUserAuth, revokeAgentGrantInner$),
  },
  {
    route: bankingPublicContract.connectReturn,
    handler: connectReturn$,
  },
  {
    route: bankingPublicContract.finicityWebhook,
    handler: finicityWebhook$,
  },
];
