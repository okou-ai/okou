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
    "/api/teams/oauth/connect?flow=install&orgId=org_mock&userId=user_mock",
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
      "/api/teams/oauth/connect?flow=install&orgId=org_mock&userId=user_mock",
    connectUrl: "/api/teams/oauth/connect?orgId=org_mock&userId=user_mock",
  };
}

export const apiIntegrationsTeamsHandlers = [
  mockApi(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(200, mockTeamsData);
  }),

  mockApi(teamsConnectContract.disconnect, ({ query, respond }) => {
    if (query.action === "uninstall") {
      mockTeamsData = {
        ...mockTeamsData,
        isInstalled: false,
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
