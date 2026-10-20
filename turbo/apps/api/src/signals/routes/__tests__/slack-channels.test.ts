import { http, HttpResponse } from "msw";

import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createFixtureTracker } from "./helpers/route-test";
import {
  createPublicSlackOrgApi,
  uniqueSlackUserId,
} from "./helpers/slack-public-install";

const context = testContext();
const integrations = createBddIntegrationApi(context);

const SLACK_LIST_URL = "https://slack.com/api/users.conversations";

describe("GET /api/slack/channels", () => {
  const slackOrgs = createPublicSlackOrgApi(context);
  const track = createFixtureTracker<{
    readonly teamId: string;
    readonly installerSlackUserId: string;
  }>((installation) => {
    return slackOrgs.uninstallWorkspace(installation.teamId);
  });

  it("keeps successive channel requests scoped to their user and organization", async () => {
    const first = integrations.user();
    const second = integrations.user({
      orgId: first.orgId,
      orgRole: "org:member",
    });
    const other = integrations.user();
    const uninstalled = integrations.user();
    integrations.configureSlackAppMocks();
    const installationA = await track(
      integrations.installSlackWorkspace(first),
    );
    const installationB = await track(
      integrations.installSlackWorkspace(other),
    );
    const requests: { token: string | null; user: string | null }[] = [];
    server.use(
      http.get(SLACK_LIST_URL, ({ request }) => {
        requests.push({
          token: request.headers.get("authorization"),
          user: new URL(request.url).searchParams.get("user"),
        });
        return HttpResponse.json({
          ok: true,
          channels: [{ id: "C001", name: "general", is_private: false }],
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const body = { channels: [{ id: "C001", name: "general" }] };
    expect(
      (await integrations.requestListSlackChannels(first, [200])).body,
    ).toStrictEqual(body);
    const disconnected = await integrations.requestListSlackChannels(
      second,
      [404],
    );
    expect(disconnected.body).toStrictEqual({
      error: {
        message: "No Slack account connected for this user",
        code: "NOT_FOUND",
      },
    });
    expect(requests).toHaveLength(1);

    const secondSlackUserId = uniqueSlackUserId();
    await integrations.connectSlackUser(second, {
      workspaceId: installationA.teamId,
      slackUserId: secondSlackUserId,
    });
    expect(
      (await integrations.requestListSlackChannels(second, [200])).body,
    ).toStrictEqual(body);
    expect(
      (await integrations.requestListSlackChannels(other, [200])).body,
    ).toStrictEqual(body);
    const missing = await integrations.requestListSlackChannels(
      uninstalled,
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: {
        message: "No Slack installation found for this org",
        code: "NOT_FOUND",
      },
    });
    expect(requests).toHaveLength(3);
    expect(
      (await integrations.requestListSlackChannels(first, [200])).body,
    ).toStrictEqual(body);
    expect(requests).toStrictEqual([
      {
        token: `Bearer xoxb-bdd-${installationA.teamId}`,
        user: installationA.installerSlackUserId,
      },
      {
        token: `Bearer xoxb-bdd-${installationA.teamId}`,
        user: secondSlackUserId,
      },
      {
        token: `Bearer xoxb-bdd-${installationB.teamId}`,
        user: installationB.installerSlackUserId,
      },
      {
        token: `Bearer xoxb-bdd-${installationA.teamId}`,
        user: installationA.installerSlackUserId,
      },
    ]);
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const response = await integrations.requestListSlackChannels(
      integrations.user({ orgId: null }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns channels shared by the connected user and bot", async () => {
    const actor = integrations.user();
    integrations.configureSlackAppMocks();
    const installation = await integrations.installSlackWorkspace(actor);
    let query: URLSearchParams | undefined;

    server.use(
      http.get(SLACK_LIST_URL, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json({
          ok: true,
          channels: [
            { id: "C001", name: "general", is_private: false },
            { id: "C002", name: "random", is_private: false },
            { id: "C004", name: "alpha", is_private: true },
          ],
          response_metadata: { next_cursor: "" },
        });
      }),
    );

    const response = await integrations.requestListSlackChannels(actor, [200]);

    expect(Object.fromEntries(query ?? [])).toStrictEqual({
      limit: "200",
      user: installation.installerSlackUserId,
      types: "public_channel,private_channel",
      exclude_archived: "true",
    });
    expect(response.body).toStrictEqual({
      channels: [
        { id: "C004", name: "alpha" },
        { id: "C001", name: "general" },
        { id: "C002", name: "random" },
      ],
    });
  });

  it("handles pagination across multiple pages", async () => {
    const actor = integrations.user();
    integrations.configureSlackAppMocks();
    await integrations.installSlackWorkspace(actor);

    let callCount = 0;
    server.use(
      http.get(SLACK_LIST_URL, ({ request }) => {
        callCount++;
        const cursor = new URL(request.url).searchParams.get("cursor");
        if (!cursor) {
          return HttpResponse.json({
            ok: true,
            channels: [{ id: "C001", name: "page-one", is_private: false }],
            response_metadata: { next_cursor: "cursor_page2" },
          });
        }
        return HttpResponse.json({
          ok: true,
          channels: [{ id: "C002", name: "page-two", is_private: false }],
          response_metadata: { next_cursor: "" },
        });
      }),
    );

    const response = await integrations.requestListSlackChannels(actor, [200]);

    expect(response.body).toStrictEqual({
      channels: [
        { id: "C001", name: "page-one" },
        { id: "C002", name: "page-two" },
      ],
    });
    expect(callCount).toBe(2);
  });

  it("returns an empty array when the user and bot share no channels", async () => {
    const actor = integrations.user();
    integrations.configureSlackAppMocks();
    await integrations.installSlackWorkspace(actor);

    server.use(
      http.get(SLACK_LIST_URL, () => {
        return HttpResponse.json({
          ok: true,
          channels: [],
          response_metadata: { next_cursor: "" },
        });
      }),
    );

    const response = await integrations.requestListSlackChannels(actor, [200]);

    expect(response.body).toStrictEqual({ channels: [] });
  });
});
