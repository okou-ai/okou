import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { feishuBrowserConnectContract } from "@okouai/api-contracts/contracts/feishu-browser-connect";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { env } from "../../lib/env";
import {
  organizationAuthContext$,
  requiredAuthContext$,
} from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { startCustomConnectorOAuth2$ } from "../services/custom-connector-oauth2.service";
import {
  ensureFeishuCustomConnector$,
  hasFeishuCustomConnectorOAuthConnection,
  resolveFeishuConnectorAccountMutation,
} from "../services/feishu-custom-connector.service";
import {
  isFeishuInstallationEnabled,
  feishuBotOpenUrl,
  feishuOAuthAppCallbackUrl,
} from "../services/feishu-config";
import { verifyFeishuConnectToken } from "../services/feishu-connect-token";

const REDIRECT_STATUS = 307;

function redirect(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url },
  });
}

function worksRedirect(params: Readonly<Record<string, string>>): Response {
  return redirect(`${env("APP_URL")}/works?${new URLSearchParams(params)}`);
}

interface FeishuConnectArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly installationId: string;
  readonly openId: string;
  readonly chatId: string;
  readonly ts: number;
  readonly sig: string;
}

type FeishuConnectResult =
  | { readonly kind: "invalid" }
  | { readonly kind: "installation_not_found" }
  | { readonly kind: "setup_incomplete" }
  | { readonly kind: "wrong_organization" }
  | {
      readonly kind: "success";
      readonly authorizationUrl: string;
      readonly botName: string | null;
    };

const startFeishuAccountOAuth$ = command(
  async (
    { set },
    args: FeishuConnectArgs,
    signal: AbortSignal,
  ): Promise<FeishuConnectResult> => {
    if (
      !verifyFeishuConnectToken({
        installationId: args.installationId,
        openId: args.openId,
        chatId: args.chatId,
        timestamp: args.ts,
        signature: args.sig,
      })
    ) {
      return { kind: "invalid" };
    }

    const db = set(writeDb$);
    const [installation] = await db
      .select({
        orgId: feishuOrgInstallations.orgId,
        platform: feishuOrgInstallations.platform,
        ownerUserId: feishuOrgInstallations.ownerUserId,
        botName: feishuOrgInstallations.botName,
        publicBrand: feishuOrgInstallations.publicBrand,
        setupCompletedAt: feishuOrgInstallations.setupCompletedAt,
      })
      .from(feishuOrgInstallations)
      .where(eq(feishuOrgInstallations.id, args.installationId))
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return { kind: "installation_not_found" };
    }
    if (args.orgId !== installation.orgId) {
      return { kind: "wrong_organization" };
    }
    if (!(await isFeishuInstallationEnabled(db, installation))) {
      return { kind: "installation_not_found" };
    }
    if (!installation.setupCompletedAt) {
      return { kind: "setup_incomplete" };
    }

    const connectorId = await set(
      ensureFeishuCustomConnector$,
      {
        orgId: args.orgId,
        userId: args.userId,
        installationId: args.installationId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!connectorId) {
      return { kind: "installation_not_found" };
    }
    const account = await resolveFeishuConnectorAccountMutation(db, {
      installationId: args.installationId,
      userId: args.userId,
    });
    signal.throwIfAborted();
    const oauth = await set(
      startCustomConnectorOAuth2$,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorId,
        redirectUri: feishuOAuthAppCallbackUrl(installation.platform),
        publicBrand: installation.publicBrand,
        account,
        feishuContext: {
          installationId: args.installationId,
          expectedOpenId: args.openId,
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in oauth) {
      return { kind: "installation_not_found" };
    }
    if (oauth.result !== "authorization") {
      throw new Error(
        "Feishu Custom OAuth unexpectedly completed without OAuth",
      );
    }
    return {
      kind: "success",
      authorizationUrl: oauth.authorizationUrl,
      botName: installation.botName,
    };
  },
);

function legacyConnectResult(result: FeishuConnectResult): Response {
  switch (result.kind) {
    case "invalid": {
      return worksRedirect({ feishuError: "Invalid or expired connect link" });
    }
    case "installation_not_found": {
      return worksRedirect({ feishuError: "Bot installation not found" });
    }
    case "setup_incomplete": {
      return worksRedirect({
        feishuError: "Finish setting up this bot before connecting",
      });
    }
    case "wrong_organization": {
      return worksRedirect({
        feishuError: "Switch to the organization connected to this bot",
      });
    }
    case "success": {
      return redirect(result.authorizationUrl);
    }
  }
}

const connect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  const auth = await set(requiredAuthContext$, {}, signal);
  if ("status" in auth) {
    const signIn = new URL("/sign-in", env("APP_URL"));
    signIn.searchParams.set("redirect_url", request.url);
    return redirect(signIn.toString());
  }
  const query = get(queryOf(feishuBrowserConnectContract.connect));
  const { installationId, openId, chatId, ts, sig } = query;
  if (!installationId || !openId || !chatId || ts === undefined || !sig) {
    return worksRedirect({ feishuError: "Invalid or expired connect link" });
  }
  if (!auth.orgId) {
    return worksRedirect({
      feishuError: "Switch to the organization connected to this bot",
    });
  }
  const result = await set(
    startFeishuAccountOAuth$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      installationId,
      openId,
      chatId,
      ts,
      sig,
    },
    signal,
  );
  return legacyConnectResult(result);
});

