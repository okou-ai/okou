import { randomUUID } from "node:crypto";

import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { sharedThreadRoutes } from "../shared-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextRequest,
  vertexTextResponse,
} from "./helpers/google-text";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = { authorization: "Bearer clerk-session" };

function signIn(user: ApiTestUser | null) {
  if (!user) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }
  createRouteMocks(context).clerk.session(user.userId, user.orgId);
  return headers;
}

function shares() {
  return setupApp({ context, routes: sharedThreadRoutes })(
    sharedThreadsContract,
  );
}

function catalog() {
  return setupApp({ context, routes: artifactCatalogRoutes })(
    artifactCatalogContract,
  );
}

/** A member's Thread with one message per prompt; returns the event IDs. */
async function threadWithMessages(
  member: ApiTestUser,
  prompts: readonly string[],
): Promise<{ readonly threadId: string; readonly eventIds: string[] }> {
  const chat = createChatFilesBddApi(context);
  let threadId: string | undefined;
  for (const prompt of prompts) {
    const sent = await chat.requestSendEvent(
      member,
      { prompt, ...(threadId === undefined ? {} : { threadId }) },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the message to be accepted");
    }
    threadId = sent.body.threadId;
  }
  if (threadId === undefined) {
    throw new Error("Expected at least one message");
  }
  const { events } = await chat.listThreadEvents(member, threadId);
  const eventIds = prompts.map((prompt) => {
    const event = events.find((candidate) => {
      return (
        candidate.eventType === "input.prompt" &&
        candidate.userMessage.parts.some((part) => {
          return part.type === "text" && part.text === prompt;
        })
      );
    });
    if (!event) {
      throw new Error(
        `Expected the message in the Thread: ${JSON.stringify(events).slice(0, 2000)}`,
      );
    }
    return event.id;
  });
  return { threadId, eventIds };
}

async function sharedCatalogEntries(member: ApiTestUser, threadId: string) {
  const listed = await accept(
    catalog().list({
      headers: signIn(member),
      query: { kind: "shared-thread", chatThreadId: threadId },
    }),
    [200],
  );
  return listed.body.artifacts;
}

/** Title model fixture that records every shared-title request it answers. */
function titleModel(text: string) {
  mockGoogleText();
  const requests: ReturnType<typeof vertexTextRequest>[] = [];
  server.use(
    http.post(VERTEX_TEXT_URL, async ({ request }) => {
      requests.push(vertexTextRequest(await request.json(), request.url));
      return vertexTextResponse(text);
    }),
  );
  return requests;
}

describe("client-generated shared-thread IDs", () => {});

describe("optional shared-thread titles", () => {
  it("shared-threads-011 rejects unauthenticated, foreign and empty selections without a share", async () => {
    const bdd = createBddApi(context);
    const owner = bdd.user();
    const teammate = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const stranger = bdd.user();
    const { threadId, eventIds } = await threadWithMessages(owner, [
      "Share the release notes",
    ]);
    const titleRequests = titleModel("Release notes");
    const body = { eventIds };

    await accept(
      shares().create({ headers: signIn(null), params: { threadId }, body }),
      [401],
    );
    await accept(
      shares().create({
        headers: signIn(teammate),
        params: { threadId },
        body,
      }),
      [404],
    );
    await accept(
      shares().create({
        headers: signIn(stranger),
        params: { threadId },
        body,
      }),
      [404],
    );
    const unknown = await accept(
      shares().create({
        headers: signIn(owner),
        params: { threadId },
        body: { eventIds: [randomUUID()] },
      }),
      [400],
    );

    expect(unknown.body.error.code).toBe("NO_SHAREABLE_MESSAGES");
    await expect(sharedCatalogEntries(owner, threadId)).resolves.toStrictEqual(
      [],
    );
    expect(titleRequests).toStrictEqual([]);
  });
});
