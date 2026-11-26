import { mockGoogleText, VERTEX_TEXT_URL } from "./helpers/google-text";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished, beforeEach } from "vitest";

import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { setupApp } from "../../../__tests__/test-helpers";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import type { VertexVoiceRequest } from "./helpers/google-voice";
import { createMcpWebApi } from "./helpers/mcp-web-api";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";
import { accept, testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
beforeEach(() => {
  mockOptionalEnv("GCP_LLM_PROJECT_ID", undefined);
});
const endpoint = VERTEX_TEXT_URL;
// Never part of a request an external caller makes, so anything carrying it
// into a thread came from the provider response.
const secret = "private-provider-payload";
const prompt = "Prepare the launch checklist";

function completion(content = "A usable summary") {
  return HttpResponse.json({
    candidates: [
      {
        finishReason: "STOP",
        content: {
          parts: [
            {
              text: content,
            },
          ],
        },
      },
    ],
  });
}

async function prepareChatTitle() {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const chat = createChatFilesBddApi(context);
  const actor = bdd.user();
  bdd.acceptStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  await runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor);
  let threadId: string | undefined;
  const events = async () => {
    const listed = await accept(
      chat.requestThreadEvents(actor, {}, [200]),
      [200],
    );
    return listed.body.events.filter((event) => {
      return event.chatThreadId === threadId;
    });
  };
  return {
    actor,
    create: async (userMessage?: UserMessageDocument) => {
      const sent = await accept(
        chat.requestSendEvent(
          actor,
          {
            prompt: userMessage ? "[Voice message]" : prompt,
            model: "claude-sonnet-5-5",
            userMessage,
            hasTextContent: true,
          },
          [201],
        ),
        [201],
      );
      threadId = sent.body.threadId;
    },
    events,
    rename: async (value: string) => {
      if (threadId === undefined) {
        throw new Error("Create the conversation before renaming it");
      }
      await accept(
        chat.requestRenameThread(actor, threadId, value, [204]),
        [204],
      );
    },
    titles: async () => {
      return (await events()).flatMap((event) => {
        return event.kind === "renamed" ? [event.title] : [];
      });
    },
  };
}

test("titles a voice-only conversation from its private recordings in order", async () => {
  const chat = await prepareChatTitle();
  installSharedThreadStorage(context);
  const authorize = createMcpWebApi(context).authorize(chat.actor);
  const headers = {
    authorization: `Bearer ${authorize({ scope: "okou:chat:send" })}`,
  };
  const uploads = setupApp({
    context,
    routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
  })(uploadsContract);
  const recordings = [
    "first recording".repeat(4),
    "second recording".repeat(4),
  ];
  const clips = [];
  for (const recording of recordings) {
    const { body } = await accept(
      uploads.preparePrivate({
        headers,
        body: {
          filename: "voice.wav",
          contentType: "audio/wav",
          size: recording.length,
        },
      }),
      [200],
    );
    if (!("uploadUrl" in body)) {
      throw new Error("Expected direct upload");
    }
    const uploaded = await fetch(body.uploadUrl, {
      method: "PUT",
      headers: body.uploadHeaders,
      body: recording,
    });
    expect(uploaded.status).toBe(200);
    await accept(uploads.complete({ headers, body: { id: body.id } }), [200]);
    clips.push({ fileId: body.id });
  }
  mockGoogleText();
  const titleRequests: VertexVoiceRequest[] = [];
  const title = "Plan the next product launch";
  server.use(
    http.post(endpoint, async ({ request }) => {
      const input = (await request.json()) as VertexVoiceRequest;
      if (
        input.systemInstruction.parts[0]?.text.includes(
          "Generate a short, descriptive title",
        )
      ) {
        titleRequests.push(input);
        return completion(title);
      }
      return completion("Thinking");
    }),
  );

  await chat.create({ version: 1, parts: [{ type: "voice", clips }] });
  await flushWaitUntilForTest();

  expect(titleRequests).toHaveLength(1);
  const parts = titleRequests[0]?.contents[0]?.parts ?? [];
  expect(parts.flatMap((part) => part.inlineData ?? [])).toStrictEqual(
    recordings.map((recording) => ({
      mimeType: "audio/wav",
      data: Buffer.from(recording).toString("base64"),
    })),
  );
  expect(parts[0]?.text).not.toContain("okou transcribe");
  await expect(chat.titles()).resolves.toStrictEqual([title]);
});

