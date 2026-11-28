import { env, mockOptionalEnv } from "../../../lib/env";
import { sanitizeArtifactFilename } from "../../../lib/file-url";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { array, object, string, union, enum as zEnum } from "zod";

import { testContext } from "../../../__tests__/test-context";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { server } from "../../../mocks/server";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import {
  createBddIntegrationApi,
  mockSlackIdentityLookup,
} from "./helpers/api-bdd-integrations";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import {
  VERTEX_TEXT_URL,
  mockGoogleText,
  vertexTextResponse,
} from "./helpers/google-text";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createPublicSlackOrgApi } from "./helpers/slack-public-install";

function parseVoiceTitleRequest(value: unknown) {
  return object({
    systemInstruction: object({
      parts: array(object({ text: string() })),
    }),
    contents: array(
      object({
        role: zEnum(["user", "model"]),
        parts: array(
          union([
            object({ text: string() }),
            object({
              inlineData: object({
                mimeType: string(),
                data: string(),
              }),
            }),
          ]),
        ),
      }),
    ),
  }).parse(value);
}

describe("auxiliary generation outcomes", () => {
  const context = testContext();

  async function readThreadLifecycleEvents(
    fixture: ReturnType<typeof createChatEventsFixture>,
    actor: ApiTestUser,
    threadId?: string,
  ) {
    const response = await fixture.chat.requestThreadEvents(actor, {}, [200]);
    if (response.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    return threadId === undefined
      ? response.body.events
      : response.body.events.filter((event) => {
          return event.chatThreadId === threadId;
        });
  }

  function renamedTitles(
    events: Awaited<ReturnType<typeof readThreadLifecycleEvents>>,
  ): readonly string[] {
    return events.flatMap((event) => {
      return event.kind === "renamed" && event.title !== null
        ? [event.title]
        : [];
    });
  }

  async function createProSubscriptionMember(
    fixture: ReturnType<typeof createChatEventsFixture>,
  ) {
    const actor = fixture.bdd.user({ orgRole: "org:admin" });
    fixture.chatCallbacks.acceptChatObjectStorage();
    fixture.api.acceptStorageDownloads();
    fixture.api.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    fixture.chatCallbacks.disableVapid();
    mockClaudeCodeTokenEndpoint();

    let restoreExternal = captureConnectorExternalState(context);
    const owner = publicRunOwner(context, actor, {
      continueAcceptedOperations: true,
      restoreEnvironment: () => {
        restoreExternal();
      },
    });

    await owner.run(async () => {
      await Promise.all([
        fixture.api.configureRunnerGroup(),
        fixture.api.grantProEntitlement(actor),
      ]);
      await fixture.api.createPersonalModelProvider(actor, {
        type: "claude-code-oauth-token",
        secret: "bdd-personal-claude-token",
      });
    });
    restoreExternal = captureConnectorExternalState(context);

    return {
      actor,
      model: "claude-fable-5-1" as const,
      run: owner.run,
    };
  }

  async function createBuiltInChatMember(
    fixture: ReturnType<typeof createChatEventsFixture>,
    options: {
      readonly actor?: ApiTestUser;
      readonly runnerAlreadyConfigured?: boolean;
      readonly restoreExtra?: () => void;
    } = {},
  ) {
    const bdd = createBddApi(context);
    const actor = options.actor ?? bdd.user({ orgRole: "org:admin" });
    const storage = fixture.chatCallbacks.acceptChatObjectStorage();
    fixture.api.acceptStorageDownloads();
    fixture.api.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    fixture.chatCallbacks.disableVapid();

    let restoreExternal = captureConnectorExternalState(context);
    const owner = publicRunOwner(context, actor, {
      continueAcceptedOperations: true,
      restoreEnvironment: () => {
        restoreExternal();
        options.restoreExtra?.();
      },
    });

    await owner.run(async () => {
      if (options.runnerAlreadyConfigured) {
        await bdd.bootstrapLimitedFreeOnboarding(actor);
      } else {
        await Promise.all([
          fixture.api.configureRunnerGroup(),
          bdd.bootstrapLimitedFreeOnboarding(actor),
        ]);
      }
    });
    restoreExternal = captureConnectorExternalState(context);

    return {
      actor,
      storage,
      run: owner.run,
    };
  }

  it(
    "auxiliary-generation-002 titles the thread from a usable completion",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const member = await createProSubscriptionMember(fixture);

      fixture.chatCallbacks.mockVertexCompletions(() => {
        return "A usable summary";
      });

      const sent = await member.run(() => {
        return fixture.chat.requestSendEvent(
          member.actor,
          { prompt: "Prepare the launch checklist", model: member.model },
          [201],
        );
      });
      if (sent.status !== 201) {
        throw new Error("Expected chat send to be accepted");
      }

      await flushWaitUntilForTest();

      const events = await readThreadLifecycleEvents(
        fixture,
        member.actor,
        sent.body.threadId,
      );
      expect(renamedTitles(events)).toStrictEqual(["A usable summary"]);
    },
  );

  it(
    "auxiliary-generation-003 keeps a member rename when a held title completion arrives later",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const member = await createProSubscriptionMember(fixture);
      const titleRequested = createDeferredPromise<void>(context.signal);
      const releaseTitle = createDeferredPromise<string>(context.signal);

      fixture.chatCallbacks.mockVertexCompletions(async () => {
        if (!titleRequested.settled()) {
          titleRequested.resolve();
        }
        return await releaseTitle.promise;
      });

      const sent = await member.run(() => {
        return fixture.chat.requestSendEvent(
          member.actor,
          { prompt: "Prepare the launch checklist", model: member.model },
          [201],
        );
      });
      if (sent.status !== 201) {
        throw new Error("Expected chat send to be accepted");
      }

      await titleRequested.promise;

      await fixture.chat.renameThread(
        member.actor,
        sent.body.threadId,
        "Member chosen title",
      );

      releaseTitle.resolve("Stale generated title");
      await flushWaitUntilForTest();

      const events = await readThreadLifecycleEvents(
        fixture,
        member.actor,
        sent.body.threadId,
      );
      expect(renamedTitles(events)).toStrictEqual(["Member chosen title"]);
    },
  );

  it(
    "auxiliary-generation-004 leaves the thread untitled after an unavailable provider",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const member = await createProSubscriptionMember(fixture);
      const privatePayload = "private-upstream-unavailable-503-detail";

      fixture.chatCallbacks.mockVertexCompletions(() => {
        return new HttpResponse(privatePayload, { status: 503 });
      });

      const sent = await member.run(() => {
        return fixture.chat.requestSendEvent(
          member.actor,
          { prompt: "Prepare the launch checklist", model: member.model },
          [201],
        );
      });
      if (sent.status !== 201) {
        throw new Error("Expected chat send to be accepted");
      }

      await flushWaitUntilForTest();

      const events = await readThreadLifecycleEvents(
        fixture,
        member.actor,
        sent.body.threadId,
      );
      expect(renamedTitles(events)).toStrictEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "created",
          chatThreadId: sent.body.threadId,
        }),
      );
      expect(JSON.stringify(events)).not.toContain(privatePayload);
    },
  );

  it(
    "auxiliary-generation-008 leaves the thread untitled after an exhausted token budget",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const member = await createProSubscriptionMember(fixture);
      const privatePayload = "private-truncated-partial-title-fragment";

      fixture.chatCallbacks.mockVertexCompletions(() => {
        return { content: privatePayload, finishReason: "length" };
      });

      const sent = await member.run(() => {
        return fixture.chat.requestSendEvent(
          member.actor,
          { prompt: "Prepare the launch checklist", model: member.model },
          [201],
        );
      });
      if (sent.status !== 201) {
        throw new Error("Expected chat send to be accepted");
      }

      await flushWaitUntilForTest();

      const events = await readThreadLifecycleEvents(
        fixture,
        member.actor,
        sent.body.threadId,
      );
      expect(renamedTitles(events)).toStrictEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "created",
          chatThreadId: sent.body.threadId,
        }),
      );
      expect(JSON.stringify(events)).not.toContain(privatePayload);
    },
  );

  it(
    "auxiliary-generation-009 leaves the thread untitled after generated text that interprets to nothing",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const member = await createProSubscriptionMember(fixture);
      const privatePayload = "---";

      fixture.chatCallbacks.mockVertexCompletions(() => {
        return privatePayload;
      });

      const sent = await member.run(() => {
        return fixture.chat.requestSendEvent(
          member.actor,
          { prompt: "Prepare the launch checklist", model: member.model },
          [201],
        );
      });
      if (sent.status !== 201) {
        throw new Error("Expected chat send to be accepted");
      }

      await flushWaitUntilForTest();

      const events = await readThreadLifecycleEvents(
        fixture,
        member.actor,
        sent.body.threadId,
      );
      expect(renamedTitles(events)).toStrictEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "created",
          chatThreadId: sent.body.threadId,
        }),
      );
      expect(JSON.stringify(events)).not.toContain(privatePayload);
    },
  );

  it(
    "auxiliary-generation-001 titles a contextual Slack request using the native thread conversation",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const integrations = createBddIntegrationApi(context);
      const slackOrg = createPublicSlackOrgApi(context);
      const owner = fixture.bdd.user({ orgRole: "org:admin" });
      const channelId = "C_ATLAS_BILLING";

      const [installed] = await Promise.all([
        slackOrg.installOrg({
          actor: owner,
          withConnection: true,
        }),
        fixture.api.configureRunnerGroup(),
      ]);
      await flushWaitUntilForTest();

      const member = await createBuiltInChatMember(fixture, {
        actor: owner,
        runnerAlreadyConfigured: true,
        restoreExtra: () => {
          context.mocks.slack.apiCall.mockResolvedValue({ ok: true });
          context.mocks.slack.chat.postMessage.mockResolvedValue({
            ok: true,
            ts: "1710000000.000000",
            channel: channelId,
          });
        },
      });

      const colleagueSlackUserId = "U_ATLAS_FINANCE";
      mockSlackIdentityLookup(context, {
        id: colleagueSlackUserId,
        team_id: installed.slackWorkspaceId,
        real_name: "Maya Lin",
        profile: { display_name: "Maya Lin" },
      });

      const threadTs = "1710000100.000100";
      const mentionTs = "1710000100.000200";
      const earlierMessage =
        "We audited the nightly billing pipeline across every regional ledger and compared each exported batch against settled payment settlements for the entire quarter. After verifying the staging join keys and replay logs, the issue is clear: The Atlas invoice export duplicates payment rows.";

      context.mocks.slack.conversations.replies.mockResolvedValue({
        ok: true,
        messages: [
          {
            ts: threadTs,
            user: colleagueSlackUserId,
            text: earlierMessage,
          },
          {
            ts: mentionTs,
            user: installed.slackUserId,
            text: "<@U_OKOU_BOT> Please fix this",
          },
        ],
      });

      const titlePrompts: string[] = [];
      fixture.chatCallbacks.mockVertexCompletions((body) => {
        const prompt =
          body.messages.find((message) => {
            return message.role === "user";
          })?.content ?? "";
        titlePrompts.push(prompt);
        return prompt.includes(
          "The Atlas invoice export duplicates payment rows.",
        )
          ? "Fix duplicate payments in Atlas invoice exports"
          : "Untitled contextual request";
      });

      await member.run(() => {
        return integrations.postSlackEvent(installed.slackWorkspaceId, {
          type: "app_mention",
          user: installed.slackUserId,
          channel: channelId,
          channel_type: "channel",
          ts: mentionTs,
          thread_ts: threadTs,
          text: "<@U_OKOU_BOT> Please fix this",
        });
      });

      await flushWaitUntilForTest();

      const events = await readThreadLifecycleEvents(fixture, member.actor);
      expect(renamedTitles(events)).toStrictEqual([
        "Fix duplicate payments in Atlas invoice exports",
      ]);
      expect(titlePrompts).toHaveLength(1);
      expect(titlePrompts[0]).toContain(earlierMessage);
      expect(titlePrompts[0]).toContain(
        "You are currently running inside: Slack",
      );
      expect(titlePrompts[0]).toContain("Please fix this");
    },
  );

  it(
    "pf-059 titles a voice-only conversation from its private recordings in order",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const member = await createBuiltInChatMember(fixture);
      const privateBucket = env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
      if (!privateBucket) {
        throw new Error("Expected R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
      }

      const uploadPrivateClip = async (
        filename: string,
        contentType: string,
        bytes: Buffer,
      ) => {
        const prepared = await fixture.chat.prepareUpload(member.actor, {
          filename,
          contentType,
          size: bytes.byteLength,
        });
        member.storage.addObject({
          bucket: privateBucket,
          key: `private-artifacts/${prepared.id}/${sanitizeArtifactFilename(filename)}`,
          body: bytes,
          contentType,
          size: bytes.byteLength,
        });
        await fixture.chat.completeUpload(member.actor, { id: prepared.id });
        return {
          id: prepared.id,
          mimeType: contentType,
          base64: bytes.toString("base64"),
        };
      };

      const [uploadedFirst, uploadedSecond] = await Promise.all([
        uploadPrivateClip(
          "clip-one.wav",
          "audio/wav",
          Buffer.from("RIFF-first-voice-recording-payload"),
        ),
        uploadPrivateClip(
          "clip-two.webm",
          "audio/webm",
          Buffer.from("WEBM-second-voice-recording-payload"),
        ),
      ]);
      // Order clips descending by id so SQL/UUID ordering cannot mask clip order.
      const orderedClips =
        uploadedFirst.id.toLowerCase() > uploadedSecond.id.toLowerCase()
          ? [uploadedFirst, uploadedSecond]
          : [uploadedSecond, uploadedFirst];

      const capturedAudio: {
        readonly mimeType: string;
        readonly data: string;
      }[] = [];
      let capturedUserPrompt = "";

      mockGoogleText();
      server.use(
        http.post(VERTEX_TEXT_URL, async ({ request }) => {
          const body = parseVoiceTitleRequest(await request.json());
          const userContent = body.contents.find((entry) => {
            return entry.role === "user";
          });
          const textParts: string[] = [];
          const audioParts: {
            readonly mimeType: string;
            readonly data: string;
          }[] = [];
          for (const part of userContent?.parts ?? []) {
            if ("text" in part) {
              textParts.push(part.text);
            } else {
              audioParts.push(part.inlineData);
            }
          }
          capturedUserPrompt = textParts.join("\n");
          capturedAudio.push(...audioParts);

          const matchesExpectedOrder =
            audioParts.length === 2 &&
            audioParts[0]?.mimeType === orderedClips[0]?.mimeType &&
            audioParts[0]?.data === orderedClips[0]?.base64 &&
            audioParts[1]?.mimeType === orderedClips[1]?.mimeType &&
            audioParts[1]?.data === orderedClips[1]?.base64;

          return vertexTextResponse(
            matchesExpectedOrder
              ? "Quarterly renewal voice memo"
              : "Unexpected clip ordering",
          );
        }),
      );

      const sent = await member.run(() => {
        return fixture.chat.requestSendEvent(
          member.actor,
          {
            prompt: "[Voice message: 2 clips]",
            model: null,
            userMessage: {
              version: 1,
              parts: [
                {
                  type: "voice",
                  clips: orderedClips.map((clip) => {
                    return { fileId: clip.id };
                  }),
                },
              ],
            },
            hasTextContent: true,
          },
          [201],
        );
      });
      if (sent.status !== 201) {
        throw new Error("Expected voice-only chat send to be accepted");
      }

      await flushWaitUntilForTest();

      const events = await readThreadLifecycleEvents(
        fixture,
        member.actor,
        sent.body.threadId,
      );
      expect(renamedTitles(events)).toStrictEqual([
        "Quarterly renewal voice memo",
      ]);
      expect(capturedUserPrompt).toContain(
        "Listen to the attached voice clips in order",
      );
      expect(capturedAudio).toStrictEqual(
        orderedClips.map((clip) => {
          return { mimeType: clip.mimeType, data: clip.base64 };
        }),
      );
    },
  );
});
