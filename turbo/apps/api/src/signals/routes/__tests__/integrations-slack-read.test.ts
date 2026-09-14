import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { integrationsSlackReadContract } from "@okouai/api-contracts/contracts/integrations-slack-read";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { integrationsSlackReadRoutes } from "../integrations-slack-read";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import {
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import { seedOrgMembership$ } from "./helpers/org-membership";

const context = testContext();
const store = createStore();
const connectors = createConnectorBddApi(context);
const SLACK_USER_CONVERSATIONS_URL =
  "https://slack.com/api/users.conversations";
const SLACK_HISTORY_URL = "https://slack.com/api/conversations.history";
const SLACK_REPLIES_URL = "https://slack.com/api/conversations.replies";
const THREAD_TS = "1750000000.000001";

async function fixture(
  options: {
    enabled?: boolean;
    installed?: boolean;
    connected?: boolean;
    capabilities?: readonly Capability[];
  } = {},
) {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const actor: ApiTestUser = {
    userId,
    orgId,
    orgRole: "org:admin",
    email: `${userId}@example.test`,
  };
  await connectors.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.SlackRead]: options.enabled ?? true,
  });
  await store.set(
    seedOrgMembership$,
    { userId, orgId, role: "admin" },
    context.signal,
  );
  const botToken = `xoxb-test-${randomUUID()}`;
  const installation =
    options.installed === false
      ? null
      : await store.set(
          seedSlackOrgInstallation$,
          { orgId, botToken },
          context.signal,
        );
  const connection =
    installation && options.connected !== false
      ? await store.set(
          seedSlackOrgConnection$,
          {
            slackWorkspaceId: installation.slackWorkspaceId,
            userId,
          },
          context.signal,
        )
      : null;
  const seconds = Math.floor(now() / 1000);
  const token = signSandboxJwtForTests({
    scope: "okou",
    userId,
    orgId,
    runId: randomUUID(),
    capabilities: options.capabilities ?? ["slack:read"],
    iat: seconds,
    exp: seconds + 60,
  });
  return {
    client: setupApp({ context, routes: integrationsSlackReadRoutes })(
      integrationsSlackReadContract,
    ),
    actor,
    botToken,
    installation,
    slackUserId: connection?.slackUserId ?? null,
    headers: { authorization: `Bearer ${token}` },
  };
}

function allowSharedConversation(conversationId: string): void {
  server.use(
    http.get(SLACK_USER_CONVERSATIONS_URL, () => {
      return HttpResponse.json({
        ok: true,
        channels: [{ id: conversationId }],
        response_metadata: { next_cursor: "" },
      });
    }),
  );
}

