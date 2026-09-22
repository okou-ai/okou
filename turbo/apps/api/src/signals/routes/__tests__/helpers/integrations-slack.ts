import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import type {
  TestSlackStatePostBody,
  TestSlackStatePostResponse,
  TestSlackStateResponse,
} from "@okouai/api-contracts/contracts/test-slack-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testSlackStateRoutes } from "../../slack-state-preview";

const SLACK_STATE_ROUTE = "/api/test/slack-state";

export interface SlackIntegrationFixture {
  readonly orgId: string;
  readonly slackWorkspaceId: string;
}

interface SeedSlackInstallationValues {
  readonly orgId: string;
  readonly slackWorkspaceId?: string;
  readonly slackWorkspaceName?: string;
  readonly botScopes?: string | null;
  readonly botToken?: string;
}

interface SeedSlackConnectionValues {
  readonly slackWorkspaceId: string;
  readonly userId: string;
  readonly slackUserId?: string;
}

function randomSlackId(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`;
}

function requestSlackState(
  signal: AbortSignal,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal,
    routes: testSlackStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postSlackState(
  signal: AbortSignal,
  body: TestSlackStatePostBody,
): Promise<TestSlackStatePostResponse> {
  const response = await requestSlackState(signal, SLACK_STATE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expectOk(response, "seed Slack state");
  return await readJson<TestSlackStatePostResponse>(response);
}

async function getSlackState(
  signal: AbortSignal,
  slackWorkspaceId: string,
): Promise<TestSlackStateResponse> {
  const response = await requestSlackState(
    signal,
    `${SLACK_STATE_ROUTE}?${new URLSearchParams({
      team_id: slackWorkspaceId,
    }).toString()}`,
  );
  expectOk(response, "read Slack state");
  return await readJson<TestSlackStateResponse>(response);
}

export const seedSlackOrgInstallation$ = command(
  async (
    _,
    values: SeedSlackInstallationValues,
    signal: AbortSignal,
  ): Promise<SlackIntegrationFixture> => {
    const slackWorkspaceId = values.slackWorkspaceId ?? randomSlackId("T");
    const response = await postSlackState(signal, {
      team_id: slackWorkspaceId,
      org_id: values.orgId,
      workspace_name: values.slackWorkspaceName ?? "Test Org Workspace",
      bot_scopes: values.botScopes ?? null,
      bot_token: values.botToken ?? "xoxb-test-token",
    });

    return {
      orgId: response.org_id,
      slackWorkspaceId: response.team_id,
    };
  },
);

export const seedSlackOrgConnection$ = command(
  async (
    _,
    values: SeedSlackConnectionValues,
    signal: AbortSignal,
  ): Promise<{ readonly slackUserId: string }> => {
    const slackUserId = values.slackUserId ?? randomSlackId("U");
    const state = await getSlackState(signal, values.slackWorkspaceId);
    const orgId = state.installation?.orgId;
    if (!orgId) {
      throw new Error("Cannot seed Slack connection without installation org");
    }

    await postSlackState(signal, {
      team_id: values.slackWorkspaceId,
      org_id: orgId,
      user_id: values.userId,
      slack_user_id: slackUserId,
      seed_connection: true,
    });

    return { slackUserId };
  },
);

export const seedSlackEnvironmentAgent$ = command(
  async (
    _,
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    await postSlackState(signal, {
      org_id: args.orgId,
      user_id: args.userId,
      seed_default_agent: true,
    });
  },
);

export const deleteSlackIntegrationFixture$ = command(
  async (
    _,
    fixture: SlackIntegrationFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const params = new URLSearchParams({
      team_id: fixture.slackWorkspaceId,
    });
    const response = await requestSlackState(
      signal,
      `${SLACK_STATE_ROUTE}?${params.toString()}`,
      { method: "DELETE" },
    );
    expectOk(response, "delete Slack state");
  },
);
