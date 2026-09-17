/**
 * Slack Connect API Handlers
 *
 * Mock handlers for /api/integrations/slack/connect endpoint.
 * Default behavior: user is not yet connected.
 */

import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { mockApi } from "../msw-contract.ts";

interface MockSlackConnectData {
  isConnected: boolean;
  postError: string | null;
}

let mockData: MockSlackConnectData = {
  isConnected: false,
  postError: null,
};

export function resetMockSlackConnect(): void {
  mockData = {
    isConnected: false,
    postError: null,
  };
}

export const apiIntegrationsSlackConnectHandlers = [
  // GET /api/integrations/slack/connect — check connection status
  mockApi(slackConnectContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: mockData.isConnected,
      isAdmin: false,
    });
  }),

  // POST /api/integrations/slack/connect — start user OAuth
  mockApi(slackConnectContract.connect, ({ respond }) => {
    if (mockData.postError) {
      return respond(400, {
        error: { message: mockData.postError, code: "BAD_REQUEST" },
      });
    }
    return respond(202, {
      authorizationUrl:
        "https://api.okou.ai/api/slack/oauth/connect?connectorState=mock-entry",
    });
  }),
];