describe("Slack bot channel discovery and history", () => {
  it("lists only channels shared by the connected Slack user and bot", async () => {
    const { client, headers, botToken, installation, slackUserId } =
      await fixture();
    let requestedToken: string | null = null;
    let query: URLSearchParams | undefined;
    server.use(
      http.get(SLACK_USER_CONVERSATIONS_URL, ({ request }) => {
        requestedToken = request.headers.get("authorization");
        query = new URL(request.url).searchParams;
        return HttpResponse.json({
          ok: true,
          channels: [
            { id: "C123", name: "general", is_private: false },
            { id: "C456", name: "private", is_private: true },
          ],
          response_metadata: { next_cursor: "next-page" },
        });
      }),
    );
    const response = await accept(
      client.listChannels({
        headers,
        query: { limit: 20, cursor: "previous-page" },
      }),
      [200],
    );
    expect(requestedToken).toBe(`Bearer ${botToken}`);
    expect(Object.fromEntries(query ?? [])).toStrictEqual({
      limit: "20",
      cursor: "previous-page",
      user: slackUserId,
      types: "public_channel,private_channel",
      exclude_archived: "true",
    });
    expect(response.body).toStrictEqual({
      channels: [
        {
          id: "C123",
          name: "general",
          isPrivate: false,
          isMember: true,
          channelUrl: `https://slack.com/app_redirect?team=${installation?.slackWorkspaceId}&channel=C123`,
        },
        {
          id: "C456",
          name: "private",
          isPrivate: true,
          isMember: true,
          channelUrl: `https://slack.com/app_redirect?team=${installation?.slackWorkspaceId}&channel=C456`,
        },
      ],
      nextCursor: "next-page",
    });
  });

  it("preserves continuation for an empty channel page", async () => {
    const { client, headers } = await fixture();
    server.use(
      http.get(SLACK_USER_CONVERSATIONS_URL, () => {
        return HttpResponse.json({
          ok: true,
          channels: [],
          response_metadata: { next_cursor: "more-channels" },
        });
      }),
    );
    const response = await accept(
      client.listChannels({ headers, query: { limit: 10 } }),
      [200],
    );
    expect(response.body).toStrictEqual({
      channels: [],
      nextCursor: "more-channels",
    });
  });

  it("requires the current Okou user to connect a Slack identity", async () => {
    const { client, headers } = await fixture({ connected: false });

    const response = await accept(
      client.listChannels({ headers, query: { limit: 10 } }),
      [404],
    );

    expect(response.body.error.message).toContain(
      "Slack account is not connected",
    );
  });

  it.each([
    ["C123", "public_channel,private_channel"],
    ["G123", "public_channel,private_channel"],
    ["D123", "im"],
  ])(
    "authorizes shared conversation %s before reading one history page",
    async (channel, expectedTypes) => {
      const { client, headers, botToken, slackUserId } = await fixture();
      let membershipQuery: URLSearchParams | undefined;
      let received: URLSearchParams | undefined;
      let requestedToken: string | null = null;
      const messages = [
        {
          type: "message",
          ts: "1750000001.000001",
          user: "U123",
          text: "A report",
          thread_ts: "1750000001.000001",
          reply_count: 2,
          files: [{ id: "F123", name: "report.pdf" }],
        },
      ];
      server.use(
        http.get(SLACK_USER_CONVERSATIONS_URL, ({ request }) => {
          membershipQuery = new URL(request.url).searchParams;
          return HttpResponse.json({
            ok: true,
            channels: [{ id: channel }],
            response_metadata: { next_cursor: "" },
          });
        }),
        http.get(SLACK_HISTORY_URL, ({ request }) => {
          received = new URL(request.url).searchParams;
          requestedToken = request.headers.get("authorization");
          return HttpResponse.json({
            ok: true,
            messages,
            has_more: true,
            response_metadata: { next_cursor: "next+page=" },
          });
        }),
      );
      const response = await accept(
        client.history({
          headers,
          query: {
            channel,
            limit: 15,
            oldest: "1750000000.000001",
            latest: "1750100000.000001",
            cursor: "previous+page=",
          },
        }),
        [200],
      );
      expect(Object.fromEntries(membershipQuery ?? [])).toStrictEqual({
        user: slackUserId,
        types: expectedTypes,
        limit: "200",
      });
      expect(Object.fromEntries(received ?? [])).toStrictEqual({
        channel,
        limit: "15",
        oldest: "1750000000.000001",
        latest: "1750100000.000001",
        cursor: "previous+page=",
      });
      expect(requestedToken).toBe(`Bearer ${botToken}`);
      expect(response.body).toMatchObject({
        channel,
        messages,
        hasMore: true,
        nextCursor: "next+page=",
      });
    },
  );

  it("continues shared-membership pagination before reading history", async () => {
    const { client, headers } = await fixture();
    const membershipCursors: (string | null)[] = [];
    server.use(
      http.get(SLACK_USER_CONVERSATIONS_URL, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        membershipCursors.push(cursor);
        return cursor
          ? HttpResponse.json({
              ok: true,
              channels: [{ id: "CTARGET" }],
              response_metadata: { next_cursor: "" },
            })
          : HttpResponse.json({
              ok: true,
              channels: [{ id: "COTHER" }],
              response_metadata: { next_cursor: "membership-page-2" },
            });
      }),
      http.get(SLACK_HISTORY_URL, () => {
        return HttpResponse.json({ ok: true, messages: [] });
      }),
    );

    const response = await accept(
      client.history({ headers, query: { channel: "CTARGET", limit: 15 } }),
      [200],
    );

    expect(response.body.messages).toStrictEqual([]);
    expect(membershipCursors).toStrictEqual([null, "membership-page-2"]);
  });

  it("does not read a bot DM that is not shared with the connected user", async () => {
    const { client, headers } = await fixture();
    let historyRequested = false;
    server.use(
      http.get(SLACK_USER_CONVERSATIONS_URL, () => {
        return HttpResponse.json({
          ok: true,
          channels: [],
          response_metadata: { next_cursor: "" },
        });
      }),
      http.get(SLACK_HISTORY_URL, () => {
        historyRequested = true;
        return HttpResponse.json({ ok: true, messages: [] });
      }),
    );

    const response = await accept(
      client.history({ headers, query: { channel: "DOTHER", limit: 15 } }),
      [404],
    );

    expect(response.body.error).toStrictEqual({
      code: "NOT_FOUND",
      message:
        "This Slack conversation does not exist or is not shared by your connected Slack account and Okou.",
    });
    expect(historyRequested).toBeFalsy();
  });

  it("returns an actionable channel URL if the bot leaves after authorization", async () => {
    const { client, headers, installation } = await fixture();
    allowSharedConversation("C123");
    server.use(
      http.get("https://slack.com/api/conversations.history", () => {
        return HttpResponse.json({ ok: false, error: "not_in_channel" });
      }),
    );
    const response = await accept(
      client.history({ headers, query: { channel: "C123", limit: 15 } }),
      [403],
    );
    expect(response.body.error.code).toBe("BOT_NOT_IN_CHANNEL");
    expect(response.body.error.channelUrl).toBe(
      `https://slack.com/app_redirect?team=${installation?.slackWorkspaceId}&channel=C123`,
    );
    expect(response.body.error.message).toContain("Agents & apps");
    expect(response.body.error.message).toContain("then retry");
  });

  it("does not claim an inaccessible channel is known to exist", async () => {
    const { client, headers } = await fixture();
    allowSharedConversation("C123");
    server.use(
      http.get("https://slack.com/api/conversations.history", () => {
        return HttpResponse.json({ ok: false, error: "channel_not_found" });
      }),
    );
    const response = await accept(
      client.history({ headers, query: { channel: "C123", limit: 15 } }),
      [404],
    );
    expect(response.body.error.code).toBe("SLACK_CHANNEL_NOT_FOUND");
    expect(response.body.error.message).toContain(
      "does not exist or is not accessible",
    );
  });

  it.each(["not_in_channel", "channel_not_found"])(
    "does not suggest channel invitations for inaccessible DMs (%s)",
    async (error) => {
      const { client, headers } = await fixture();
      allowSharedConversation("D123");
      server.use(
        http.get("https://slack.com/api/conversations.history", () => {
          return HttpResponse.json({ ok: false, error });
        }),
      );
      const response = await accept(
        client.history({ headers, query: { channel: "D123", limit: 15 } }),
        [404],
      );
      expect(response.body.error.message).toContain(
        "Only direct messages involving Okou",
      );
      expect(response.body.error.message).not.toContain("Agents & apps");
      expect(response.body.error.channelUrl).toBeUndefined();
    },
  );

  it("reports a missing scope while checking shared DM membership", async () => {
    const { client, headers } = await fixture();
    server.use(
      http.get(SLACK_USER_CONVERSATIONS_URL, () => {
        return HttpResponse.json({
          ok: false,
          error: "missing_scope",
          needed: "im:read",
        });
      }),
    );
    const response = await accept(
      client.history({ headers, query: { channel: "D123", limit: 15 } }),
      [403],
    );
    expect(response.body.error.code).toBe("SLACK_MISSING_SCOPE");
    expect(response.body.error.message).toContain(
      "update the Okou app installation",
    );
  });

  it("propagates Slack's retry duration instead of retrying in the request", async () => {
    const { client, headers } = await fixture();
    allowSharedConversation("C123");
    server.use(
      http.get("https://slack.com/api/conversations.history", () => {
        return new HttpResponse(null, {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      }),
    );
    const response = await accept(
      client.history({ headers, query: { channel: "C123", limit: 15 } }),
      [429],
    );
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.body.error).toMatchObject({
      code: "SLACK_RATE_LIMITED",
      retryAfterSeconds: 60,
    });
  });

  it("rejects a write-only run token", async () => {
    const { client, headers } = await fixture({
      capabilities: ["slack:write"],
    });
    const response = await accept(
      client.history({ headers, query: { channel: "C123", limit: 15 } }),
      [403],
    );
    expect(response.body.error.message).toContain("slack:read");
  });

  it("enforces the feature switch even for a token with slack:read", async () => {
    const { client, headers } = await fixture({ enabled: false });
    const response = await accept(
      client.listChannels({ headers, query: { limit: 10 } }),
      [403],
    );
    expect(response.body.error.message).toContain("not enabled");
  });

  it("does not reuse a Slack installation from another organization", async () => {
    await fixture();
    const { client, headers } = await fixture({ installed: false });
    const response = await accept(
      client.history({ headers, query: { channel: "C123", limit: 15 } }),
      [404],
    );
    expect(response.body.error.message).toContain(
      "No Slack installation found for this organization",
    );
  });
});

