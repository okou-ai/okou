import { http, HttpResponse } from "msw";

import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";

const context = testContext();
const integrations = createBddIntegrationApi(context);

const SLACK_LIST_URL = "https://slack.com/api/users.conversations";

describe("GET /api/slack/channels", () => {
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

  it("returns 404 when the current user has not connected Slack", async () => {
    const installer = integrations.user();
    const disconnected = integrations.user({
      orgId: installer.orgId,
      orgRole: "org:member",
    });
    integrations.configureSlackAppMocks();
    await integrations.installSlackWorkspace(installer);

    const response = await integrations.requestListSlackChannels(
      disconnected,
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "No Slack account connected for this user",
        code: "NOT_FOUND",
      },
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
