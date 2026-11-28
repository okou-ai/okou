import { slackChannelsContract } from "@okouai/api-contracts/contracts/slack-channels";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { slackChannelsRoutes } from "../slack-channels";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { createPublicSlackOrgApi } from "./helpers/slack-public-install";

const context = testContext();
const clerkDirectory = createStore();

interface SlackChannelPage {
  readonly channels: readonly {
    readonly id: string;
    readonly name: string;
    readonly is_private: boolean;
  }[];
  readonly nextCursor?: string;
}

interface SlackChannelRequest {
  readonly authorization: string | null;
  readonly params: Record<string, string>;
}

/** Slack answers `users.conversations` with the given pages in order. */
function serveSlackChannels(
  pages: readonly SlackChannelPage[],
): SlackChannelRequest[] {
  const requests: SlackChannelRequest[] = [];
  server.use(
    http.get("https://slack.com/api/users.conversations", ({ request }) => {
      const url = new URL(request.url);
      requests.push({
        authorization: request.headers.get("authorization"),
        params: Object.fromEntries(url.searchParams),
      });
      const cursor = url.searchParams.get("cursor");
      const index = cursor ? Number(cursor) : 0;
      const page = pages[index] ?? { channels: [] };
      return HttpResponse.json({
        ok: true,
        channels: page.channels,
        response_metadata: { next_cursor: page.nextCursor ?? "" },
      });
    }),
  );
  return requests;
}

async function listChannels(userId: string, orgId: string) {
  await clerkDirectory.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );
  createRouteMocks(context).clerk.session(userId, orgId);
  return await accept(
    setupApp({ context, routes: slackChannelsRoutes })(
      slackChannelsContract,
    ).list({ headers: { authorization: "Bearer clerk-session" } }),
    [200, 404],
  );
}

describe("GET /api/slack/channels", () => {
  it("slack-channels-004 collects channels across every Slack page", async () => {
    const slack = createPublicSlackOrgApi(context);
    const org = await slack.installOrg({ withConnection: true });
    const requests = serveSlackChannels([
      {
        channels: [{ id: "C001", name: "page-one", is_private: false }],
        nextCursor: "1",
      },
      { channels: [{ id: "C002", name: "page-two", is_private: false }] },
    ]);

    const response = await listChannels(org.userId, org.orgId);

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      channels: [
        { id: "C001", name: "page-one" },
        { id: "C002", name: "page-two" },
      ],
    });
    expect(requests).toHaveLength(2);
  });

  it("slack-channels-003 returns channels shared by the connected user and bot sorted by name", async () => {
    const slack = createPublicSlackOrgApi(context);
    const org = await slack.installOrg({ withConnection: true });
    const requests = serveSlackChannels([
      {
        channels: [
          { id: "C001", name: "general", is_private: false },
          { id: "C002", name: "random", is_private: false },
          { id: "C003", name: "alpha", is_private: true },
        ],
      },
    ]);

    const response = await listChannels(org.userId, org.orgId);

    expect(requests).toStrictEqual([
      {
        authorization: `Bearer ${org.botToken}`,
        params: {
          limit: "200",
          user: org.slackUserId,
          types: "public_channel,private_channel",
          exclude_archived: "true",
        },
      },
    ]);
    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      channels: [
        { id: "C003", name: "alpha" },
        { id: "C001", name: "general" },
        { id: "C002", name: "random" },
      ],
    });
  });
});