describe("Slack bot thread replies", () => {
  it.each([
    ["C123", "public_channel,private_channel"],
    ["G123", "public_channel,private_channel"],
    ["D123", "im"],
  ])(
    "reads one page in shared conversation %s using the organization bot",
    async (channel, types) => {
      const { client, headers, botToken, slackUserId } = await fixture();
      const parent = {
        type: "message",
        ts: THREAD_TS,
        text: "Project update",
        reply_count: 2,
        reply_users: ["U123", "B123"],
      };
      const reply = {
        type: "message",
        ts: "1750000001.000001",
        user: "U123",
        text: "Here is the report",
        thread_ts: THREAD_TS,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "Here is the report" },
          },
        ],
        files: [{ id: "F123", name: "report.pdf" }],
      };
      let membershipQuery: URLSearchParams | undefined;
      const requests: {
        token: string | null;
        query: Record<string, string>;
      }[] = [];
      server.use(
        http.get(SLACK_USER_CONVERSATIONS_URL, ({ request }) => {
          membershipQuery = new URL(request.url).searchParams;
          return HttpResponse.json({ ok: true, channels: [{ id: channel }] });
        }),
        http.get(SLACK_REPLIES_URL, ({ request }) => {
          const query = new URL(request.url).searchParams;
          requests.push({
            token: request.headers.get("authorization"),
            query: Object.fromEntries(query),
          });
          return HttpResponse.json(
            query.has("cursor")
              ? {
                  ok: true,
                  messages: [reply],
                  has_more: false,
                  response_metadata: { next_cursor: "" },
                }
              : {
                  ok: true,
                  messages: [parent],
                  has_more: false,
                  response_metadata: { next_cursor: "next+page=" },
                },
          );
        }),
      );
      const first = await accept(
        client.replies({
          headers,
          query: { channel, thread: THREAD_TS, limit: 1 },
        }),
        [200],
      );
      expect(first.body).toMatchObject({
        channel,
        thread: THREAD_TS,
        messages: [parent],
        hasMore: true,
        nextCursor: "next+page=",
      });
      const second = await accept(
        client.replies({
          headers,
          query: {
            channel,
            thread: THREAD_TS,
            limit: 1,
            cursor: first.body.nextCursor ?? undefined,
          },
        }),
        [200],
      );
      expect(second.body).toMatchObject({
        channel,
        thread: THREAD_TS,
        messages: [reply],
        hasMore: false,
        nextCursor: null,
      });
      expect(Object.fromEntries(membershipQuery ?? [])).toStrictEqual({
        user: slackUserId,
        types,
        limit: "200",
      });
      expect(requests).toStrictEqual([
        {
          token: `Bearer ${botToken}`,
          query: { channel, ts: THREAD_TS, limit: "1" },
        },
        {
          token: `Bearer ${botToken}`,
          query: { channel, ts: THREAD_TS, limit: "1", cursor: "next+page=" },
        },
      ]);
    },
  );

  it("keeps time filters and Slack's has_more when a filtered page has no cursor", async () => {
    const { client, headers } = await fixture();
    allowSharedConversation("C123");
    let received: URLSearchParams | undefined;
    server.use(
      http.get(SLACK_REPLIES_URL, ({ request }) => {
        received = new URL(request.url).searchParams;
        return HttpResponse.json({ ok: true, messages: [], has_more: true });
      }),
    );
    const response = await accept(
      client.replies({
        headers,
        query: {
          channel: "C123",
          thread: THREAD_TS,
          limit: 15,
          oldest: "1750000001.000001",
          latest: "1750100000.000001",
          cursor: "previous-page",
        },
      }),
      [200],
    );
    expect(Object.fromEntries(received ?? [])).toStrictEqual({
      channel: "C123",
      ts: THREAD_TS,
      limit: "15",
      oldest: "1750000001.000001",
      latest: "1750100000.000001",
      cursor: "previous-page",
    });
    expect(response.body).toMatchObject({
      messages: [],
      hasMore: true,
      nextCursor: null,
    });
  });

  it("returns only the parent for a message with no replies", async () => {
    const { client, headers } = await fixture();
    allowSharedConversation("C123");
    const parent = { type: "message", ts: THREAD_TS, text: "Project update" };
    server.use(
      http.get(SLACK_REPLIES_URL, () => {
        return HttpResponse.json({ ok: true, messages: [parent] });
      }),
    );
    const response = await accept(
      client.replies({
        headers,
        query: { channel: "C123", thread: THREAD_TS, limit: 15 },
      }),
      [200],
    );
    expect(response.body).toMatchObject({
      messages: [parent],
      hasMore: false,
      nextCursor: null,
    });
  });

  it.each(["COTHER", "DOTHER", "GMPIM"])(
    "does not expose a thread in an unshared channel, another user's DM or group DM (%s)",
    async (channel) => {
      const { client, headers, slackUserId } = await fixture();
      let repliesRequested = false;
      const membershipCursors: (string | null)[] = [];
      server.use(
        http.get(SLACK_USER_CONVERSATIONS_URL, ({ request }) => {
          const query = new URL(request.url).searchParams;
          expect(query.get("user")).toBe(slackUserId);
          expect(query.get("types")).toBe(
            channel.startsWith("D") ? "im" : "public_channel,private_channel",
          );
          membershipCursors.push(query.get("cursor"));
          return HttpResponse.json({
            ok: true,
            channels: [{ id: "CSHARED" }],
            response_metadata: {
              next_cursor: query.has("cursor") ? "" : "page-2",
            },
          });
        }),
        http.get(SLACK_REPLIES_URL, () => {
          repliesRequested = true;
          return HttpResponse.json({ ok: true, messages: [] });
        }),
      );
      const response = await accept(
        client.replies({
          headers,
          query: { channel, thread: THREAD_TS, limit: 15 },
        }),
        [404],
      );
      expect(response.body.error.message).toContain(
        "does not exist or is not shared",
      );
      expect(repliesRequested).toBeFalsy();
      expect(membershipCursors).toStrictEqual([null, "page-2"]);
    },
  );

  it.each([
    {
      options: { capabilities: ["slack:write"] as const },
      status: 403,
      message: "slack:read",
    },
    { options: { enabled: false }, status: 403, message: "not enabled" },
    {
      options: { installed: false },
      status: 404,
      message: "No Slack installation found for this organization",
    },
    {
      options: { connected: false },
      status: 404,
      message: "Slack account is not connected",
    },
  ] as const)(
    "enforces the read boundary: $message",
    async ({ options, status, message }) => {
      await fixture();
      const { client, headers } = await fixture(options);
      const response = await accept(
        client.replies({
          headers,
          query: { channel: "C123", thread: THREAD_TS, limit: 15 },
        }),
        [status],
      );
      expect(response.body.error.message).toContain(message);
    },
  );

  it.each([
    { thread: "invalid" },
    { thread: "1750000000.1234567" },
    { oldest: "20", latest: "10" },
    { cursor: "" },
    { limit: 201 },
  ])(
    "rejects invalid reply queries before reading Slack: %j",
    async (query) => {
      const { client, headers } = await fixture();
      const response = await accept(
        client.replies({
          headers,
          query: { channel: "C123", thread: THREAD_TS, limit: 15, ...query },
        }),
        [400],
      );
      expect(response.body.error.code).toBe("BAD_REQUEST");
    },
  );

  it.each([
    ["thread_not_found", 404, "SLACK_THREAD_NOT_FOUND"],
    ["invalid_ts", 400, "BAD_REQUEST"],
    ["invalid_timestamp", 400, "BAD_REQUEST"],
    ["invalid_cursor", 400, "BAD_REQUEST"],
    ["invalid_ts_oldest", 400, "BAD_REQUEST"],
    ["invalid_ts_latest", 400, "BAD_REQUEST"],
    ["missing_scope", 403, "SLACK_MISSING_SCOPE"],
    ["not_in_channel", 403, "BOT_NOT_IN_CHANNEL"],
    ["channel_not_found", 404, "SLACK_CHANNEL_NOT_FOUND"],
    ["no_permission", 403, "FORBIDDEN"],
    ["method_not_supported_for_channel_type", 400, "BAD_REQUEST"],
    ["service_unavailable", 502, "SLACK_ERROR"],
  ] as const)(
    "reports Slack %s without misclassifying it as OAuth authorization",
    async (error, status, code) => {
      const { client, headers } = await fixture();
      allowSharedConversation("C123");
      server.use(
        http.get(SLACK_REPLIES_URL, () => {
          return HttpResponse.json({ ok: false, error });
        }),
      );
      const response = await accept(
        client.replies({
          headers,
          query: { channel: "C123", thread: THREAD_TS, limit: 15 },
        }),
        [status],
      );
      expect(response.body.error.code).toBe(code);
    },
  );

  it("preserves Retry-After without retrying the thread read", async () => {
    const { client, headers } = await fixture();
    allowSharedConversation("C123");
    let requests = 0;
    server.use(
      http.get(SLACK_REPLIES_URL, () => {
        requests++;
        return new HttpResponse(null, {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      }),
    );
    const response = await accept(
      client.replies({
        headers,
        query: { channel: "C123", thread: THREAD_TS, limit: 15 },
      }),
      [429],
    );
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.body.error).toMatchObject({
      code: "SLACK_RATE_LIMITED",
      retryAfterSeconds: 60,
    });
    expect(requests).toBe(1);
  });
});
