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
import { screen, waitFor } from "@testing-library/react";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export function queryAction(
  role: "button" | "link" | "radio" | "tab",
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
  role: "button" | "link" | "radio" | "tab",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const action = queryAction(role, name, container);
  if (!action) {
    throw new Error(`Expected ${role} named "${name}"`);
  }
  return action;
}

export function findAction(
  role: "button" | "link" | "radio" | "tab",
  name: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return waitFor(() => {
    return getAction(role, name, container);
  });
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
    linkedAccounts: [],
    pendingInstallation: false,
    installUrl:
      "/api/teams/oauth/connect?flow=install&orgId=org_1&userId=user_1",
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
    isConnected: false,
    isInstalled: false,
    isAdmin: true,
    appId: null,
    callbackUrl: null,
    callbackVerified: false,
    messageReceived: false,
    tenantKey: null,
    tenantName: null,
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
    readonly compact?: boolean;
    readonly feishu?: boolean;
    readonly lark?: boolean;
  } = {},
): Promise<void> {
  return setupPage({
    context,
    path: "/works",
    featureSwitches: {
      [FeatureSwitchKey.WorksChannelCards]: options.compact ?? false,
      [FeatureSwitchKey.FeishuIntegration]: options.feishu ?? false,
      [FeatureSwitchKey.LarkIntegration]: options.lark ?? false,
    },
  });
}
