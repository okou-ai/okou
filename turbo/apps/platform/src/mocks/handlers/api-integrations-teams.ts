import {
  type TeamsConnectStatus,
  teamsConnectContract,
} from "@okouai/api-contracts/contracts/teams-connect";
import { mockApi } from "../msw-contract.ts";

let mockTeamsData: TeamsConnectStatus = {
  isInstalled: false,
  isConnected: false,
  isAdmin: true,
  linkedAccounts: [],
  pendingInstallation: false,
  installUrl:
    "https://teams.microsoft.com/l/app/00000000-0000-0000-0000-000000000001",
  connectUrl: "/api/teams/oauth/connect?orgId=org_mock&userId=user_mock",
};

export function resetMockTeamsIntegration(): void {
  mockTeamsData = {
    isInstalled: false,
    isConnected: false,
    isAdmin: true,
    linkedAccounts: [],
    pendingInstallation: false,
    installUrl:
      "https://teams.microsoft.com/l/app/00000000-0000-0000-0000-000000000001",
    connectUrl: "/api/teams/oauth/connect?orgId=org_mock&userId=user_mock",
  };
}

export const apiIntegrationsTeamsHandlers = [
  mockApi(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(200, mockTeamsData);
  }),

  mockApi(teamsConnectContract.connect, ({ body, respond }) => {
    mockTeamsData = {
      ...mockTeamsData,
      isInstalled: true,
      isConnected: true,
      tenantId: body.tenantId,
      tenantName: mockTeamsData.tenantName ?? null,
      teamId: body.teamId ?? mockTeamsData.teamId ?? null,
      teamName: body.teamName ?? mockTeamsData.teamName ?? null,
      connectUrl: null,
    };
    return respond(200, {
      success: true,
      connectionId: "teams-conn-mock-001",
      role: mockTeamsData.isAdmin ? "admin" : "member",
    });
  }),

  mockApi(teamsConnectContract.disconnect, ({ query, respond }) => {
    if (query.action === "uninstall") {
      mockTeamsData = {
        ...mockTeamsData,
        isInstalled: false,
        isConnected: false,
        connectUrl: "/api/teams/oauth/connect?orgId=org_mock&userId=user_mock",
      };
    } else {
      mockTeamsData = {
        ...mockTeamsData,
        isConnected: false,
        connectUrl: "/api/teams/oauth/connect?orgId=org_mock&userId=user_mock",
      };
    }
    return respond(200, { success: true });
  }),
];
