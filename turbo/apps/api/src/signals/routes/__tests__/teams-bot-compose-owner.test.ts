import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { teamsBotIngressResponseSchema } from "@okouai/api-contracts/contracts/teams-bot";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { logsRoutes } from "../logs";
import { teamsConnectRoutes } from "../teams-connect";
import { createRouteMocks } from "./helpers/route-test";
import { connectTeamsAccountForTest } from "./helpers/teams-account";
import {
  installTeamsForTest,
  postTeamsActivityForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsMessageActivityForTest,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";

const context = testContext();

const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });

interface TeamsDelivery {
  readonly type: unknown;
  readonly text: unknown;
}

/** Teams' Bot Framework connector for one conversation records what it receives. */
function recordTeamsConversation(
  fixture: TeamsConnectFixture,
  conversationId: string,
): TeamsDelivery[] {
  const received: TeamsDelivery[] = [];
  const record = async (
    request: Request,
    params: { conversationId?: unknown },
  ) => {
    if (params.conversationId !== conversationId) {
      return;
    }
    const body: unknown = await request.json();
    received.push({
      type:
        typeof body === "object" && body !== null && "type" in body
          ? body.type
          : undefined,
      text:
        typeof body === "object" && body !== null && "text" in body
          ? body.text
          : undefined,
    });
    return HttpResponse.json({ id: `reply-${received.length}` });
  };
  server.use(
    http.post(
      `${fixture.serviceUrl}v3/conversations/:conversationId/activities`,
      ({ request, params }) => {
        return record(request, params);
      },
    ),
    http.post(
      `${fixture.serviceUrl}v3/conversations/:conversationId/activities/:activityId`,
      ({ request, params }) => {
        return record(request, params);
      },
    ),
  );
  return received;
}

async function readMemberState(fixture: TeamsConnectFixture) {
  createRouteMocks(context).clerk.session(fixture.userId, fixture.orgId);
  const status = await accept(
    setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    ).getStatus({ headers: SESSION }),
    [200],
  );
  const runs = await accept(
    setupApp({ context, routes: logsRoutes })(logsListContract).list({
      headers: SESSION,
      query: { limit: 20 },
    }),
    [200],
  );
  return { status: status.body, runs: runs.body.data };
}

describe("Teams bot personal message owner", () => {
  it("teams-bot-compose-owner-003 asks an unidentified Teams sender to connect without starting a Run", async () => {
    const fixture = teamsConnectFixture();
    setupTeamsConnectTestEnv();
    await installTeamsForTest(context.signal, fixture);
    await connectTeamsAccountForTest(context, fixture, { learnSender: false });
    const before = await readMemberState(fixture);
    const personalConversationId = `a:personal-${fixture.fixtureId}`;
    const received = recordTeamsConversation(fixture, personalConversationId);

    const response = await postTeamsActivityForTest({
      signal: context.signal,
      activity: teamsMessageActivityForTest(fixture, {
        id: `activity-anonymous-${fixture.fixtureId}`,
        conversation: {
          id: personalConversationId,
          conversationType: "personal",
        },
        from: { id: "", name: "Unknown sender" },
        text: "summarize the open incidents",
        entities: [],
        replyToId: null,
      }),
    });
    expect(response.status).toBe(200);
    const body = teamsBotIngressResponseSchema.parse(await response.json());
    await flushWaitUntilForTest();

    if (body.activity.kind !== "message") {
      throw new Error(`Expected a Teams message, got ${body.activity.kind}`);
    }
    expect(body.activity).toMatchObject({
      conversationId: personalConversationId,
      conversationType: "personal",
      text: "summarize the open incidents",
      sender: { id: "", aadObjectId: null },
    });
    expect(body.connectUrl ?? null).toBeNull();
    expect(received).toStrictEqual([
      {
        type: "message",
        text: "Please connect your account to use Okou in this Teams workspace.",
      },
    ]);
    const after = await readMemberState(fixture);
    expect(after.runs).toStrictEqual([]);
    expect(after.status).toStrictEqual(before.status);
  });
});
