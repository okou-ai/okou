import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { object, string, tuple } from "zod";

import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { connectTeamsAccountForTest } from "./helpers/teams-account";
import {
  postTeamsActivityForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsMessageActivityForTest,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";

const context = testContext();

interface TeamsReply {
  readonly conversationId: string;
  readonly activityId: string;
  readonly body: unknown;
}

/** Records the bot's replies in personal conversations. */
function recordPersonalReplies(
  fixture: TeamsConnectFixture,
  conversationId: string,
): TeamsReply[] {
  const replies: TeamsReply[] = [];
  server.use(
    http.post(
      `${fixture.serviceUrl}v3/conversations/:conversationId/activities/:activityId`,
      async ({ params, request }) => {
        if (params.conversationId !== conversationId) {
          return undefined;
        }
        replies.push({
          conversationId: String(params.conversationId),
          activityId: String(params.activityId),
          body: await request.json(),
        });
        return HttpResponse.json({ id: `reply-${replies.length}` });
      },
    ),
  );
  return replies;
}

/** Teams' member lookup attests the replacement ID for the same AAD user. */
function attestReplacementMember(
  fixture: TeamsConnectFixture,
  replacementTeamsUserId: string,
): void {
  server.use(
    http.get(
      `${fixture.serviceUrl}v3/conversations/:conversationId/members/:memberId`,
      ({ params }) => {
        if (params.memberId !== replacementTeamsUserId) {
          return undefined;
        }
        return HttpResponse.json({
          id: replacementTeamsUserId,
          tenantId: fixture.teamsTenantId,
          aadObjectId: fixture.teamsAadObjectId,
        });
      },
    ),
  );
}

function connectActionUrl(body: unknown): string {
  const parsed = object({
    attachments: tuple([
      object({
        content: object({
          actions: tuple([object({ url: string() })]),
        }),
      }),
    ]),
  }).parse(body);
  return parsed.attachments[0].content.actions[0].url;
}

describe("Teams identity refresh through signed personal messages", () => {
  it("teams-identity-refresh-001 replaces a connected Teams ID when the same AAD user sends from a new ID", async () => {
    setupTeamsConnectTestEnv();
    const fixture = teamsConnectFixture();
    await connectTeamsAccountForTest(context, fixture);
    const replacementTeamsUserId = `29:replacement-${fixture.fixtureId}`;
    attestReplacementMember(fixture, replacementTeamsUserId);
    const personalConversation = `a:personal-${fixture.fixtureId}`;
    const replies = recordPersonalReplies(fixture, personalConversation);

    const sendConnect = async (
      activityId: string,
      from: Readonly<Record<string, string>>,
    ) => {
      const response = await postTeamsActivityForTest({
        signal: context.signal,
        activity: teamsMessageActivityForTest(fixture, {
          id: activityId,
          text: "connect",
          entities: [],
          conversation: {
            id: personalConversation,
            conversationType: "personal",
          },
          replyToId: null,
          from,
        }),
      });
      expect(response.ok).toBeTruthy();
      await flushWaitUntilForTest();
    };

    await sendConnect("original", {
      id: fixture.teamsUserId,
      name: "Ada Lovelace",
      aadObjectId: fixture.teamsAadObjectId,
    });
    await sendConnect("replacement-1", {
      id: replacementTeamsUserId,
      name: "Ada Lovelace",
      aadObjectId: fixture.teamsAadObjectId,
    });
    await sendConnect("replacement-2", {
      id: replacementTeamsUserId,
      name: "Ada Lovelace",
      aadObjectId: fixture.teamsAadObjectId,
    });
    await sendConnect("obsolete", {
      id: fixture.teamsUserId,
      name: "Ada Lovelace",
    });

    expect(
      replies.map((reply) => {
        return reply.activityId;
      }),
    ).toStrictEqual(["original", "replacement-1", "replacement-2", "obsolete"]);
    for (const reply of replies.slice(0, 3)) {
      expect(reply.body).toMatchObject({
        type: "message",
        replyToId: reply.activityId,
        text: expect.stringContaining("You're already connected"),
      });
      expect(reply.body).not.toHaveProperty("attachments");
    }

    const obsolete = replies[3];
    expect(obsolete?.body).toMatchObject({
      replyToId: "obsolete",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            type: "AdaptiveCard",
            actions: [{ type: "Action.OpenUrl", title: "Connect" }],
          },
        },
      ],
    });
    const connectUrl = new URL(connectActionUrl(obsolete?.body));
    expect(`${connectUrl.origin}${connectUrl.pathname}`).toBe(
      "https://app.okou.test/settings/teams",
    );
    expect(connectUrl.searchParams.get("tenantId")).toBe(fixture.teamsTenantId);
    expect(connectUrl.searchParams.get("teamsUserId")).toBe(
      fixture.teamsUserId,
    );
    expect(connectUrl.href).not.toContain(fixture.teamsAadObjectId);
  });
});
