import {
  bankingContract,
  bankingPublicContract,
  bankingWorkspaceContract,
} from "@okouai/api-contracts/contracts/banking";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { command, computed } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  bankingAccounts$,
  bankingBalances$,
  bankingTransactions$,
} from "../services/banking.service";
import {
  bankingAccessRequestStatus$,
  handleFinicityWebhook$,
  revokeBankingGrant$,
  saveBankingGrant$,
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
const connectSessionBody$ = bodyResultOf(
  bankingWorkspaceContract.createConnectSession,
);
const saveGrantBody$ = bodyResultOf(bankingWorkspaceContract.saveGrant);
const revokeGrantBody$ = bodyResultOf(bankingWorkspaceContract.revokeGrant);

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

const bankingOwner$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return { orgId: auth.orgId, userId: auth.userId };
});

const accessRequestStatus$ = command(async ({ get, set }) => {
  if (!(await set(bankingEnabled$))) {
    return bankingDisabled;
  }
  return await set(bankingAccessRequestStatus$, { owner: get(bankingOwner$) });
});

const connectSession$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(bankingEnabled$))) {
    return bankingDisabled;
  }
  const body = await get(connectSessionBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const owner = get(bankingOwner$);
  const configuredAppUrl = env("APP_URL");
  const redirectOrigin = new URL(configuredAppUrl).origin;
  const webhookOrigin = new URL(
    env("FINICITY_WEBHOOK_BASE_URL") ?? configuredAppUrl,
  ).origin;
  return await set(
    startBankingConnectSession$,
    {
      owner,
      body: body.data,
      redirectOrigin,
      webhookOrigin,
    },
    signal,
  );
});

const saveGrant$ = command(async ({ get, set }) => {
  if (!(await set(bankingEnabled$))) {
    return bankingDisabled;
  }
  const body = await get(saveGrantBody$);
  if (!body.ok) {
    return body.response;
  }
  const owner = get(bankingOwner$);
  return await set(saveBankingGrant$, {
    owner,
    body: body.data,
  });
});

const revokeGrant$ = command(async ({ get, set }) => {
  if (!(await set(bankingEnabled$))) {
    return bankingDisabled;
  }
  const body = await get(revokeGrantBody$);
  if (!body.ok) {
    return body.response;
  }
  const owner = get(bankingOwner$);
  return await set(revokeBankingGrant$, {
    owner,
  });
});

const connectReturn$ = command(() => {
  const { assistantName } = BRAND_PRESENTATION;
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
    route: bankingWorkspaceContract.accessRequestStatus,
    handler: authRoute(bankingUserAuth, accessRequestStatus$),
  },
  {
    route: bankingWorkspaceContract.createConnectSession,
    handler: authRoute(bankingUserAuth, connectSession$),
  },
  {
    route: bankingWorkspaceContract.saveGrant,
    handler: authRoute(bankingUserAuth, saveGrant$),
  },
  {
    route: bankingWorkspaceContract.revokeGrant,
    handler: authRoute(bankingUserAuth, revokeGrant$),
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