type TitleCompletion =
  Response | { readonly content: string; readonly finishReason: "length" };

function mockTitleCompletion(response: () => TitleCompletion) {
  createChatCallbacksApi(context).mockVertexCompletions((body) => {
    return body.messages[0]?.content.includes(
      "Generate a short, descriptive title",
    )
      ? response()
      : "Thinking";
  });
}

// One shape per externally distinguishable outcome. Reasons the provider
// classification separates further — which gateway code, which transport
// fault — reach the thread identically, so they are not enumerated again.
const untitledCases = Object.freeze([
  {
    name: "an unavailable provider",
    response: () => {
      return new HttpResponse(secret, { status: 503 });
    },
  },
  {
    name: "rejected credentials",
    response: () => {
      return new HttpResponse(secret, { status: 401 });
    },
  },
  {
    name: "a response that breaks its contract",
    response: () => {
      return new HttpResponse(secret);
    },
  },
  {
    name: "a transport failure",
    response: () => {
      return HttpResponse.error();
    },
  },
  {
    name: "an exhausted token budget",
    response: () => {
      return { content: secret, finishReason: "length" as const };
    },
  },
  {
    name: "generated text that interprets to nothing",
    response: () => {
      return completion("---");
    },
  },
]);

describe("auxiliary generation outcomes", () => {
  it("titles a contextual Slack request using the native thread conversation", async () => {
    const owner = await publicChatActor(context);
    const integrations = createBddIntegrationApi(context);
    integrations.configureSlackAppMocks();
    const slackUserId = "U_TITLE_REQUESTER";
    const { teamId, botUserId } = await owner.run(() => {
      return integrations.installSlackWorkspace(owner.actor, {
        installerSlackUserId: slackUserId,
      });
    });
    const nativeTopic = "The Atlas invoice export duplicates payment rows.";
    const nativeHistory = `${"Investigation notes. ".repeat(30)}${nativeTopic}`;
    const currentRequest = "Please fix this";
    context.mocks.slack.conversations.replies.mockResolvedValue({
      ok: true,
      messages: [
        { ts: "2900.000100", user: slackUserId, text: nativeHistory },
        {
          ts: "2900.000200",
          user: slackUserId,
          text: `<@${botUserId}> ${currentRequest}`,
        },
      ],
    });
    const titleRequests: string[] = [];
    const expectedTitle = "Fix duplicate payments in Atlas invoice exports";
    mockGoogleText();
    createChatCallbacksApi(context).mockVertexCompletions((body) => {
      if (
        body.messages[0]?.content.includes(
          "Generate a short, descriptive title",
        )
      ) {
        const content = body.messages[1]?.content ?? "";
        titleRequests.push(content);
        return content.includes(nativeTopic) ? expectedTitle : "Fix this";
      }
      return "Thinking";
    });

    await owner.run(() => {
      return integrations.postSlackEvent(teamId, {
        type: "app_mention",
        user: slackUserId,
        text: `<@${botUserId}> ${currentRequest}`,
        channel: "C_TITLE_CONTEXT",
        thread_ts: "2900.000100",
        ts: "2900.000200",
      });
    });
    await flushWaitUntilForTest();

    const listed = await accept(
      createChatFilesBddApi(context).requestThreadEvents(
        owner.actor,
        {},
        [200],
      ),
      [200],
    );
    expect(listed.body.events).toContainEqual(
      expect.objectContaining({ kind: "renamed", title: expectedTitle }),
    );
    expect(titleRequests).toHaveLength(1);
    expect(titleRequests[0]).toContain(nativeHistory);
    expect(titleRequests[0]).toContain(
      "You are currently running inside: Slack",
    );
    expect(titleRequests[0]).toContain(currentRequest);
  });

  it("titles the thread from a usable completion", async () => {
    const title = await prepareChatTitle();
    mockGoogleText();
    mockTitleCompletion(() => {
      return completion();
    });
    await title.create();
    await flushWaitUntilForTest();
    await expect(title.titles()).resolves.toStrictEqual(["A usable summary"]);
  });

  it("keeps a member rename when a held title completion arrives later", async () => {
    const title = await prepareChatTitle();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!release.settled()) {
        release.resolve(undefined);
      }
    });
    mockGoogleText();
    createChatCallbacksApi(context).mockVertexCompletions(async (body) => {
      if (
        body.messages[0]?.content.includes(
          "Generate a short, descriptive title",
        )
      ) {
        entered.resolve(undefined);
        await release.promise;
        return "Stale generated title";
      }
      return "Thinking";
    });
    await title.create();
    await entered.promise;
    await title.rename("Member chosen title");
    release.resolve(undefined);
    await flushWaitUntilForTest();
    // The public ordered event stream must contain the member's write only:
    // a generator that lost the conditional UPDATE cannot append a rename.
    await expect(title.titles()).resolves.toStrictEqual([
      "Member chosen title",
    ]);
  });

  it.each(untitledCases)(
    "leaves the thread untitled after $name",
    async ({ response }) => {
      const title = await prepareChatTitle();
      mockGoogleText();
      mockTitleCompletion(response);
      await title.create();
      await flushWaitUntilForTest();
      await expect(title.titles()).resolves.toStrictEqual([]);
      // The thread itself survives a failed optional generation, and nothing
      // the provider sent reaches its metadata.
      const events = await title.events();
      expect(
        events.some((event) => {
          return event.kind === "created";
        }),
      ).toBeTruthy();
      expect(JSON.stringify(events)).not.toContain(secret);
    },
  );

  it("leaves the thread untitled and calls no provider when configuration is missing", async () => {
    const title = await prepareChatTitle();
    mockOptionalEnv("GCP_LLM_PROJECT_ID", undefined);
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests += 1;
        return completion();
      }),
    );
    await title.create();
    await flushWaitUntilForTest();
    await expect(title.titles()).resolves.toStrictEqual([]);
    expect(requests).toBe(0);
  });

  it("finishes a background title that outlives the response within the request lifetime", async () => {
    const title = await prepareChatTitle();
    const titleEntered = createDeferredPromise<void>(context.signal);
    const releaseTitle = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseTitle.settled()) {
        releaseTitle.resolve(undefined);
      }
    });
    mockGoogleText();
    createChatCallbacksApi(context).mockVertexCompletions(async (body) => {
      if (
        body.messages[0]?.content.includes(
          "Generate a short, descriptive title",
        )
      ) {
        titleEntered.resolve(undefined);
        await releaseTitle.promise;
        return "Late generated title";
      }
      return "Thinking";
    });
    await title.create();
    await titleEntered.promise;
    // The response is already delivered while the generation is still running.
    await expect(title.titles()).resolves.toStrictEqual([]);

    let drained = false;
    const drainStarted = createDeferredPromise<void>(context.signal);
    const drain = (async () => {
      drainStarted.resolve(undefined);
      await flushWaitUntilForTest();
      drained = true;
    })();
    await drainStarted.promise;
    // This API read is an observable scheduling boundary. A tracker that lost
    // the held generation would finish draining before the read completes.
    await expect(title.titles()).resolves.toStrictEqual([]);
    expect(drained).toBeFalsy();
    releaseTitle.resolve(undefined);
    await drain;
    expect(drained).toBeTruthy();
    await expect(title.titles()).resolves.toStrictEqual([
      "Late generated title",
    ]);
  });
});
