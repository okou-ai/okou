import {
  feishuConnectContract,
  larkConnectContract,
  type FeishuInstallationStatus,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

type Provider = "feishu" | "lark";

export function providerContract(provider: Provider) {
  return provider === "feishu" ? feishuConnectContract : larkConnectContract;
}

export function installation(
  provider: Provider,
  connected = false,
): FeishuInstallationStatus {
  return {
    platform: provider,
    id: crypto.randomUUID(),
    isConnected: connected,
    appId: "cli_" + provider + "_harbor",
    botName: "Harbor dispatch",
    botAvatarUrl: "https://images.example.test/" + provider + "/harbor.png",
    connectedUserName: connected ? "Ada Shore" : null,
    callbackUrl: "https://api.example.test/events/" + provider,
    connectUrl:
      "https://accounts.example.test/" + provider + "?installation=harbor",
    oauthRedirectUrl:
      "https://app.okou.ai/connectors/" + provider + "/callback",
    callbackVerified: true,
    messageReceived: true,
    setupCompleted: true,
    tenantKey: "harbor-ops",
    tenantName: "Harbor operations",
    defaultAgentId: null,
    defaultAgentName: "Harbor assistant",
  };
}

export function botWorkspace(
  context: TestContext,
  provider: Provider,
  admin: boolean,
  bots: () => FeishuInstallationStatus[],
) {
  context.mocks.api(
    providerContract(provider).getStatus,
    ({ request, respond }) => {
      const expectedToken = admin ? "harbor-admin" : "harbor-member";
      if (request.headers.get("authorization") !== "Bearer " + expectedToken) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Unknown workspace session" },
        });
      }
      const installations = bots();
      const first = installations[0];
      return respond(200, {
        platform: provider,
        isAdmin: admin,
        isInstalled: installations.length > 0,
        isConnected: installations.some((bot) => {
          return bot.isConnected;
        }),
        installations,
        appId: first?.appId ?? null,
        callbackUrl: first?.callbackUrl ?? null,
        callbackVerified: first?.callbackVerified ?? false,
        messageReceived: first?.messageReceived ?? false,
        tenantKey: first?.tenantKey ?? null,
        tenantName: first?.tenantName ?? null,
        defaultAgentId: first?.defaultAgentId ?? null,
        defaultAgentName: first?.defaultAgentName ?? null,
      });
    },
  );
}

export async function visitProvider(
  context: TestContext,
  provider: Provider,
  path: string,
  role: "admin" | "member" = "admin",
) {
  await setupPage({
    context,
    path,
    auth: {
      user: {
        id: "shore-" + role,
        fullName: role === "admin" ? "Harbor administrator" : "Ada Shore",
      },
      session: { token: "harbor-" + role },
      organization: {
        activeOrg: { id: "org_harbor", name: "Harbor operations" },
        memberships: [{ id: "org_harbor" }],
      },
    },
    featureSwitches: {
      [FeatureSwitchKey.FeishuIntegration]: provider === "feishu",
      [FeatureSwitchKey.LarkIntegration]: provider === "lark",
      [FeatureSwitchKey.LarkOfficialBot]: false,
      [FeatureSwitchKey.WorksChannelCards]: false,
    },
  });
}
