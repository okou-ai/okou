import {
  feishuConnectContract,
  larkConnectContract,
  type FeishuConnectStatus,
} from "@okouai/api-contracts/contracts/feishu-connect";
import {
  integrationsSlackContract,
  type SlackOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-slack";
import {
  teamsConnectContract,
  type TeamsConnectStatus,
} from "@okouai/api-contracts/contracts/teams-connect";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen } from "@testing-library/react";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export function queryAction(
  role: "button" | "link" | "radio",
  name: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast(role, container).find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === name ||
        candidate.textContent?.replace(/\s+/gu, " ").trim() === name
      );
    }) ?? null
  );
}

export function getAction(
  role: "button" | "link" | "radio",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const action = queryAction(role, name, container);
  if (!action) {
    throw new Error(`Expected ${role} named "${name}"`);
  }
  return action;
}

export function getIntegrationCard(title: string): HTMLElement {
  const card = screen
    .getByText(title)
    .closest('[data-slot="connector-card"], [data-slot="integration-card"]');
  if (!(card instanceof HTMLElement)) {
    throw new Error(`Expected integration card titled "${title}"`);
  }
  return card;
}

export function mockSlack(
  context: TestContext,
  overrides: Partial<SlackOrgStatus> = {},
): void {
  const defaults: SlackOrgStatus = {
    isConnected: false,
    isInstalled: false,
    isAdmin: false,
    installUrl: null,
    connectUrl: null,
    reinstallUrl: null,
    scopeMismatch: false,
    workspaceName: null,
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, { ...defaults, ...overrides });
  });
}

export function mockTeams(
  context: TestContext,
  overrides: Partial<TeamsConnectStatus> = {},
): void {
  const defaults: TeamsConnectStatus = {
    isConnected: false,
    isInstalled: false,
    isAdmin: true,
    installUrl:
      "https://teams.microsoft.com/l/app/00000000-0000-0000-0000-000000000001",
    connectUrl: "/api/teams/oauth/connect?orgId=org_1&userId=user_1",
  };
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(200, { ...defaults, ...overrides });
  });
}

export function mockFeishu(
  context: TestContext,
  overrides: Partial<FeishuConnectStatus> = {},
  platform: "feishu" | "lark" = "feishu",
): void {
  const contract =
    platform === "lark" ? larkConnectContract : feishuConnectContract;
  const defaults: FeishuConnectStatus = {
    publicBrand: "vm0",
    isConnected: false,
    isInstalled: false,
    isAdmin: true,
    appId: null,
    callbackUrl: null,
    callbackVerified: false,
    messageReceived: false,
    tenantKey: null,
    tenantName: null,
    defaultAgentId: null,
    defaultAgentName: "Okou",
  };
  context.mocks.api(contract.getStatus, ({ respond }) => {
    return respond(200, { ...defaults, ...overrides });
  });
  context.mocks.api(contract.checkAppId, ({ respond }) => {
    return respond(200, { available: true });
  });
}

export function setupIntegrationsPage(
  context: TestContext,
  options: {
    readonly feishu?: boolean;
    readonly lark?: boolean;
  } = {},
): Promise<void> {
  return setupPage({
    context,
    path: "/works",
    featureSwitches: {
      [FeatureSwitchKey.FeishuIntegration]: options.feishu ?? false,
      [FeatureSwitchKey.LarkIntegration]: options.lark ?? false,
    },
  });
}

export function setupFeishuSettingsPage(
  context: TestContext,
  platform: "feishu" | "lark" = "feishu",
): Promise<void> {
  return setupPage({
    context,
    path: `/settings/${platform}`,
    featureSwitches: {
      [platform === "lark"
        ? FeatureSwitchKey.LarkIntegration
        : FeatureSwitchKey.FeishuIntegration]: true,
    },
  });
}
