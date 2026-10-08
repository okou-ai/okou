import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import type {
  TestSlackStateDeleteResponse,
  TestSlackStatePostBody,
  TestSlackStatePostResponse,
  TestSlackStateResponse,
} from "@okouai/api-contracts/contracts/test-slack-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testSlackStateRoutes } from "../../slack-state-preview";

const SLACK_STATE_ROUTE = "/api/test/slack-state";

export interface SlackConnectFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly slackWorkspaceId: string;
  readonly slackWorkspaceName: string;
  readonly slackUserId: string;
}

interface SeedValues {
  readonly withConnection?: boolean;
  readonly slackWorkspaceName?: string;
  readonly orgId?: string;
  readonly userId?: string;
  readonly slackWorkspaceId?: string;
  readonly slackUserId?: string;
  readonly installationOrgId?: string | null;
}

interface SlackConnection {
  readonly id: string;
  readonly slackUserId: string;
  readonly slackWorkspaceId: string;
  readonly userId: string;
  readonly dmWelcomeSent: boolean;
  readonly createdAt: string;
}

interface SlackInstallation {
  readonly slackWorkspaceId: string;
  readonly slackWorkspaceName: string | null;
  readonly orgId: string | null;
  readonly botUserId: string;
  readonly botScopes: string | null;
  readonly installedByUserId: string | null;
  readonly createdAt: string;
}

function requestSlackState(
  signal: AbortSignal | undefined,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const requestSignal = signal ?? new AbortController().signal;
  const app = createAppWithRoutes({
    signal: requestSignal,
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
  signal.throwIfAborted();
  expectOk(response, "slack state post");
  signal.throwIfAborted();
  const result = await readJson<TestSlackStatePostResponse>(response);
  signal.throwIfAborted();
  return result;
}

async function getSlackState(
  signal: AbortSignal | undefined,
  query: {
    readonly teamId?: string;
    readonly orgId?: string;
  },
): Promise<TestSlackStateResponse> {
  const params = new URLSearchParams();
  if (query.teamId === "") {
    params.set("empty_team_id", "1");
  } else if (query.teamId) {
    params.set("team_id", query.teamId);
  }
  if (query.orgId) {
    params.set("org_id", query.orgId);
  }
  const response = await requestSlackState(
    signal,
    `${SLACK_STATE_ROUTE}?${params.toString()}`,
    { method: "GET" },
  );
  signal?.throwIfAborted();
  expectOk(response, "slack state get");
  signal?.throwIfAborted();
  const result = await readJson<TestSlackStateResponse>(response);
  signal?.throwIfAborted();
  return result;
}

async function deleteSlackState(
  signal: AbortSignal,
  fixture: SlackConnectFixture,
): Promise<TestSlackStateDeleteResponse> {
  const params = new URLSearchParams({
    team_id: fixture.slackWorkspaceId,
    org_id: fixture.orgId,
  });
  const response = await requestSlackState(
    signal,
    `${SLACK_STATE_ROUTE}?${params.toString()}`,
    { method: "DELETE" },
  );
  signal.throwIfAborted();
  expectOk(response, "slack state delete");
  signal.throwIfAborted();
  const result = await readJson<TestSlackStateDeleteResponse>(response);
  signal.throwIfAborted();
  return result;
}

export const seedSlackConnectOrg$ = command(
  async (
    _,
    values: SeedValues,
    signal: AbortSignal,
  ): Promise<SlackConnectFixture> => {
    const orgId = values.orgId ?? `org_${randomUUID()}`;
    const userId = values.userId ?? `user_${randomUUID()}`;
    const slackWorkspaceId =
      values.slackWorkspaceId ??
      `T_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const slackWorkspaceName = values.slackWorkspaceName ?? "Test Workspace";
    const slackUserId =
      values.slackUserId ?? `U_USER_${randomUUID().slice(0, 8)}`;

    await postSlackState(signal, {
      team_id: slackWorkspaceId,
      slack_user_id: slackUserId,
      workspace_name: slackWorkspaceName,
      org_id: orgId,
      user_id: userId,
      bot_token: "xoxb-test-bot-token",
      bot_user_id: "U_BOT_TEST",
      installation_org_id:
        values.installationOrgId === undefined
          ? orgId
          : values.installationOrgId,
      seed_connection: values.withConnection,
    });

    return { orgId, userId, slackWorkspaceId, slackWorkspaceName, slackUserId };
  },
);

export const findSlackOrgConnection$ = command(
  async (
    _,
    values: {
      readonly slackWorkspaceId: string;
      readonly slackUserId: string;
    },
    signal: AbortSignal,
  ): Promise<SlackConnection | undefined> => {
    const state = await getSlackState(signal, {
      teamId: values.slackWorkspaceId,
    });
    const connection = state.connections.find((candidate) => {
      return candidate.slackUserId === values.slackUserId;
    });
    return connection
      ? { ...connection, slackWorkspaceId: values.slackWorkspaceId }
      : undefined;
  },
);

export const countSlackOrgConnections$ = command(
  async (_, slackWorkspaceId: string, signal: AbortSignal): Promise<number> => {
    const state = await getSlackState(signal, { teamId: slackWorkspaceId });
    return state.connections.length;
  },
);

export const findSlackOrgInstallation$ = command(
  async (
    _,
    slackWorkspaceId: string,
    signal: AbortSignal,
  ): Promise<SlackInstallation | undefined> => {
    const state = await getSlackState(signal, { teamId: slackWorkspaceId });
    return state.installation ?? undefined;
  },
);

export const deleteSlackConnectOrg$ = command(
  async (
    _,
    fixture: SlackConnectFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    await deleteSlackState(signal, fixture);
  },
);
