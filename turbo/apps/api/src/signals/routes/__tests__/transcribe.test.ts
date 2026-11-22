import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { VOICE_TRANSCRIPTION_MODEL } from "@okouai/api-contracts/contracts/voice-clips";
import { transcribeContract } from "@okouai/api-contracts/contracts/transcribe";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { billingStatusRoutes } from "../billing-status";
import { transcribeRoutes } from "../transcribe";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMcpWebApi } from "./helpers/mcp-web-api";
import { mcpSendChatMessageOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-tools";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";
import {
  mockGoogleVoice,
  VERTEX_VOICE_URL,
  type VertexVoiceRequest,
} from "./helpers/google-voice";

const context = testContext();
test("ordered private recordings share one Vertex request and one credit settlement across retries", async () => {
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("Expected organization");
  }
  await createRunsApi(context).grantProEntitlement(actor);
  const mocks = createRouteMocks(context);
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    { [FeatureSwitchKey.VoiceMessages]: true },
  );
  installSharedThreadStorage(context);
  const headers = { authorization: "Bearer clerk-session" };
  const api = setupApp({
    context,
    routes: [
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
      ...transcribeRoutes,
      ...billingStatusRoutes,
    ],
  });
  const uploads = api(uploadsContract);
  const fileIds = [];
  const recordings = ["first recording", "second recording"];
  for (const audio of recordings) {
    const { body } = await accept(
      uploads.preparePrivate({
        headers,
        body: {
          filename: "clip.wav",
          contentType: "audio/wav",
          size: audio.length,
        },
      }),
      [200],
    );
    if (!("uploadUrl" in body)) {
      throw new Error("Expected direct upload");
    }
    expect(
      (
        await fetch(body.uploadUrl, {
          method: "PUT",
          headers: body.uploadHeaders,
          body: audio,
        })
      ).status,
    ).toBe(200);
    await accept(uploads.complete({ headers, body: { id: body.id } }), [200]);
    fileIds.push(body.id);
  }
  const calls: string[][] = [];
  server.use(
    http.post(VERTEX_VOICE_URL, async ({ request }) => {
      const input = (await request.json()) as VertexVoiceRequest;
      calls.push(
        input.contents.flatMap((content) => {
          return content.parts.map((part) => {
            return Buffer.from(
              part.inlineData?.data ?? "",
              "base64",
            ).toString();
          });
        }),
      );
      return HttpResponse.json({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                { text: JSON.stringify({ transcript: "第一段。第二段。" }) },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 1010,
          promptTokensDetails: [
            { modality: "AUDIO", tokenCount: 1000 },
            { modality: "TEXT", tokenCount: 10 },
          ],
          candidatesTokenCount: 8,
        },
      });
    }),
  );
  const body = {
    model: VOICE_TRANSCRIPTION_MODEL,
    fileIds,
    operationId: randomUUID(),
  } as const;
  const credits = async () => {
    return (await accept(api(billingStatusContract).get({ headers }), [200]))
      .body.credits;
  };
  const runs = createRunsApi(context);
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const group = await runs.configureRunnerGroup();
  await runs.ensurePersonalSubscriptionModel(actor);
  const chat = createChatFilesBddApi(context);
  const voice = {
    type: "voice" as const,
    clips: fileIds.map((fileId) => {
      return { fileId };
    }),
  };
  const mcp = createMcpWebApi(context);
  const sent = await mcp.call(mcp.authorize(actor)(), "send_chat_message", {
    userMessage: { version: 1, parts: [voice] },
  });
  expect(sent.isError, JSON.stringify(sent.content)).not.toBeTruthy();
  const accepted = mcpSendChatMessageOutputSchema.parse(sent.structuredContent);
  await flushWaitUntilForTest();
  const history = await chat.listThreadEvents(actor, accepted.threadId);
  const launched = history.events.find((event) => {
    return (
      event.eventType === "input.prompt" &&
      event.revokesEventId === accepted.eventId &&
      event.runId
    );
  });
  if (!launched || launched.eventType !== "input.prompt" || !launched.runId) {
    throw new Error("Expected the MCP voice message to launch a run");
  }
  expect(launched.userMessage?.parts).toContainEqual(voice);
  await runs.heartbeatRunner(group);
  const execution = await runs.executionInput(launched.runId);
  const token = execution.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("Expected run CLI token");
  }
  const cliHeaders = { authorization: `Bearer ${token}` };
  mockGoogleVoice();
  const before = await credits();
  server.use(
    http.post(
      VERTEX_VOICE_URL,
      () => {
        return new HttpResponse(null, { status: 429 });
      },
      {
        once: true,
      },
    ),
  );
  await accept(
    api(transcribeContract).transcribe({ headers: cliHeaders, body }),
    [503],
  );
  await expect(credits()).resolves.toBe(before);
  for (let i = 0; i < 2; i++) {
    const result = await accept(
      api(transcribeContract).transcribe({ headers: cliHeaders, body }),
      [200],
    );
    expect(result.body.transcript).toBe("第一段。第二段。");
    await expect(credits()).resolves.toBe(before - 3);
  }
  expect(calls).toStrictEqual([recordings]);
  await accept(
    api(transcribeContract).transcribe({
      headers: cliHeaders,
      body: { ...body, fileIds: [...fileIds].reverse() },
    }),
    [409],
  );
  const stranger = createBddApi(context).user();
  if (!stranger.orgId) {
    throw new Error("Expected second organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...stranger, orgId: stranger.orgId },
    { [FeatureSwitchKey.VoiceMessages]: true },
  );
  await accept(api(transcribeContract).transcribe({ headers, body }), [404]);
});
