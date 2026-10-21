import { connectors } from "@okouai/db/schema/connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { secrets } from "@okouai/db/schema/secret";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { feishuBrowserConnectContract } from "@okouai/api-contracts/contracts/feishu-browser-connect";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";

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
  ensureManagedFeishuConnector$,
  feishuOAuthMemberReadPlan,
  feishuOAuthMemberFromRows,
  feishuOAuthInstallationReadPlan,
  feishuOAuthAccountReadPlan,
  feishuOAuthAccountFromRows,
  feishuOAuthCredentialReadPlan,
  feishuConnectorAccountMutationReadPlan,
  feishuConnectorAccountMutationFromRows,
} from "../services/feishu-custom-connector.service";
import {
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
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
    if (
      !(await (async () => {
        const plan = feishuInstallationAvailabilityReadPlan(installation);
        if (plan.kind === "resolved") {
          return plan.enabled;
        }
        const rows = await db
          .select(plan.columns)
          .from(userFeatureSwitches)
          .where(plan.condition);
        return feishuInstallationEnabledFromRows(plan.scope, rows);
      })())
    ) {
      return { kind: "installation_not_found" };
    }
    if (!installation.setupCompletedAt) {
      return { kind: "setup_incomplete" };
    }

    const connectorId = await set(
      ensureManagedFeishuConnector$,
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
    const accountPlan = feishuConnectorAccountMutationReadPlan({
      installationId: args.installationId,
      userId: args.userId,
    });
    const account = feishuConnectorAccountMutationFromRows(
      await db
        .select(accountPlan.columns)
        .from(feishuOrgConnections)
        .where(accountPlan.condition)
        .limit(2),
    );
    signal.throwIfAborted();
    const oauth = await set(
      startCustomConnectorOAuth2$,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorId,
        redirectUri: feishuOAuthAppCallbackUrl(installation.platform),
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

function browserInstallationReadPlan(installationId: string) {
  return {
    columns: {
      orgId: feishuOrgInstallations.orgId,
      platform: feishuOrgInstallations.platform,
      ownerUserId: feishuOrgInstallations.ownerUserId,
      appId: feishuOrgInstallations.appId,
      botName: feishuOrgInstallations.botName,
    },
    condition: eq(feishuOrgInstallations.id, installationId),
  };
}

function browserMemberReadPlan(query: {
  readonly installationId: string;
  readonly openId: string;
}) {
  return {
    columns: {
      userId: feishuOrgConnections.userId,
      connectorId: feishuOrgConnections.connectorId,
    },
    condition: and(
      eq(feishuOrgConnections.installationId, query.installationId),
      eq(feishuOrgConnections.feishuOpenId, query.openId),
    ),
  };
}

function wrongFeishuOrganization() {
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

function feishuBrowserStatus(
  installation: Pick<
    typeof feishuOrgInstallations.$inferSelect,
    "botName" | "appId" | "platform"
  >,
  isConnected: boolean,
) {
  return {
    status: 200 as const,
    body: {
      isConnected,
      botName: installation.botName,
      openUrl: feishuBotOpenUrl(installation.appId, installation.platform),
    },
  };
}

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
  const installationPlan = browserInstallationReadPlan(query.installationId);
  const [installation] = await db
    .select(installationPlan.columns)
    .from(feishuOrgInstallations)
    .where(installationPlan.condition)
    .limit(1);
  signal.throwIfAborted();
  if (!installation) {
    return notFound("Bot installation not found");
  }
  if (
    !(await (async () => {
      const plan = feishuInstallationAvailabilityReadPlan(installation);
      if (plan.kind === "resolved") {
        return plan.enabled;
      }
      const rows = await db
        .select(plan.columns)
        .from(userFeatureSwitches)
        .where(plan.condition);
      return feishuInstallationEnabledFromRows(plan.scope, rows);
    })())
  ) {
    return notFound("Bot integration is unavailable");
  }
  if (installation.orgId !== auth.orgId) {
    return wrongFeishuOrganization();
  }
  const connectionPlan = browserMemberReadPlan(query);
  const [connection] = await db
    .select(connectionPlan.columns)
    .from(feishuOrgConnections)
    .where(connectionPlan.condition)
    .limit(1);
  signal.throwIfAborted();
  if (connection && connection.userId !== auth.userId) {
    return conflict("This account is already connected");
  }
  const isConnected =
    connection?.userId === auth.userId &&
    (await (async () => {
      const scope = {
        orgId: auth.orgId,
        userId: auth.userId,
        installationId: query.installationId,
        memberConnectorId: connection.connectorId,
        feishuOpenId: query.openId,
      };
      return (
        (await (async () => {
          const memberPlan = feishuOAuthMemberReadPlan(scope);
          const memberRows = memberPlan.needsRead
            ? await db
                .select(memberPlan.columns)
                .from(feishuOrgConnections)
                .where(memberPlan.condition)
                .limit(2)
            : [];
          const member = feishuOAuthMemberFromRows(scope, memberRows);
          if (!member) {
            return null;
          }
          const installationPlan = feishuOAuthInstallationReadPlan(scope);
          const [installation] = await db
            .select(installationPlan.columns)
            .from(feishuOrgInstallations)
            .where(installationPlan.condition)
            .limit(1);
          const customConnectorId = installation?.customConnectorId;
          if (!customConnectorId) {
            return null;
          }
          const accountScope = { ...scope, ...member, customConnectorId };
          const accountPlan = feishuOAuthAccountReadPlan(accountScope);
          const [exactRows, defaultRows] = await Promise.all([
            accountPlan.exactWhere
              ? db
                  .select(accountPlan.columns)
                  .from(connectors)
                  .where(accountPlan.exactWhere)
              : [],
            accountPlan.defaultWhere
              ? db
                  .select(accountPlan.columns)
                  .from(connectors)
                  .where(accountPlan.defaultWhere)
              : [],
          ]);
          const accountId = feishuOAuthAccountFromRows(accountPlan, {
            exactRows,
            defaultRows,
          });
          if (accountId === null) {
            return null;
          }
          const credentialPlan = feishuOAuthCredentialReadPlan({
            ...accountScope,
            memberConnectorId: accountId,
          });
          const [matchedConnection] = await db
            .select(credentialPlan.columns)
            .from(connectors)
            .innerJoin(orgCustomConnectors, credentialPlan.connectorJoin)
            .innerJoin(secrets, credentialPlan.secretJoin)
            .where(credentialPlan.condition)
            .limit(1);
          return matchedConnection?.id ?? null;
        })()) !== null
      );
    })());
  signal.throwIfAborted();
  return feishuBrowserStatus(installation, isConnected);
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