const connectFromApp$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(
    bodyResultOf(feishuBrowserConnectContract.connectFromApp),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const result = await set(
    startFeishuAccountOAuth$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      ...bodyResult.data,
    },
    signal,
  );
  signal.throwIfAborted();

  switch (result.kind) {
    case "invalid": {
      return badRequestMessage("Invalid or expired bot connect link");
    }
    case "installation_not_found": {
      return notFound("Bot installation not found");
    }
    case "setup_incomplete": {
      return badRequestMessage("Finish setting up this bot before connecting");
    }
    case "wrong_organization": {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Switch to the organization connected to this bot",
            code: "FORBIDDEN" as const,
          },
        },
      };
    }
    case "success": {
      return {
        status: 200 as const,
        body: {
          success: true as const,
          botName: result.botName,
          openUrl: result.authorizationUrl,
        },
      };
    }
  }
});

const getStatus$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(feishuBrowserConnectContract.getStatus));
  if (
    !verifyFeishuConnectToken({
      installationId: query.installationId,
      openId: query.openId,
      chatId: query.chatId,
      timestamp: query.ts,
      signature: query.sig,
    })
  ) {
    return badRequestMessage("Invalid or expired bot connect link");
  }

  const db = set(writeDb$);
  const [installation] = await db
    .select({
      orgId: feishuOrgInstallations.orgId,
      platform: feishuOrgInstallations.platform,
      ownerUserId: feishuOrgInstallations.ownerUserId,
      appId: feishuOrgInstallations.appId,
      botName: feishuOrgInstallations.botName,
    })
    .from(feishuOrgInstallations)
    .where(eq(feishuOrgInstallations.id, query.installationId))
    .limit(1);
  signal.throwIfAborted();
  if (!installation) {
    return notFound("Bot installation not found");
  }
  if (!(await isFeishuInstallationEnabled(db, installation))) {
    return notFound("Bot integration is unavailable");
  }
  if (installation.orgId !== auth.orgId) {
    return {
      status: 403 as const,
      body: {
        error: {
          message: "Switch to the organization connected to this bot",
          code: "FORBIDDEN" as const,
        },
      },
    };
  }
  const [connection] = await db
    .select({
      userId: feishuOrgConnections.userId,
      connectorId: feishuOrgConnections.connectorId,
    })
    .from(feishuOrgConnections)
    .where(
      and(
        eq(feishuOrgConnections.installationId, query.installationId),
        eq(feishuOrgConnections.feishuOpenId, query.openId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (connection && connection.userId !== auth.userId) {
    return conflict("This account is already connected");
  }
  const isConnected =
    connection?.userId === auth.userId &&
    (await hasFeishuCustomConnectorOAuthConnection(db, {
      orgId: auth.orgId,
      userId: auth.userId,
      installationId: query.installationId,
      memberConnectorId: connection.connectorId,
      feishuOpenId: query.openId,
    }));
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      isConnected,
      botName: installation.botName,
      openUrl: feishuBotOpenUrl(installation.appId, installation.platform),
    },
  };
});

export const feishuBrowserConnectRoutes: readonly RouteEntry[] = [
  {
    route: feishuBrowserConnectContract.connect,
    handler: connect$,
  },
  {
    route: feishuBrowserConnectContract.connectFromApp,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      connectFromApp$,
    ),
  },
  {
    route: feishuBrowserConnectContract.getStatus,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getStatus$,
    ),
  },
];
