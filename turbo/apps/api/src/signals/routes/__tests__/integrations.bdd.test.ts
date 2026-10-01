import {
  captureIntegrationInputUploads,
  expectIntegrationInputPreview,
} from "./helpers/integration-input-assets";
import { seedLegacyMissingDefaultAgentFixture } from "../../../test-fixtures/legacy-default-agent";
import { createHash, createHmac, randomInt, randomUUID } from "node:crypto";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@okouai/api-contracts/contracts/integrations-telegram";
import { CANONICAL_WORKING_DIR } from "@okouai/api-contracts/contracts/runners";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createPiSessionJsonl } from "@okouai/pi-agent-runtime/api";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { HttpResponse, http } from "msw";
import { describe, expect, it, beforeEach } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now, nowDate, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import { installLegacySlackChatCallbackBrandFixture } from "../../../test-fixtures/chat-terminal-retry";
import { seededSystemSkillArchive } from "../../../test-fixtures/seeded-system-skill-archive";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import {
  agentPhoneBddWebhookSecret,
  createBddIntegrationApi,
  telegramLoginAuth,
} from "./helpers/api-bdd-integrations";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { readCompletedRunSessionId } from "./helpers/public-run-session";
import { expectThreadModelCredits } from "./helpers/public-thread-usage";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { seedBuiltInModelCandidateKeys } from "./helpers/runtime-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { readConnectorOAuthAccountMutation } from "./helpers/connector-credential-storage-state";
import { SEEDED_SYSTEM_DEFAULT_MODEL } from "./helpers/seeded-system-default";
/*
helper gap:
- INT-01 Slack channel, message, upload, and download-file happy paths still
  need public API setup journeys for externally observable Slack channel/file
  state without diagnostic fixture routes.
- INT-03 GitHub installed-app and AgentPhone linked-send happy paths need public
  setup APIs for provider installation and downstream agent state before they
  can be covered without diagnostic fixture routes.
*/

const context = testContext({ connectorCatalog: true });
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const connectors = createConnectorBddApi(context);
const integrations = createBddIntegrationApi(context);
const misc = createMiscRoutesApi(context);
const runs = createRunsApi(context);
const runReads = createRunReadsApi(context);
const webhooks = createWebhookCallbackApi(context);
const TELEGRAM_OFFICIAL_WEBHOOK_SECRET = "telegram-official-bdd-secret";

interface SlackEphemeralBody {
  readonly response_type: "ephemeral";
  readonly blocks: readonly unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function slackPlatformError(code: string): Error {
  return Object.assign(new Error(`Slack platform error: ${code}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error: code },
  });
}

function slackRateLimitedError(retryAfter = 0): Error {
  return Object.assign(new Error("Slack request was rate limited"), {
    code: "slack_webapi_rate_limited_error",
    retryAfter,
  });
}

function signedSlackOAuthStateText(location: string | null): string {
  return new URL(location ?? "").searchParams.get("state") ?? "";
}

function decodeSignedSlackOAuthState(state: string): unknown {
  const [encodedPayload, signature, extra] = state.split(".");
  if (!encodedPayload || !signature || extra) {
    throw new Error("Expected signed Slack OAuth state");
  }
  return JSON.parse(Buffer.from(encodedPayload, "base64url").toString());
}

function requireCanonicalSlackInputAssetId(
  events: readonly ChatEvent[],
): string {
  const assetId = events
    .flatMap((event) => {
      if (!("userMessage" in event) || !event.userMessage) {
        return [];
      }
      return event.userMessage.parts.filter((part) => {
        return part.type === "file";
      });
    })
    .find((file) => {
      return file.filenameSnapshot === "source-notes.txt";
    })?.fileId;
  if (!assetId) {
    throw new Error("Expected a canonical Slack input asset");
  }
  return assetId;
}

/** The queued Slack input was claimed into a visible launched message. */
function expectClaimedSlackDisplayMessage(
  events: readonly ChatEvent[],
  messagePermalink: string,
): void {
  const claimedMessage = events.find((message) => {
    return (
      message.eventType === "input.prompt" &&
      message.revokesEventId !== undefined &&
      message.userMessage.parts.some((part) => {
        return (
          part.type === "source" &&
          part.kind === "slack" &&
          part.href === messagePermalink
        );
      })
    );
  });
  expect(claimedMessage).toMatchObject({
    eventType: "input.prompt",
    revokesEventId: expect.any(String),
    runId: expect.any(String),
  });
}

function slackInputMessageByText(
  events: readonly ChatEvent[],
  text: string,
):
  | Extract<
      ChatEvent,
      { readonly eventType: "input.prompt" | "input.rejected" }
    >
  | undefined {
  return events.find(
    (
      message,
    ): message is Extract<
      ChatEvent,
      { readonly eventType: "input.prompt" | "input.rejected" }
    > => {
      if (
        message.eventType !== "input.prompt" &&
        message.eventType !== "input.rejected"
      ) {
        return false;
      }
      return message.userMessage.parts.some((part) => {
        return part.type === "text" && part.text === text;
      });
    },
  );
}

function slackBotOauthResponse(args: {
  readonly accessToken: string;
  readonly botUserId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly authedUserId: string;
  readonly scope: string;
}) {
  return {
    ok: true,
    access_token: args.accessToken,
    bot_user_id: args.botUserId,
    team: { id: args.workspaceId, name: args.workspaceName },
    authed_user: { id: args.authedUserId },
    scope: args.scope,
  };
}

function slackUserOauthResponse(args: {
  readonly workspaceId: string;
  readonly authedUserId: string;
}) {
  return {
    ok: true,
    team: { id: args.workspaceId },
    authed_user: { id: args.authedUserId },
  };
}

function expectSlackEphemeral(
  body: unknown,
): asserts body is SlackEphemeralBody {
  if (
    !isRecord(body) ||
    body.response_type !== "ephemeral" ||
    !Array.isArray(body.blocks)
  ) {
    throw new Error("Expected Slack ephemeral response body");
  }
}

function uniqueSlackUserId(): string {
  return `U_BDD_${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  return `${header}.${base64UrlEncode(JSON.stringify(payload))}.bdd-signature`;
}

function codexFastAuthJson(): string {
  const expiresAt = Math.floor(now() / 1000) + 7200;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: unsignedJwt({ exp: expiresAt }),
      refresh_token: "rt_bdd_slack_fast_mode",
      account_id: "ws_acct_bdd_slack_fast_mode",
      id_token: unsignedJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "ws_acct_bdd_slack_fast_mode_id_token",
          chatgpt_plan_type: "plus",
          organization: { title: "BDD Slack Fast Mode" },
        },
        exp: expiresAt,
      }),
    },
  });
}

async function configureFastCodexPreference(
  actor: ReturnType<typeof integrations.user>,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected the Fast Codex actor to have an org");
  }
  await runs.grantProEntitlement(actor);
  await misc.upsertPersonalModelProvider(
    actor,
    {
      type: "codex-oauth-token",
      authMethod: "auth_json",
      secrets: { CODEX_AUTH_JSON: codexFastAuthJson() },
    },
    [200, 201],
  );
  await runs.updateOrgModelPolicies(actor, [
    {
      model: "gpt-6-astra",
      preferred: true,
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
      modelProviderId: null,
    },
  ]);
  await bdd.readOnboardingStatus(actor);
  await integrations.updateUserModelPreference(
    actor,
    "gpt-6-astra",
    "priority",
  );
}

/**
 * Slack Runner fixtures default to Fable and offer Astra as the Codex choice;
 * both stay on their vendor harnesses, so runs remain claimable native jobs.
 */
function slackPostMessageCallsJson(): string {
  return JSON.stringify(context.mocks.slack.chat.postMessage.mock.calls);
}

async function flushWaitUntilAndAssert(assertion: () => void): Promise<void> {
  await flushWaitUntilForTest();
  assertion();
}

async function pollRunnerRun(
  runnerGroup: string,
  message: string,
): Promise<string> {
  await runs.heartbeatRunner(runnerGroup);
  await flushWaitUntilForTest();
  const poll = await runs.pollRunner(runnerGroup);
  const runId = poll.body.job?.runId;
  if (!runId) {
    throw new Error(message);
  }
  return runId;
}

/** The run's public log entry: trigger source, status and launch prompt. */
async function readRunLog(actor: ApiTestUser, runId: string) {
  return (await runReads.requestReadLogById(actor, runId, [200])).body;
}

/** The caller's Slack-triggered runs from the public logs list. */
async function listSlackRunLogs(actor: ApiTestUser) {
  return (
    await runReads.requestListLogs(
      actor,
      { triggerSource: "slack", limit: 100 },
      [200],
    )
  ).body.data;
}

function launchedBy(runId: string): (event: ChatEvent) => boolean {
  return (event) => {
    return event.eventType === "input.prompt" && event.runId === runId;
  };
}

function hasSlackSource(event: ChatEvent): boolean {
  return (
    "userMessage" in event &&
    event.userMessage?.parts.some((part) => {
      return part.type === "source" && part.kind === "slack";
    }) === true
  );
}

/**
 * The caller's single chat thread whose public events satisfy `matches`,
 * found through the thread lifecycle feed. Returns its created event.
 */
async function ownedThreadWhere(
  actor: ApiTestUser,
  matches: (event: ChatEvent) => boolean,
): Promise<{ readonly chatThreadId: string; readonly agentId: string }> {
  const lifecycle = await chat.requestThreadEvents(actor, {}, [200]);
  if (lifecycle.status !== 200) {
    throw new Error("Expected the caller's chat thread lifecycle events");
  }
  const created = new Map<string, string>();
  for (const event of lifecycle.body.events) {
    if (event.kind === "created") {
      created.set(event.chatThreadId, event.agentId);
    }
  }
  const matched: { chatThreadId: string; agentId: string }[] = [];
  for (const [chatThreadId, agentId] of created) {
    const { events } = await chat.listThreadEvents(actor, chatThreadId);
    if (events.some(matches)) {
      matched.push({ chatThreadId, agentId });
    }
  }
  expect(matched).toHaveLength(1);
  const [thread] = matched;
  if (!thread) {
    throw new Error("Expected exactly one matching chat thread");
  }
  return thread;
}

async function pollSlackRun(runnerGroup: string): Promise<string> {
  return await pollRunnerRun(
    runnerGroup,
    "Expected a Slack-triggered run in the runner queue",
  );
}

async function pollQueuedWebAndSlackRuns(args: {
  readonly actor: ApiTestUser;
  readonly runnerGroup: string;
  readonly expectedSlackSessionId: string;
}): Promise<{
  readonly webRunId: string;
  readonly run2Id?: string;
  readonly claim2?: Awaited<ReturnType<typeof runs.claimRunnerJob>>;
}> {
  const firstQueuedRunId = await pollRunnerRun(
    args.runnerGroup,
    "Expected the queued Web run in the shared thread queue",
  );
  const firstQueuedRunIsSlack =
    (await readRunLog(args.actor, firstQueuedRunId)).triggerSource === "slack";
  if (!firstQueuedRunIsSlack) {
    return { webRunId: firstQueuedRunId };
  }

  const claim2 = await runs.claimRunnerJob(firstQueuedRunId);
  expect(claim2.resumeSession?.sessionId).toBe(args.expectedSlackSessionId);
  return {
    webRunId: await pollRunnerRun(
      args.runnerGroup,
      "Expected the queued Web run in the shared thread queue",
    ),
    run2Id: firstQueuedRunId,
    claim2,
  };
}

async function ensureSlackRunClaimed(args: {
  readonly runnerGroup: string;
  readonly run2Id: string | undefined;
  readonly claim2: Awaited<ReturnType<typeof runs.claimRunnerJob>> | undefined;
}): Promise<{
  readonly run2Id: string;
  readonly claim2: Awaited<ReturnType<typeof runs.claimRunnerJob>>;
}> {
  if (args.run2Id !== undefined && args.claim2 !== undefined) {
    return { run2Id: args.run2Id, claim2: args.claim2 };
  }
  const run2Id = await pollSlackRun(args.runnerGroup);
  return { run2Id, claim2: await runs.claimRunnerJob(run2Id) };
}

async function completeSlackTriggeredRun(args: {
  readonly runId: string;
  readonly sandboxToken: string;
  readonly cliAgentType: string;
  readonly assistantText?: string;
  readonly codexAgentMessageText?: string;
  readonly resultText?: string;
}): Promise<void> {
  const sandboxHeaders = {
    authorization: `Bearer ${args.sandboxToken}`,
  };
  const assistantEvents =
    args.assistantText === undefined
      ? []
      : [
          {
            type: "assistant" as const,
            sequenceNumber: 0,
            message: {
              id: `msg_bdd_slack_${args.runId}`,
              content: [{ type: "text" as const, text: args.assistantText }],
            },
          },
        ];
  const codexEvents =
    args.codexAgentMessageText === undefined
      ? []
      : [
          {
            type: "item.completed" as const,
            sequenceNumber: assistantEvents.length,
            item: {
              id: `item_bdd_slack_${args.runId}`,
              type: "agent_message" as const,
              text: args.codexAgentMessageText,
            },
          },
        ];
  const resultEvents =
    args.resultText === undefined
      ? []
      : [
          {
            type: "result" as const,
            sequenceNumber: assistantEvents.length + codexEvents.length,
            result: args.resultText,
          },
        ];
  const outputEvents = [...assistantEvents, ...codexEvents, ...resultEvents];
  if (outputEvents.length > 0) {
    await webhooks.requestAgentEvents(
      {
        runId: args.runId,
        events: outputEvents,
      },
      sandboxHeaders,
      [200],
    );
  }
  await webhooks.requestAgentComplete(
    {
      runId: args.runId,
      exitCode: 0,
      checkpoint: {
        cliAgentType: args.cliAgentType,
        cliAgentSessionId: `bdd-slack-cli-${args.runId}`,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`bdd slack history ${args.runId}`)
          .digest("hex"),
      },
      ...(outputEvents.length > 0
        ? { lastEventSequence: outputEvents.length - 1 }
        : {}),
    },
    sandboxHeaders,
    [200],
  );
  if (args.resultText !== undefined) {
    await flushWaitUntilForTest();
  }
}

interface PiCheckpointS3Command {
  readonly constructor?: { readonly name?: string };
  readonly input?: {
    readonly Body?: unknown;
    readonly Bucket?: unknown;
    readonly Delete?: {
      readonly Objects?: readonly { readonly Key?: unknown }[];
    };
    readonly Key?: unknown;
  };
}

function piS3ObjectKey(candidate: PiCheckpointS3Command): string | undefined {
  const bucket = candidate.input?.Bucket;
  const key = candidate.input?.Key;
  return typeof bucket === "string" && typeof key === "string"
    ? `${bucket}/${key}`
    : undefined;
}

function requiredPiS3ObjectBody(body: unknown): Buffer {
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  throw new Error("Expected Pi S3 writes to use string or byte bodies");
}

function deletePiCheckpointObjects(
  objects: Map<string, Buffer>,
  candidate: PiCheckpointS3Command,
): void {
  const bucket = candidate.input?.Bucket;
  if (typeof bucket !== "string") {
    return;
  }
  for (const object of candidate.input?.Delete?.Objects ?? []) {
    if (typeof object.Key === "string") {
      objects.delete(`${bucket}/${object.Key}`);
    }
  }
}

function mockPiCheckpointObjectStore(): Map<string, Buffer> {
  const objects = new Map<string, Buffer>();
  for (const [command] of context.mocks.s3.send.mock.calls) {
    const candidate = command as PiCheckpointS3Command;
    const objectKey = piS3ObjectKey(candidate);
    const body = candidate.input?.Body;
    if (
      candidate.constructor?.name === "PutObjectCommand" &&
      objectKey &&
      (typeof body === "string" || body instanceof Uint8Array)
    ) {
      objects.set(
        objectKey,
        typeof body === "string"
          ? Buffer.from(body, "utf8")
          : Buffer.from(body),
      );
    }
  }
  const fallback = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const candidate = command as PiCheckpointS3Command;
    const objectKey = piS3ObjectKey(candidate);
    if (candidate.constructor?.name === "PutObjectCommand" && objectKey) {
      objects.set(objectKey, requiredPiS3ObjectBody(candidate.input?.Body));
      return Promise.resolve({});
    }
    if (candidate.constructor?.name === "GetObjectCommand" && objectKey) {
      const bytes = objects.get(objectKey);
      if (bytes) {
        return Promise.resolve({
          ContentLength: bytes.length,
          Body: (async function* () {
            yield bytes;
          })(),
        });
      }
    }
    if (candidate.constructor?.name === "DeleteObjectsCommand") {
      deletePiCheckpointObjects(objects, candidate);
      return Promise.resolve({});
    }
    return fallback?.(command) ?? Promise.resolve({});
  });
  return objects;
}

function mockPiResourceArchiveDownloads(
  checkpointObjects: ReadonlyMap<string, Buffer>,
): void {
  server.use(
    http.get("https://r2.example.com/storage/archive.tar.gz", ({ request }) => {
      const objectKey = new URL(request.url).searchParams.get("object");
      if (!objectKey) {
        throw new Error("Expected Pi resource archive object identity");
      }
      const bucketPrefix = `${env("R2_USER_STORAGES_BUCKET_NAME")}/`;
      const bytes =
        checkpointObjects.get(objectKey) ??
        (objectKey.startsWith(bucketPrefix)
          ? seededSystemSkillArchive(objectKey.slice(bucketPrefix.length))
          : undefined);
      if (!bytes) {
        throw new Error(`Expected Pi resource archive ${objectKey}`);
      }
      return new HttpResponse(bytes, {
        headers: { "content-type": "application/gzip" },
      });
    }),
  );
}

type SlackPiModel = "gpt-6-luna" | "gpt-5.6-sol" | "gpt-5.6-luna";

interface SlackPiActorSetup {
  readonly selectedModel: SlackPiModel;
  readonly actor: ReturnType<typeof bdd.user>;
  readonly orgId: string;
  readonly runnerGroup: ReturnType<typeof runs.configureRunnerGroup>;
}

async function configureCanonicalSlackPiActor(
  selectedModel: SlackPiModel,
): Promise<SlackPiActorSetup> {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected canonical Slack Pi actor to belong to an org");
  }
  const orgId = actor.orgId;
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  integrations.configureSlackAppMocks();
  await runs.grantProEntitlement(actor);
  const { providerId: anthropicProviderId } =
    await runs.ensureOrgModelProvider(actor);
  const { providerId: openaiProviderId } = await runs.createOrgModelProvider(
    actor,
    {
      type: "openai-api-key",
      secret: "bdd-slack-luna-api-key",
    },
  );
  await runs.updateOrgModelPolicies(actor, [
    {
      model: "claude-fable-5-1",
      preferred: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: anthropicProviderId,
    },
    {
      model: selectedModel,
      defaultProviderType: "openai-api-key",
      credentialScope: "org",
      modelProviderId: openaiProviderId,
    },
  ]);

  await integrations.updateUserModelPreference(actor, "claude-fable-5-1");
  return { actor, orgId, runnerGroup, selectedModel };
}
async function establishCanonicalSlackHistory(args: SlackPiActorSetup) {
  const slackUserId = uniqueSlackUserId();
  const { teamId } = await integrations.installSlackWorkspace(args.actor, {
    installerSlackUserId: slackUserId,
  });
  const channelId = "C_BDD_PI_ADMISSION";
  const threadTs = "2912.000100";
  await integrations.postSlackEvent(teamId, {
    type: "app_mention",
    user: slackUserId,
    text: "establish non-Pi Slack history",
    ts: threadTs,
    channel: channelId,
    channel_type: "channel",
  });
  await flushWaitUntilForTest();
  const historicalRuns = (await listSlackRunLogs(args.actor)).filter((run) => {
    return run.prompt.includes("establish non-Pi Slack history");
  });
  expect(historicalRuns).toHaveLength(1);
  const [historicalRun] = historicalRuns;
  if (!historicalRun) {
    throw new Error("Expected historical Slack ingress to create a run");
  }
  expect(historicalRun).toMatchObject({
    status: "pending",
    triggerSource: "slack",
  });
  const historicalRunId = await pollSlackRun(args.runnerGroup);
  expect(historicalRunId).toBe(historicalRun.id);
  const historicalClaim = await runs.claimRunnerJob(historicalRunId);
  expect(historicalClaim.cliAgentType).toBe("claude-code");
  await completeSlackTriggeredRun({
    runId: historicalRunId,
    sandboxToken: historicalClaim.sandboxToken,
    cliAgentType: historicalClaim.cliAgentType,
    assistantText: "Historical Claude answer",
  });
  await flushWaitUntilForTest();
  const checkpointObjects = mockPiCheckpointObjectStore();
  mockPiResourceArchiveDownloads(checkpointObjects);

  const { chatThreadId } = await ownedThreadWhere(
    args.actor,
    launchedBy(historicalRunId),
  );
  const historicalSessionId = await readCompletedRunSessionId(
    context,
    args.actor,
    historicalRunId,
  );
  await chat.updateThreadModelSelection(
    args.actor,
    chatThreadId,
    args.selectedModel,
  );
  await updateFeatureSwitchesForUser(
    context,
    { ...args.actor, orgId: args.orgId },
    {
      [FeatureSwitchKey.PiMemory]: true,
    },
  );
  return {
    ...args,
    slackUserId,
    teamId,
    channelId,
    threadTs,
    chatThreadId,
    historicalSessionId,
    checkpointObjects,
  };
}

type CanonicalSlackPiScenario = Awaited<
  ReturnType<typeof establishCanonicalSlackHistory>
>;

type SlackPiClaim = Awaited<ReturnType<typeof runs.claimRunnerJob>>;

/**
 * Rebuild the session a claimed Slack Pi Sandbox starts from, as the CLI does:
 * the claim's inline or blob-referenced resume history, else a fresh session.
 */
function readSlackPiSandboxBaseSession(
  scenario: CanonicalSlackPiScenario,
  claim: SlackPiClaim,
): string {
  const resume = claim.resumeSession;
  if (!resume) {
    if (!claim.piSessionId) {
      throw new Error("Expected a claimed Slack Pi session id");
    }
    return createPiSessionJsonl({
      cwd: CANONICAL_WORKING_DIR,
      sessionId: claim.piSessionId,
      timestamp: nowDate().toISOString(),
    });
  }
  if (!("historyRef" in resume)) {
    return resume.sessionHistory;
  }
  expect(resume.historyRef.encoding).toBe("identity");
  const objectKey = new URL(resume.historyRef.url).searchParams.get("object");
  const sessionBytes = objectKey
    ? scenario.checkpointObjects.get(objectKey)
    : undefined;
  if (!sessionBytes) {
    throw new Error("Expected the referenced Slack Pi session bytes");
  }
  return sessionBytes.toString("utf8");
}

/** Complete a claimed Slack Pi turn the way the Sandbox does. */
async function completeSlackPiTurnInSandbox(args: {
  readonly scenario: CanonicalSlackPiScenario;
  readonly runId: string;
  readonly claim: SlackPiClaim;
  readonly prompt: string;
  readonly answer: string;
}): Promise<void> {
  const session = MemoryPiSession.fromJsonl(
    readSlackPiSandboxBaseSession(args.scenario, args.claim),
  );
  session.appendMessage({ role: "user", content: args.prompt, timestamp: 1 });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: args.answer }],
    api: "openai-responses",
    provider: "openai",
    model: args.scenario.selectedModel,
    usage: {
      input: 5,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  const history = session.toJsonl();
  const historyHash = createHash("sha256").update(history).digest("hex");
  const sandboxHeaders = { authorization: `Bearer ${args.claim.sandboxToken}` };
  await webhooks.requestAgentCheckpointPrepareHistory(
    {
      runId: args.runId,
      hash: historyHash,
      rawSize: Buffer.byteLength(history),
      encodedSize: Buffer.byteLength(history),
      encoding: "identity",
    },
    sandboxHeaders,
    [200],
  );
  args.scenario.checkpointObjects.set(
    `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${historyHash}.blob`,
    Buffer.from(history, "utf8"),
  );
  await webhooks.requestAgentEvents(
    {
      runId: args.runId,
      events: [
        {
          type: "assistant",
          sequenceNumber: 1,
          message: { content: [{ type: "text", text: args.answer }] },
        },
        {
          type: "result",
          sequenceNumber: 2,
          result: args.answer,
        },
      ],
    },
    sandboxHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    {
      runId: args.runId,
      exitCode: 0,
      lastEventSequence: 2,
      checkpoint: {
        cliAgentType: "pi",
        cliAgentSessionId: args.scenario.chatThreadId,
        cliAgentSessionHistoryHash: historyHash,
      },
    },
    sandboxHeaders,
    [200],
  );
  await flushWaitUntilForTest();
  expect((await runs.readRun(args.scenario.actor, args.runId)).status).toBe(
    "completed",
  );
}

async function runFirstCanonicalSlackPiTurn(
  scenario: CanonicalSlackPiScenario,
) {
  context.mocks.slack.chat.postMessage.mockClear();
  const prompt = "start fresh Pi on the canonical Slack thread";
  await integrations.postSlackEvent(scenario.teamId, {
    type: "app_mention",
    user: scenario.slackUserId,
    text: prompt,
    ts: "2912.000200",
    thread_ts: scenario.threadTs,
    channel: scenario.channelId,
    channel_type: "channel",
  });
  // Webhook acknowledgement precedes the tracked ingress that creates the run.
  await flushWaitUntilForTest();
  const runId = await pollSlackRun(scenario.runnerGroup);
  expect((await readRunLog(scenario.actor, runId)).prompt).toContain(prompt);
  const claim = await runs.claimRunnerJob(runId, {
    capabilities: { piModelConfigGenerations: [1, 2] },
  });
  return { prompt, runId, claim };
}

async function expectFirstSlackPiExecution(args: {
  readonly scenario: CanonicalSlackPiScenario;
  readonly turn: Awaited<ReturnType<typeof runFirstCanonicalSlackPiTurn>>;
}): Promise<string> {
  const { claim } = args.turn;
  expect(claim.cliAgentType).toBe("pi");
  expect(claim.piSessionId).toBe(args.scenario.chatThreadId);
  expect(claim.piModelConfig).toMatchObject({
    provider: "openai",
    model: args.scenario.selectedModel,
    thinkingLevel: "max",
  });
  // The fresh Pi session still carries the canonical Slack history to the
  // Sandbox that executes the first turn.
  const launchInput = JSON.stringify(claim);
  expect(launchInput).toContain("establish non-Pi Slack history");
  expect(launchInput).toContain("Historical Claude answer");
  expect(launchInput).toContain(args.turn.prompt);
  await completeSlackPiTurnInSandbox({
    scenario: args.scenario,
    runId: args.turn.runId,
    claim,
    prompt: args.turn.prompt,
    answer: "Canonical Slack Pi answer",
  });
  const sessionId = await readCompletedRunSessionId(
    context,
    args.scenario.actor,
    args.turn.runId,
  );
  expect(sessionId).toBe(args.scenario.historicalSessionId);
  return sessionId;
}

async function expectSlackPiOwnership(args: {
  readonly scenario: CanonicalSlackPiScenario;
  readonly runId: string;
  readonly assistantText: string;
}): Promise<void> {
  await flushWaitUntilForTest();
  expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
  expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: args.scenario.channelId,
      thread_ts: args.scenario.threadTs,
      text: args.assistantText,
    }),
  );
  await expectThreadModelCredits(
    context,
    args.scenario.actor,
    args.scenario.chatThreadId,
    0,
  );
  const duplicateClaim = await runs.requestClaimRunnerJob(
    true,
    args.runId,
    [404],
    { capabilities: { piModelConfigGenerations: [1, 2] } },
  );
  expect(duplicateClaim.status).toBe(404);
  const events = (
    await chat.listThreadEvents(args.scenario.actor, args.scenario.chatThreadId)
  ).events;
  expect(
    events.filter((event) => {
      return (
        event.runId === args.runId &&
        event.eventType === "output.message" &&
        event.content === args.assistantText
      );
    }),
  ).toHaveLength(1);
  expect(
    events.filter((event) => {
      return event.runId === args.runId && event.eventType === "run.completed";
    }),
  ).toHaveLength(1);
}

async function claimContinuedSlackPiTurn(args: {
  readonly scenario: CanonicalSlackPiScenario;
  readonly firstPrompt: string;
  readonly firstSessionId: string;
}) {
  context.mocks.slack.chat.postMessage.mockClear();
  const prompt = "continue the same Slack Pi session with a tool";
  await integrations.postSlackEvent(args.scenario.teamId, {
    type: "app_mention",
    user: args.scenario.slackUserId,
    text: prompt,
    ts: "2912.000300",
    thread_ts: args.scenario.threadTs,
    channel: args.scenario.channelId,
    channel_type: "channel",
  });
  const runId = await pollSlackRun(args.scenario.runnerGroup);
  const claim = await runs.claimRunnerJob(runId, {
    capabilities: { piModelConfigGenerations: [1, 2] },
  });
  expect(claim.cliAgentType).toBe("pi");
  expect(claim.piLaunchConfig).toBeDefined();
  expect(claim.piSessionId).toBe(args.scenario.chatThreadId);
  expect(claim.resumeSession).toMatchObject({
    sessionId: args.scenario.chatThreadId,
    historyRef: {
      kind: "blob",
      hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    },
  });
  const history = claim.resumeSession;
  if (!history || !("historyRef" in history)) {
    throw new Error("Expected the continued Pi run to restore native JSONL");
  }
  expect(
    args.scenario.checkpointObjects.has(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${history.historyRef.hash}.blob`,
    ),
  ).toBeTruthy();
  const resumeBytes = readSlackPiSandboxBaseSession(args.scenario, claim);
  expect(resumeBytes).toContain(args.firstPrompt);
  expect(resumeBytes).toContain("Canonical Slack Pi answer");
  await expectThreadModelCredits(
    context,
    args.scenario.actor,
    args.scenario.chatThreadId,
    0,
  );
  return { claim, runId };
}

async function cancelContinuedSlackPiTurn(args: {
  readonly scenario: CanonicalSlackPiScenario;
  readonly turn: Awaited<ReturnType<typeof claimContinuedSlackPiTurn>>;
}): Promise<void> {
  await runs.requestCancelRun(args.scenario.actor, args.turn.runId, [200]);
  await flushWaitUntilForTest();
  await expect(
    (async () => {
      return (await runs.readRun(args.scenario.actor, args.turn.runId)).status;
    })(),
  ).resolves.toBe("cancelled");
  await webhooks.requestAgentComplete(
    { runId: args.turn.runId, exitCode: 1, error: "Run cancelled" },
    { authorization: `Bearer ${args.turn.claim.sandboxToken}` },
    [200],
  );
  await flushWaitUntilForTest();

  expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
  expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: args.scenario.channelId,
      thread_ts: args.scenario.threadTs,
      text: "Run cancelled",
    }),
  );
  const terminalEvents = (
    await chat.listThreadEvents(args.scenario.actor, args.scenario.chatThreadId)
  ).events.filter((event) => {
    return (
      event.runId === args.turn.runId && event.eventType === "run.cancelled"
    );
  });
  expect(terminalEvents).toHaveLength(1);
}

async function runSuccessfulContinuedSlackPiTurn(args: {
  readonly scenario: CanonicalSlackPiScenario;
  readonly firstPrompt: string;
  readonly firstSessionId: string;
}) {
  context.mocks.slack.chat.postMessage.mockClear();
  const prompt = "complete a newer canonical Slack Pi history";
  await integrations.postSlackEvent(args.scenario.teamId, {
    type: "app_mention",
    user: args.scenario.slackUserId,
    text: prompt,
    ts: "2912.000400",
    thread_ts: args.scenario.threadTs,
    channel: args.scenario.channelId,
    channel_type: "channel",
  });
  await flushWaitUntilForTest();
  const completedRunId = await pollSlackRun(args.scenario.runnerGroup);
  const claim = await runs.claimRunnerJob(completedRunId, {
    capabilities: { piModelConfigGenerations: [1, 2] },
  });
  expect(claim.resumeSession).toMatchObject({
    sessionId: args.scenario.chatThreadId,
    historyRef: { kind: "blob" },
  });
  const resumed = readSlackPiSandboxBaseSession(args.scenario, claim);
  expect(resumed).toContain(args.firstPrompt);
  expect(resumed).toContain("Canonical Slack Pi answer");
  await completeSlackPiTurnInSandbox({
    scenario: args.scenario,
    runId: completedRunId,
    claim,
    prompt,
    answer: "Continued Slack Pi answer",
  });
  await expect(
    readCompletedRunSessionId(context, args.scenario.actor, completedRunId),
  ).resolves.toBe(args.firstSessionId);
  return { prompt, runId: completedRunId };
}

function agentPhoneVerificationSend(
  status: 200 | 503 = 200,
  onBody?: (body: unknown) => void,
) {
  return http.post(
    "https://api.agentphone.test/v1/messages",
    async ({ request }) => {
      const body: unknown = await request.json();
      onBody?.(body);
      const toNumber =
        isRecord(body) && typeof body.to_number === "string"
          ? body.to_number
          : null;
      return HttpResponse.json(
        {
          id: "msg-bdd-agentphone",
          status: status === 200 ? "sent" : "failed",
          channel: "sms",
          from_number: "+19039853128",
          to_number: toNumber,
        },
        { status },
      );
    },
  );
}

function uniquePhoneHandle() {
  return `+1555${randomInt(1_000_000, 9_999_999)}`;
}

function agentPhoneWebhookHeaders(
  body: string,
  webhookId = "evt-bdd-agentphone",
): {
  readonly "x-webhook-signature": string;
  readonly "x-webhook-timestamp": string;
  readonly "x-webhook-event": string;
  readonly "x-webhook-id": string;
} {
  const timestamp = String(Math.floor(now() / 1000));
  return {
    "x-webhook-signature": `sha256=${createHmac(
      "sha256",
      agentPhoneBddWebhookSecret(),
    )
      .update(`${timestamp}.${body}`)
      .digest("hex")}`,
    "x-webhook-timestamp": timestamp,
    "x-webhook-event": "agent.message",
    "x-webhook-id": webhookId,
  };
}

function githubConnectSignature(args: {
  readonly installationId: string;
  readonly githubUserId: string;
  readonly timestamp: number;
  readonly githubUsername?: string;
}): string {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(
      [
        args.installationId,
        args.githubUserId,
        String(args.timestamp),
        args.githubUsername?.trim().replace(/^@+/, "") ?? "",
      ].join(":"),
    )
    .digest("hex");
}

describe("INT-01: Slack integration and Slack app routes", () => {
  it("keeps signed Slack Events API URL verification boundaries visible through APIs", async () => {
    mockOptionalEnv("SLACK_SIGNING_SECRET", undefined);
    const unconfigured = await integrations.requestSlackEvent("{}", {}, [503]);
    expect(unconfigured.body).toStrictEqual({
      error: "Slack integration is not configured",
    });

    integrations.configureSlackSigningSecret();
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "slack-bdd-challenge",
    });

    const missingSignature = await integrations.requestSlackEvent(
      body,
      {},
      [401],
    );
    expect(missingSignature.body).toStrictEqual({
      error: "Missing Slack signature headers",
    });

    const invalidSignature = await integrations.requestSlackEvent(
      body,
      {
        ...integrations.signedSlackIngressHeaders(body),
        "x-slack-signature": "v0=invalid",
      },
      [401],
    );
    expect(invalidSignature.body).toStrictEqual({
      error: "Invalid signature",
    });

    const staleTimestamp = String(Math.floor(now() / 1000) - 301);
    const staleSignature = await integrations.requestSlackEvent(
      body,
      integrations.signedSlackIngressHeaders(body, staleTimestamp),
      [401],
    );
    expect(staleSignature.body).toStrictEqual({
      error: "Invalid signature",
    });

    const verified = await integrations.requestSlackEvent(
      body,
      integrations.signedSlackIngressHeaders(body),
      [200],
    );
    expect(verified.body).toStrictEqual({
      challenge: "slack-bdd-challenge",
    });

    const invalidJson = await integrations.requestSlackEvent(
      "not-json",
      integrations.signedSlackIngressHeaders("not-json"),
      [400],
    );
    expect(invalidJson.body).toStrictEqual({
      error: "Invalid JSON payload",
    });

    const eventCallbackBody = (event: unknown, eventId?: string) => {
      return JSON.stringify({
        type: "event_callback",
        team_id: "TBDD_EVENT",
        ...(eventId ? { event_id: eventId } : {}),
        event,
      });
    };

    const retryBody = eventCallbackBody(
      {
        type: "app_mention",
        user: "UBDD_EVENT",
        text: "@Nova retry",
        ts: "1710000000.000200",
        channel: "CBDD_EVENT",
        channel_type: "channel",
      },
      "EvBDD_RETRY_BOUNDARY",
    );
    const retried = await integrations.requestSlackEvent(
      retryBody,
      {
        ...integrations.signedSlackIngressHeaders(retryBody),
        "x-slack-retry-num": "1",
      },
      [200],
    );
    expect(retried.body).toBe("OK");

    const appHomeBody = eventCallbackBody({
      type: "app_home_opened",
      user: "UBDD_EVENT",
      tab: "home",
      channel: "DBDD_EVENT",
    });
    const appHome = await integrations.requestSlackEvent(
      appHomeBody,
      integrations.signedSlackIngressHeaders(appHomeBody),
      [200],
    );
    expect(appHome.body).toBe("OK");

    const messagesTabBody = eventCallbackBody({
      type: "app_home_opened",
      user: "UBDD_EVENT",
      tab: "messages",
      channel: "DBDD_EVENT",
    });
    const messagesTab = await integrations.requestSlackEvent(
      messagesTabBody,
      integrations.signedSlackIngressHeaders(messagesTabBody),
      [200],
    );
    expect(messagesTab.body).toBe("OK");

    const uninstalledBody = eventCallbackBody({ type: "app_uninstalled" });
    const uninstalled = await integrations.requestSlackEvent(
      uninstalledBody,
      integrations.signedSlackIngressHeaders(uninstalledBody),
      [200],
    );
    expect(uninstalled.body).toBe("OK");

    const tokenRevokedBody = eventCallbackBody({
      type: "tokens_revoked",
      tokens: { bot: ["UBOT_BDD_EVENT"] },
    });
    const tokenRevoked = await integrations.requestSlackEvent(
      tokenRevokedBody,
      integrations.signedSlackIngressHeaders(tokenRevokedBody),
      [200],
    );
    expect(tokenRevoked.body).toBe("OK");

    const ignoredBody = JSON.stringify({ type: "team_join" });
    const ignored = await integrations.requestSlackEvent(
      ignoredBody,
      integrations.signedSlackIngressHeaders(ignoredBody),
      [200],
    );
    expect(ignored.body).toBe("OK");
  });

  it("keeps signed Slack command and interactive payload boundaries visible through APIs", async () => {
    integrations.configureSlackSigningSecret();

    const commandBody = (text: string) => {
      return new URLSearchParams({
        team_id: "TBDD",
        channel_id: "CBDD",
        user_id: "UBDD",
        text,
        trigger_id: "trigger-bdd",
      }).toString();
    };

    const helpBody = commandBody("help");
    const help = await integrations.requestSlackCommand(
      helpBody,
      integrations.signedSlackIngressHeaders(helpBody),
      [200],
    );
    expectSlackEphemeral(help.body);
    expect(help.body.blocks.length).toBeGreaterThan(0);

    const connectBody = commandBody("connect");
    const connect = await integrations.requestSlackCommand(
      connectBody,
      integrations.signedSlackIngressHeaders(connectBody),
      [200],
    );
    expectSlackEphemeral(connect.body);
    expect(connect.body.blocks.length).toBeGreaterThan(0);

    const disconnectBody = commandBody("disconnect");
    const disconnect = await integrations.requestSlackCommand(
      disconnectBody,
      integrations.signedSlackIngressHeaders(disconnectBody),
      [200],
    );
    expectSlackEphemeral(disconnect.body);
    expect(disconnect.body.blocks.length).toBeGreaterThan(0);

    const unknownBody = commandBody("unknown");
    const unknown = await integrations.requestSlackCommand(
      unknownBody,
      integrations.signedSlackIngressHeaders(unknownBody),
      [200],
    );
    expectSlackEphemeral(unknown.body);
    expect(unknown.body.blocks.length).toBeGreaterThan(0);

    for (const requiredField of [
      "team_id",
      "channel_id",
      "user_id",
      "trigger_id",
    ]) {
      const missingFieldParams = new URLSearchParams(commandBody("help"));
      missingFieldParams.delete(requiredField);
      const missingFieldBody = missingFieldParams.toString();
      const missingField = await integrations.requestSlackCommand(
        missingFieldBody,
        integrations.signedSlackIngressHeaders(missingFieldBody),
        [400],
      );
      expect(missingField.body).toStrictEqual({
        error: "Missing required Slack command fields",
      });
    }

    const emptyActionPayload = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        team: { id: "TBDD" },
        user: { id: "UBDD" },
        actions: [],
      }),
    }).toString();
    const emptyActions = await integrations.requestSlackInteractive(
      emptyActionPayload,
      integrations.signedSlackIngressHeaders(emptyActionPayload),
      [200],
    );
    expect(emptyActions.body).toBe("");

    const disconnectActionPayload = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        team: { id: "TBDD" },
        user: { id: "UBDD" },
        actions: [{ action_id: "home_disconnect" }],
      }),
    }).toString();
    const homeDisconnect = await integrations.requestSlackInteractive(
      disconnectActionPayload,
      integrations.signedSlackIngressHeaders(disconnectActionPayload),
      [200],
    );
    expect(homeDisconnect.body).toBe("");

    const switchActionPayload = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        team: { id: "TBDD" },
        user: { id: "UBDD" },
        trigger_id: "trigger-bdd",
        actions: [{ action_id: "home_switch_agent" }],
      }),
    }).toString();
    const homeSwitch = await integrations.requestSlackInteractive(
      switchActionPayload,
      integrations.signedSlackIngressHeaders(switchActionPayload),
      [200],
    );
    expect(homeSwitch.body).toBe("");

    const missingPayloadBody = "";
    const missingPayload = await integrations.requestSlackInteractive(
      missingPayloadBody,
      integrations.signedSlackIngressHeaders(missingPayloadBody),
      [400],
    );
    expect(missingPayload.body).toStrictEqual({ error: "Missing payload" });

    const invalidPayloadBody = new URLSearchParams({
      payload: "not-json",
    }).toString();
    const invalidPayload = await integrations.requestSlackInteractive(
      invalidPayloadBody,
      integrations.signedSlackIngressHeaders(invalidPayloadBody),
      [400],
    );
    expect(invalidPayload.body).toStrictEqual({ error: "Invalid payload" });
  });

  it("keeps Slack org and user connect status boundaries visible through APIs", async () => {
    const admin = integrations.user();

    const unauthenticatedOrgStatus =
      await integrations.requestSlackIntegrationStatus(null, [401]);
    expect(unauthenticatedOrgStatus.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const orgStatus = await integrations.requestSlackIntegrationStatus(
      admin,
      [200],
    );
    expect(orgStatus.body).toMatchObject({
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      connectUrl: null,
    });

    const unauthenticatedConnectStatus =
      await integrations.requestSlackConnectStatus(null, [401]);
    expect(unauthenticatedConnectStatus.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const connectStatus = await integrations.requestSlackConnectStatus(
      admin,
      [200],
    );
    expect(connectStatus.body).toStrictEqual({
      isConnected: false,
      isAdmin: true,
    });

    const missingWorkspace = await integrations.requestSlackConnect(
      admin,
      {
        workspaceId: "TBDD",
        slackUserId: "UBDD",
      },
      [404],
    );
    expect(missingWorkspace.body).toStrictEqual({
      error: {
        message: "Slack workspace not found",
        code: "NOT_FOUND",
      },
    });
  });

  it("keeps unauthenticated, not-installed, non-admin, and provider-config errors visible through APIs", async () => {
    const admin = integrations.user();
    const member = integrations.user({
      orgId: admin.orgId,
      orgRole: "org:member",
    });

    const unauthenticatedChannels = await integrations.requestListSlackChannels(
      null,
      [401],
    );
    expect(unauthenticatedChannels.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const missingChannels = await integrations.requestListSlackChannels(
      admin,
      [404],
    );
    expect(missingChannels.body).toStrictEqual({
      error: {
        message: "No Slack installation found for this org",
        code: "NOT_FOUND",
      },
    });

    const unauthenticatedMessage = await integrations.requestSendSlackMessage(
      null,
      {
        channel: "C123",
        text: "BDD Slack message",
      },
      [401],
    );
    expect(unauthenticatedMessage.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const missingMessage = await integrations.requestSendSlackMessage(
      admin,
      {
        channel: "C123",
        text: "BDD Slack message",
      },
      [404],
    );
    expect(missingMessage.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const missingUploadInit = await integrations.requestSlackUploadInit(
      admin,
      {
        filename: "slack-note.txt",
        length: 12,
      },
      [404],
    );
    expect(missingUploadInit.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const missingUploadComplete = await integrations.requestSlackUploadComplete(
      admin,
      {
        fileId: "F123",
        channel: "C123",
        title: "slack-note.txt",
      },
      [404],
    );
    expect(missingUploadComplete.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const unauthenticatedDownload = await integrations.requestSlackDownloadFile(
      null,
      "F123",
      [401],
    );
    expect(unauthenticatedDownload.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const missingDownloadFileId = await integrations.requestSlackDownloadFile(
      admin,
      undefined,
      [400],
    );
    expect(missingDownloadFileId.body).toStrictEqual({
      error: {
        message: "file_id query parameter is required",
        code: "BAD_REQUEST",
      },
    });

    const missingDownloadInstallation =
      await integrations.requestSlackDownloadFile(admin, "F123", [404]);
    expect(missingDownloadInstallation.body).toStrictEqual({
      error: {
        message: "No Slack installation found for this org",
        code: "NOT_FOUND",
      },
    });

    const nonAdminDisconnect = await integrations.requestSlackDisconnect(
      member,
      "delete",
      [404],
    );
    expect(nonAdminDisconnect.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const unauthenticatedDisconnect = await integrations.requestSlackDisconnect(
      null,
      undefined,
      [401],
    );
    expect(unauthenticatedDisconnect.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const nonAdminUninstall = await integrations.requestSlackDisconnect(
      member,
      "uninstall",
      [403],
    );
    expect(nonAdminUninstall.body).toStrictEqual({
      error: {
        message: "Admin access required",
        code: "FORBIDDEN",
      },
    });

    const missingUninstall = await integrations.requestSlackDisconnect(
      admin,
      "uninstall",
      [404],
    );
    expect(missingUninstall.body).toStrictEqual({
      error: {
        message: "No Slack installation found",
        code: "NOT_FOUND",
      },
    });

    const oauthWithoutProviderConfig =
      await integrations.requestSlackOauthInstall({}, [503]);
    expect(oauthWithoutProviderConfig.body).toStrictEqual({
      error: "Slack integration is not configured",
    });

    integrations.configureSlackOauthProvider();
    const slackInstall = await integrations.requestSlackOauthInstall(
      {
        orgId: admin.orgId ?? undefined,
        userId: admin.userId,
        reinstall: "1",
        prompt: "x".repeat(700),
      },
      [307],
    );
    const installLocation = slackInstall.headers.get("location") ?? "";
    const installUrl = new URL(installLocation);
    expect(installUrl.hostname).toBe("slack.com");
    expect(installUrl.searchParams.get("client_id")).toBe(
      "slack-bdd-client-id",
    );
    expect(
      decodeSignedSlackOAuthState(installUrl.searchParams.get("state") ?? ""),
    ).toMatchObject({ reinstall: true });

    const missingConnectParams = await integrations.requestSlackOauthConnect(
      {},
      [400],
    );
    expect(missingConnectParams.body).toStrictEqual({
      error: "Missing orgId or userId",
    });

    const missingConnectInstall = await integrations.requestSlackOauthConnect(
      { orgId: admin.orgId ?? "org_bdd_slack", userId: admin.userId },
      [404],
    );
    expect(missingConnectInstall.body).toStrictEqual({
      error: "No Slack workspace installed for this organization",
    });

    const callbackError = await integrations.requestSlackOauthCallback(
      { error: "access_denied" },
      [307],
    );
    expect(callbackError.headers.get("location") ?? "").toContain(
      "/slack/failed?error=access_denied",
    );

    const callbackMissingCode = await integrations.requestSlackOauthCallback(
      {},
      [400],
    );
    expect(callbackMissingCode.body).toStrictEqual({
      error: "Missing authorization code",
    });
  });

  it("installs, connects, disconnects, and uninstalls a Slack workspace through OAuth APIs", async () => {
    integrations.configureSlackOauthProvider();
    context.mocks.slack.chat.postMessage.mockResolvedValue({
      channel: "D_BDD_SLACK",
      ts: "1710000000.000100",
    });
    context.mocks.slack.chat.postEphemeral.mockResolvedValue({
      ts: "1710000000.000101",
    });
    context.mocks.slack.views.publish.mockResolvedValue({ ok: true });

    const admin = integrations.user();
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected admin test user to have an organization");
    }
    const member = integrations.user({
      orgId,
      orgRole: "org:member",
    });
    const disconnectedMember = integrations.user({
      orgId,
      orgRole: "org:member",
    });
    const workspaceId = `T_BDD_${randomInt(1_000_000, 9_999_999)}`;
    const workspaceName = `BDD Slack ${workspaceId}`;

    const initialInstall = await integrations.requestSlackOauthInstall(
      {
        orgId,
        userId: admin.userId,
        prompt: "install prompt",
      },
      [307],
    );
    const initialInstallUrl = new URL(
      initialInstall.headers.get("location") ?? "",
    );
    const botScope = initialInstallUrl.searchParams.get("scope") ?? "";
    expect(initialInstallUrl.hostname).toBe("slack.com");
    expect(botScope).toContain("chat:write");

    const initialAdminStatus = await integrations.requestSlackIntegrationStatus(
      admin,
      [200],
    );
    expect(initialAdminStatus.body).toMatchObject({
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
    });

    const installStart = await integrations.requestSlackOauthInstall(
      { orgId, userId: admin.userId, prompt: "install prompt" },
      [307],
    );
    context.mocks.slack.oauth.v2.access.mockResolvedValueOnce(
      slackBotOauthResponse({
        accessToken: "xoxb-bdd-slack",
        botUserId: "UBOT_BDD_SLACK",
        workspaceId,
        workspaceName,
        authedUserId: "UADMIN_BDD_SLACK",
        scope: botScope,
      }),
    );
    const installed = await integrations.requestSlackOauthCallback(
      {
        code: "install-code",
        state: signedSlackOAuthStateText(installStart.headers.get("location")),
      },
      [307],
    );
    expect(installed.headers.get("location") ?? "").toContain(
      `/settings/slack?status=connected&workspace=${encodeURIComponent(
        workspaceName,
      )}`,
    );

    const adminStatus = await integrations.requestSlackIntegrationStatus(
      admin,
      [200],
    );
    expect(adminStatus.body).toMatchObject({
      isConnected: true,
      isInstalled: true,
      isAdmin: true,
      workspaceName,
      scopeMismatch: false,
      reinstallUrl: null,
    });

    const memberOrgStatus = await integrations.requestSlackIntegrationStatus(
      member,
      [200],
    );
    expect(memberOrgStatus.body).toMatchObject({
      isConnected: false,
      isInstalled: true,
      isAdmin: false,
    });
    if (!("connectUrl" in memberOrgStatus.body)) {
      throw new Error("Expected Slack member status to include connectUrl");
    }
    expect(memberOrgStatus.body.connectUrl).toContain(
      "/api/slack/oauth/connect",
    );

    const memberConnectStatus = await integrations.requestSlackConnectStatus(
      member,
      [200],
    );
    expect(memberConnectStatus.body).toStrictEqual({
      isConnected: false,
      isAdmin: false,
    });

    const connectStart = await integrations.requestSlackOauthConnect(
      {
        orgId,
        userId: member.userId,
        prompt: "p".repeat(700),
      },
      [307],
    );
    const connectStartUrl = new URL(connectStart.headers.get("location") ?? "");
    expect(connectStartUrl.hostname).toBe("slack.com");
    expect(connectStartUrl.searchParams.get("user_scope")).toBe(
      "identity.basic",
    );
    expect(connectStartUrl.searchParams.get("team")).toBe(workspaceId);
    const connectStateText = connectStartUrl.searchParams.get("state") ?? "";
    const connectState = decodeSignedSlackOAuthState(connectStateText);
    if (!isRecord(connectState)) {
      throw new Error("Expected Slack connect state object");
    }
    expect(connectState).toMatchObject({
      orgId,
      userId: member.userId,
      flow: "connect",
    });
    expect(String(connectState.prompt ?? "")).toHaveLength(500);

    context.mocks.slack.oauth.v2.access.mockResolvedValueOnce(
      slackUserOauthResponse({
        workspaceId,
        authedUserId: "UMEMBER_BDD_SLACK",
      }),
    );
    const connected = await integrations.requestSlackOauthCallback(
      {
        code: "member-connect-code",
        state: connectStateText,
      },
      [307],
    );
    expect(connected.headers.get("location") ?? "").toContain(
      `/settings/slack?status=connected&workspace=${encodeURIComponent(
        workspaceName,
      )}`,
    );

    const connectedMemberStatus = await integrations.requestSlackConnectStatus(
      member,
      [200],
    );
    expect(connectedMemberStatus.body).toMatchObject({
      isConnected: true,
      isAdmin: false,
      workspaceName,
    });

    const disconnectedBeforeWrongTeam =
      await integrations.requestSlackConnectStatus(disconnectedMember, [200]);
    expect(disconnectedBeforeWrongTeam.body).toStrictEqual({
      isConnected: false,
      isAdmin: false,
    });
    const wrongTeamStart = await integrations.requestSlackOauthConnect(
      { orgId, userId: disconnectedMember.userId },
      [307],
    );
    context.mocks.slack.oauth.v2.access.mockResolvedValueOnce(
      slackUserOauthResponse({
        workspaceId: "T_OTHER_BDD_SLACK",
        authedUserId: "UOTHER_BDD_SLACK",
      }),
    );
    const wrongTeam = await integrations.requestSlackOauthCallback(
      {
        code: "wrong-team-code",
        state: signedSlackOAuthStateText(
          wrongTeamStart.headers.get("location"),
        ),
      },
      [307],
    );
    expect(wrongTeam.headers.get("location") ?? "").toContain(
      "different%20Slack%20workspace",
    );
    const disconnectedAfterWrongTeam =
      await integrations.requestSlackConnectStatus(disconnectedMember, [200]);
    expect(disconnectedAfterWrongTeam.body).toStrictEqual({
      isConnected: false,
      isAdmin: false,
    });

    const disconnected = await integrations.requestSlackDisconnect(
      member,
      undefined,
      [200],
    );
    expect(disconnected.body).toStrictEqual({ ok: true });
    const memberAfterDisconnect = await integrations.requestSlackConnectStatus(
      member,
      [200],
    );
    expect(memberAfterDisconnect.body).toStrictEqual({
      isConnected: false,
      isAdmin: false,
    });

    const uninstalled = await integrations.requestSlackDisconnect(
      admin,
      "uninstall",
      [200],
    );
    expect(uninstalled.body).toStrictEqual({ ok: true });
    const adminAfterUninstall =
      await integrations.requestSlackIntegrationStatus(admin, [200]);
    expect(adminAfterUninstall.body).toMatchObject({
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
    });
  });
});

describe("INT-01: Slack app deep webhook flows", () => {
  async function prepareCanonicalSlackContextFailureScenario() {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    integrations.configureSlackAppMocks();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
    const slackUserId = uniqueSlackUserId();
    const { teamId, botUserId } = await integrations.installSlackWorkspace(
      actor,
      { installerSlackUserId: slackUserId },
    );
    const threadTs = "2898.000100";
    const eventId = `EvBDD${randomUUID().replace(/-/g, "")}`;
    const eventBody = JSON.stringify({
      type: "event_callback",
      team_id: teamId,
      event_id: eventId,
      event: {
        type: "app_mention",
        user: slackUserId,
        text: `<@${botUserId}> preserve this current message`,
        ts: "2898.000200",
        thread_ts: threadTs,
        channel: `G_BDD_CONTEXT_${randomUUID().replace(/-/g, "")}`,
        channel_type: "mpim",
      },
    });
    return { teamId, eventBody };
  }

  async function postCanonicalSlackScenario(
    scenario: Awaited<
      ReturnType<typeof prepareCanonicalSlackContextFailureScenario>
    >,
    retryNum?: number,
  ): Promise<void> {
    await integrations.requestSlackEvent(
      scenario.eventBody,
      {
        ...integrations.signedSlackIngressHeaders(scenario.eventBody),
        ...(retryNum === undefined
          ? {}
          : { "x-slack-retry-num": String(retryNum) }),
      },
      [200],
    );
    await flushWaitUntilForTest();
  }

  it("processes the current Slack message without unauthorized optional context", async () => {
    const scenario = await prepareCanonicalSlackContextFailureScenario();
    context.mocks.slack.conversations.replies.mockRejectedValueOnce(
      slackPlatformError("missing_scope"),
    );

    await postCanonicalSlackScenario(scenario);

    const state = await integrations.readSlackTestState(scenario.teamId);
    expect(state.chat_ingress).toHaveLength(1);
    expect(state.chat_ingress[0]).toMatchObject({
      status: "processed",
      processingAttemptCount: 1,
      retryAt: null,
      lastErrorClass: null,
      lastError: null,
    });
    expect(state.recent_runs).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          triggerSource: "slack",
          promptPreview: expect.stringContaining(
            "preserve this current message",
          ),
        }),
      ]),
    );
    expect(context.mocks.slack.conversations.replies).toHaveBeenCalledOnce();
  });

  async function expectPermanentSlackFailureTerminal(): Promise<void> {
    const scenario = await prepareCanonicalSlackContextFailureScenario();
    context.mocks.slack.conversations.replies.mockRejectedValue(
      slackPlatformError("invalid_auth"),
    );

    await postCanonicalSlackScenario(scenario);
    await postCanonicalSlackScenario(scenario, 1);

    const state = await integrations.readSlackTestState(scenario.teamId);
    expect(state.chat_ingress).toHaveLength(1);
    expect(state.chat_ingress[0]).toMatchObject({
      status: "terminal",
      retryCount: 1,
      processingAttemptCount: 1,
      retryAt: null,
      lastErrorClass: "slack:invalid_auth",
      lastError: "Slack platform error: invalid_auth",
    });
    expect(context.mocks.slack.conversations.replies).toHaveBeenCalledOnce();
  }

  it("keeps permanent Slack failures terminal across provider retries", async () => {
    expect.hasAssertions();
    await expectPermanentSlackFailureTerminal();
  });

  it("bounds explicitly retryable Slack failures with backoff", async () => {
    const scenario = await prepareCanonicalSlackContextFailureScenario();
    const startedAt = now();
    context.mocks.slack.conversations.replies.mockRejectedValue(
      slackRateLimitedError(),
    );

    let attemptAt = startedAt;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await withMockNowForTest(attemptAt, async () => {
        await postCanonicalSlackScenario(
          scenario,
          attempt === 1 ? undefined : attempt - 1,
        );
      });
      const state = await integrations.readSlackTestState(scenario.teamId);
      const ingress = state.chat_ingress[0];
      if (!ingress) {
        throw new Error("Expected canonical Slack ingress retry state");
      }
      expect(ingress.processingAttemptCount).toBe(attempt);
      if (attempt < 5) {
        expect(ingress.status).toBe("retryable");
        if (!ingress.retryAt) {
          throw new Error("Expected retryable ingress to have retryAt");
        }
        if (attempt === 1) {
          await withMockNowForTest(attemptAt + 1, async () => {
            await postCanonicalSlackScenario(scenario, 99);
          });
          expect(
            context.mocks.slack.conversations.replies,
          ).toHaveBeenCalledTimes(1);
        }
        attemptAt = Date.parse(ingress.retryAt) + 1;
      } else {
        expect(ingress).toMatchObject({
          status: "terminal",
          retryAt: null,
          lastErrorClass: "attempts_exhausted",
        });
      }
    }

    await withMockNowForTest(attemptAt + 24 * 60 * 60 * 1000, async () => {
      await postCanonicalSlackScenario(scenario, 100);
    });
    expect(context.mocks.slack.conversations.replies).toHaveBeenCalledTimes(5);
  });

  it("keeps failed canonical inputs inert across historical reads", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    integrations.configureSlackAppMocks();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
    if (!actor.orgId) {
      throw new Error("Expected historical Slack actor to belong to an org");
    }
    const slackUserId = uniqueSlackUserId();
    const { teamId, botUserId } = await integrations.installSlackWorkspace(
      actor,
      {
        installerSlackUserId: slackUserId,
      },
    );
    const channelId = "C_BDD_HISTORICAL_ASSET";
    const threadTs = "2899.000100";
    const eventId = `EvBDD${randomUUID().replace(/-/g, "")}`;
    const fileBody = "historical canonical Slack attachment";
    const eventBody = JSON.stringify({
      type: "event_callback",
      team_id: teamId,
      event_id: eventId,
      event: {
        type: "app_mention",
        user: slackUserId,
        text: `<@${botUserId}> materialize this historical file`,
        ts: threadTs,
        channel: channelId,
        channel_type: "channel",
        files: [
          {
            id: `F_HISTORICAL_${randomUUID().replace(/-/g, "")}`,
            name: "source-notes.txt",
            mimetype: "text/plain",
            size: fileBody.length,
            url_private_download:
              "https://files.slack.com/F_HISTORICAL_CANONICAL_INPUT",
          },
        ],
      },
    });
    context.mocks.slack.fetchFile.mockRejectedValueOnce(
      new Error("initial canonical Slack fetch failed"),
    );
    await integrations.requestSlackEvent(
      eventBody,
      integrations.signedSlackIngressHeaders(eventBody),
      [200],
    );
    await flushWaitUntilForTest();

    const { chatThreadId } = await ownedThreadWhere(actor, hasSlackSource);
    context.mocks.slack.fetchFile.mockClear();
    context.mocks.slack.fetchFile.mockRejectedValue(
      new Error("historical reads must not fetch Slack files"),
    );

    const listedMessages = (
      await chat.listThreadEvents(actor, chatThreadId)
    ).events.filter((message) => {
      return (
        "userMessage" in message &&
        message.userMessage?.parts.some((part) => {
          return part.type === "file";
        }) === true
      );
    });
    const assetId = requireCanonicalSlackInputAssetId(listedMessages);
    const listedMessage = listedMessages.find((message) => {
      return (
        "userMessage" in message &&
        message.userMessage?.parts.some((part) => {
          return part.type === "file" && part.fileId === assetId;
        }) === true
      );
    });
    expect(listedMessage).toMatchObject({
      userMessage: {
        parts: expect.arrayContaining([
          expect.objectContaining({ type: "file", fileId: assetId }),
        ]),
      },
    });
    expect(context.mocks.slack.fetchFile).not.toHaveBeenCalled();
  });

  it("preserves a mention-only Slack request with the preceding link and image", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    integrations.configureSlackAppMocks();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
    const slackUserId = uniqueSlackUserId();
    const { teamId, botUserId } = await integrations.installSlackWorkspace(
      actor,
      { installerSlackUserId: slackUserId },
    );
    const threadTs = "2900.000100";
    const messageTs = "2900.000200";
    context.mocks.slack.conversations.replies.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: threadTs,
          user: slackUserId,
          text: "This article is still broken: https://example.com/article",
          files: [
            {
              id: "F_ARTICLE_SCREENSHOT",
              name: "article.png",
              mimetype: "image/png",
            },
          ],
        },
        { ts: messageTs, user: slackUserId, text: `<@${botUserId}>` },
      ],
    });

    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: `<@${botUserId}>`,
      channel: "C_BDD_MENTION_CONTEXT",
      thread_ts: threadTs,
      ts: messageTs,
    });
    const runId = await pollSlackRun(runnerGroup);
    const claim = await runs.claimRunnerJob(runId);
    expect(claim.prompt).toBe(`@Slack User (${botUserId})`);
    expect(claim.appendSystemPrompt).toContain("https://example.com/article");
    expect(claim.appendSystemPrompt).toContain("[ID] F_ARTICLE_SCREENSHOT");
    await completeSlackTriggeredRun({
      runId,
      sandboxToken: claim.sandboxToken,
      cliAgentType: claim.cliAgentType,
      assistantText: "Investigating the article and screenshot",
    });
  });

  it.each([false, true])(
    "deduplicates canonical Slack retries and preserves same-name mention identities (private=%s)",
    async (privateFiles) => {
      const actor = bdd.user();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      integrations.configureSlackAppMocks();
      await runs.grantProEntitlement(actor);
      await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
      const slackUserId = uniqueSlackUserId();
      const mentionedSlackUserId = uniqueSlackUserId();
      const secondMentionedSlackUserId = uniqueSlackUserId();
      const { teamId, botUserId } = await integrations.installSlackWorkspace(
        actor,
        {
          installerSlackUserId: slackUserId,
        },
      );
      if (!actor.orgId) {
        throw new Error("Expected organization");
      }
      const flagActor = { ...actor, orgId: actor.orgId };
      await updateFeatureSwitchesForUser(context, flagActor, {
        [FeatureSwitchKey.PrivateArtifacts]: privateFiles,
      });
      const uploads = captureIntegrationInputUploads(context);
      const channelId = "C_BDD_CANONICAL_INGRESS";
      const threadTs = "2900.000100";
      const eventId = `EvBDD${randomUUID().replace(/-/g, "")}`;
      const fileUrl = "https://files.slack.com/F_CANONICAL_INPUT";
      const fileBody = "canonical Slack attachment";
      const originalMessageText = `<@${botUserId}> admit this event once with <@${mentionedSlackUserId}> and <@${secondMentionedSlackUserId}>`;
      const visibleMessageText =
        "@Slack User admit this event once with @Slack User and @Slack User";
      context.mocks.slack.fetchFile.mockResolvedValue(
        new Response(fileBody, {
          headers: { "Content-Type": "text/plain" },
        }),
      );
      const event = {
        type: "app_mention",
        user: slackUserId,
        text: originalMessageText,
        ts: threadTs,
        channel: channelId,
        channel_type: "channel",
        files: [
          {
            id: "F_CANONICAL_INPUT",
            // Resolve a generic MIME type from the validated download response.
            name: "source-notes.txt",
            mimetype: "application/octet-stream",
            size: fileBody.length,
            url_private_download: fileUrl,
          },
        ],
      };
      const eventBody = JSON.stringify({
        type: "event_callback",
        team_id: teamId,
        event_id: eventId,
        event,
      });
      await integrations.requestSlackEvent(
        eventBody,
        integrations.signedSlackIngressHeaders(eventBody),
        [200],
      );
      for (const retryNum of ["1", "2", "3"]) {
        await integrations.requestSlackEvent(
          eventBody,
          {
            ...integrations.signedSlackIngressHeaders(eventBody),
            "x-slack-retry-num": retryNum,
          },
          [200],
        );
      }
      await flushWaitUntilForTest();

      // The original delivery and its three provider retries admit one
      // input on one thread and launch exactly one Slack run.
      const { chatThreadId: canonicalChatThreadId } = await ownedThreadWhere(
        actor,
        hasSlackSource,
      );
      const slackRuns = await listSlackRunLogs(actor);
      expect(slackRuns).toHaveLength(1);
      expect(slackRuns[0]?.prompt).toContain("admit this event once");
      expect(
        context.mocks.slack.assistant.threads.setStatus,
      ).toHaveBeenCalledOnce();
      expect(
        context.mocks.slack.assistant.threads.setStatus,
      ).toHaveBeenCalledWith({
        channel_id: channelId,
        thread_ts: threadTs,
        status: "is thinking...",
      });
      const run1Id = await pollSlackRun(runnerGroup);
      const claim1 = await runs.claimRunnerJob(run1Id);

      const visibleThreadEvents = await chat.requestThreadEvents(
        actor,
        {},
        [200],
      );
      expect(visibleThreadEvents.status).toBe(200);
      if (visibleThreadEvents.status !== 200) {
        throw new Error("Expected visible thread events to load");
      }
      expect(
        visibleThreadEvents.body.events.map((threadEvent) => {
          return threadEvent.chatThreadId;
        }),
      ).toContain(canonicalChatThreadId);
      expect(
        (await chat.requestReadThread(actor, canonicalChatThreadId, [200]))
          .status,
      ).toBe(200);
      const visibleMessages = (
        await chat.listThreadEvents(actor, canonicalChatThreadId)
      ).events;
      const canonicalInputAssetId =
        requireCanonicalSlackInputAssetId(visibleMessages);
      await updateFeatureSwitchesForUser(context, flagActor, {
        [FeatureSwitchKey.PrivateArtifacts]: !privateFiles,
      });
      await expectIntegrationInputPreview(context, {
        actor,
        privateFiles,
        fileId: canonicalInputAssetId,
        contentType: "text/plain",
        bytes: Buffer.from(fileBody),
        uploads,
        okouToken: claim1.platformEnvironment.OKOU_TOKEN,
      });
      const canonicalInputMessage = slackInputMessageByText(
        visibleMessages,
        visibleMessageText,
      );
      if (!canonicalInputMessage) {
        throw new Error("Expected the canonical Slack input message");
      }
      expect(visibleMessages).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "input.prompt",
            content: null,
            userMessage: {
              version: 1,
              parts: [
                {
                  type: "file",
                  fileId: canonicalInputAssetId,
                  filenameSnapshot: "source-notes.txt",
                  contentType: "text/plain",
                },
                {
                  type: "text",
                  text: visibleMessageText,
                },
                {
                  type: "source",
                  kind: "slack",
                  href: "https://vm0.slack.com/archives/C_BDD_CANONICAL_INGRESS/p2900000100",
                },
              ],
            },
          }),
        ]),
      );
      expect(
        visibleMessages
          .filter((message) => {
            return (
              message.eventType === "input.prompt" ||
              message.eventType === "input.rejected"
            );
          })
          .every((message) => {
            return message.content === null;
          }),
      ).toBeTruthy();
      expectClaimedSlackDisplayMessage(
        visibleMessages,
        "https://vm0.slack.com/archives/C_BDD_CANONICAL_INGRESS/p2900000100",
      );
      const canonicalInputRun = await runs.readRun(actor, run1Id);
      expect(canonicalInputRun.prompt).toBe(
        `@Slack User (${botUserId}) admit this event once with @Slack User (${mentionedSlackUserId}) and @Slack User (${secondMentionedSlackUserId})\n\n[Web file] source-notes.txt (text/plain)\n   [ID] ${canonicalInputAssetId}`,
      );
      // The Slack delivery rules follow the integration block as their own
      // section rather than sitting in `# Agent Tools`.
      expect(canonicalInputRun.appendSystemPrompt).toContain(
        `# Current Integration\nYou are currently running inside: Slack\nYour bot user ID: ${botUserId}\nChannel ID: ${channelId}\nChannel type: Channel\nThread ID: ${threadTs}\n\n# Integration Note\n\n- Slack messaging and files: only your final reply is delivered to the originating thread,`,
      );
      // A private artifact address is unopenable from Slack, so the note asks
      // for an upload while retaining the address for Web, only when private
      // artifacts are on for this member.
      // This member holds the switch through an override, not a staff
      // organization, so it also pins that the note reads the same
      // override-aware evaluation as `# Agent Tools`.
      const privateArtifactRule =
        "- Private artifacts in the final reply: weigh this only while composing the final reply, never during the run. This upload guidance applies to replies in Slack. If the user continues the conversation in Web chat, deliver files there and do not continue uploading to Slack unless the user explicitly requests it. A private `/artifacts/...` address is not openable from Slack, so a link alone shows the user nothing. When you judge that Slack can display that kind of file — a hosted website or HTML page never qualifies — upload it with `okou slack upload-file` so the user has something they can open there. If you upload it, also keep the original private `/artifacts/...` address from before the upload in the final reply, not the address returned by `okou slack upload-file`, so the owner can open the original artifact after returning to the web app.";
      if (privateFiles) {
        expect(canonicalInputRun.appendSystemPrompt).toContain(
          privateArtifactRule,
        );
      } else {
        expect(canonicalInputRun.appendSystemPrompt).not.toContain(
          "Private artifacts in the final reply",
        );
      }
      expect(canonicalInputRun.appendSystemPrompt).toContain(
        "okou web download-file -h",
      );
      expect(context.mocks.slack.chat.getPermalink).toHaveBeenCalledWith({
        channel: channelId,
        message_ts: threadTs,
      });
      await completeSlackTriggeredRun({
        runId: run1Id,
        sandboxToken: claim1.sandboxToken,
        cliAgentType: claim1.cliAgentType,
        assistantText: "Canonical Slack retry answer",
      });
      await flushWaitUntilForTest();
      if (!actor.orgId) {
        throw new Error("Expected canonical Slack actor to belong to an org");
      }
    },
  );

  it("keeps queued Web and Slack inputs on one canonical route", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    integrations.configureSlackAppMocks();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
    const slackUserId = uniqueSlackUserId();
    const { teamId, botUserId } = await integrations.installSlackWorkspace(
      actor,
      {
        installerSlackUserId: slackUserId,
      },
    );
    const channelId = "C_BDD_CANONICAL_SESSION";
    const threadTs = "2901.000100";
    const eventId = "EvBDD" + randomUUID().replace(/-/g, "");
    const fileBody = "canonical Slack session attachment";
    context.mocks.slack.fetchFile.mockResolvedValue(
      new Response(fileBody, {
        headers: { "Content-Type": "text/plain" },
      }),
    );
    const event = {
      type: "app_mention",
      user: slackUserId,
      text: "<@" + botUserId + "> establish the canonical session",
      ts: threadTs,
      channel: channelId,
      channel_type: "channel",
      files: [
        {
          id: "F_CANONICAL_SESSION",
          name: "session-notes.txt",
          mimetype: "text/plain",
          size: fileBody.length,
          url_private_download: "https://files.slack.com/F_CANONICAL_SESSION",
        },
      ],
    };
    const eventBody = JSON.stringify({
      type: "event_callback",
      team_id: teamId,
      event_id: eventId,
      event,
    });
    await integrations.requestSlackEvent(
      eventBody,
      integrations.signedSlackIngressHeaders(eventBody),
      [200],
    );
    await flushWaitUntilForTest();

    const run1Id = await pollSlackRun(runnerGroup);
    // The Slack route's thread and the agent it launched with are public
    // through the caller's thread lifecycle.
    const { chatThreadId: canonicalChatThreadId, agentId: defaultAgentId } =
      await ownedThreadWhere(actor, launchedBy(run1Id));
    const claim1 = await runs.claimRunnerJob(run1Id);
    const queuedWebMessage = await chat.requestSendEvent(
      actor,
      {
        agentId: defaultAgentId,
        prompt: "keep the web session separate",
        threadId: canonicalChatThreadId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    expect(queuedWebMessage.body).toMatchObject({
      runId: null,
      threadId: canonicalChatThreadId,
    });

    const stickyEventId = `EvBDD${randomUUID().replace(/-/g, "")}`;
    context.mocks.slack.chat.getPermalink.mockResolvedValueOnce({
      ok: false,
      error: "permalink_unavailable",
    });
    const stickyBody = JSON.stringify({
      type: "event_callback",
      team_id: teamId,
      event_id: stickyEventId,
      event: {
        ...event,
        text: "stay canonical on the same route",
        ts: "2900.000200",
        thread_ts: threadTs,
      },
    });
    await integrations.requestSlackEvent(
      stickyBody,
      integrations.signedSlackIngressHeaders(stickyBody),
      [200],
    );
    await flushWaitUntilForTest();

    // The sticky reply joins the same canonical thread: one thread holds every
    // Slack input, and both deliveries were admitted without a run yet.
    const { chatThreadId: stickyThreadId } = await ownedThreadWhere(
      actor,
      hasSlackSource,
    );
    expect(stickyThreadId).toBe(canonicalChatThreadId);
    const queuedEvents = (
      await chat.listThreadEvents(actor, canonicalChatThreadId)
    ).events;
    const stickyVisibleMessage = slackInputMessageByText(
      queuedEvents,
      "stay canonical on the same route",
    );
    expect(stickyVisibleMessage).toMatchObject({
      eventType: "input.prompt",
    });
    expect(stickyVisibleMessage?.runId).toBeUndefined();
    expect(
      stickyVisibleMessage?.userMessage.parts.find((part) => {
        return part.type === "source";
      }),
    ).toStrictEqual({ type: "source", kind: "slack" });
    expect(
      slackInputMessageByText(queuedEvents, "keep the web session separate")
        ?.runId,
    ).toBeUndefined();

    // Draining the thread launches the queued Web input first, then the Slack
    // reply with the launch context admitted for it.
    await completeSlackTriggeredRun({
      runId: run1Id,
      sandboxToken: claim1.sandboxToken,
      cliAgentType: claim1.cliAgentType,
      assistantText: "Canonical Slack answer one",
    });
    await flushWaitUntilForTest();
    const queuedRuns = await pollQueuedWebAndSlackRuns({
      actor,
      runnerGroup,
      expectedSlackSessionId: `bdd-slack-cli-${run1Id}`,
    });
    const webRunId = queuedRuns.webRunId;
    await expect(readRunLog(actor, webRunId)).resolves.toMatchObject({
      triggerSource: "web",
    });
    if (queuedRuns.run2Id === undefined) {
      const webClaim = await runs.claimRunnerJob(webRunId);
      await completeSlackTriggeredRun({
        runId: webRunId,
        sandboxToken: webClaim.sandboxToken,
        cliAgentType: webClaim.cliAgentType,
        assistantText: "Web answer stays off Slack",
      });
      await flushWaitUntilForTest();
    }
    const { run2Id, claim2 } = await ensureSlackRunClaimed({
      runnerGroup,
      run2Id: queuedRuns.run2Id,
      claim2: queuedRuns.claim2,
    });
    await expect(readRunLog(actor, run2Id)).resolves.toMatchObject({
      triggerSource: "slack",
    });
    expect(claim2.prompt).toContain("stay canonical on the same route");
    expect(claim2.prompt).toContain("session-notes.txt");
    expect(claim2.appendSystemPrompt).toContain(
      `# Current Integration\nYou are currently running inside: Slack\nYour bot user ID: ${botUserId}\nChannel ID: ${channelId}\nChannel type: Channel\nThread ID: ${threadTs}\n`,
    );
    expect(claim2.appendSystemPrompt).toContain(
      "Slack display name: Slack User",
    );
    expect(claim2.appendSystemPrompt).toContain(
      `Slack user ID: ${slackUserId}`,
    );
  });

  describe("queued Web and Slack sends on one canonical session", () => {
    async function prepareCanonicalSession() {
      const actor = bdd.user();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      integrations.configureSlackAppMocks();
      await runs.grantProEntitlement(actor);
      await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
      if (!actor.orgId) {
        throw new Error("Expected canonical Slack actor to belong to an org");
      }
      const orgId = actor.orgId;
      const slackUserId = uniqueSlackUserId();
      const { teamId, botUserId } = await integrations.installSlackWorkspace(
        actor,
        {
          installerSlackUserId: slackUserId,
        },
      );
      const channelId = "C_BDD_CANONICAL_SESSION_REUSE";
      const threadTs = "2911.000100";
      const event = {
        type: "app_mention",
        user: slackUserId,
        text: `<@${botUserId}> establish the canonical session`,
        ts: threadTs,
        channel: channelId,
        channel_type: "channel",
      };
      const eventBody = JSON.stringify({
        type: "event_callback",
        team_id: teamId,
        event_id: `EvBDD${randomUUID().replace(/-/g, "")}`,
        event,
      });
      await integrations.requestSlackEvent(
        eventBody,
        integrations.signedSlackIngressHeaders(eventBody),
        [200],
      );
      await flushWaitUntilForTest();

      const run1Id = await pollSlackRun(runnerGroup);
      // The Slack route's thread and the agent it launched with are public
      // through the caller's thread lifecycle.
      const { chatThreadId: canonicalChatThreadId, agentId: defaultAgentId } =
        await ownedThreadWhere(actor, launchedBy(run1Id));
      const claim1 = await runs.claimRunnerJob(run1Id);
      return {
        actor,
        orgId,
        runnerGroup,
        teamId,
        channelId,
        threadTs,
        event,
        canonicalChatThreadId,
        run1Id,
        claim1,
        defaultAgentId,
      };
    }

    let prepared: Awaited<ReturnType<typeof prepareCanonicalSession>>;
    beforeEach(async () => {
      prepared = await prepareCanonicalSession();
    });

    it("keeps queued Web and Slack sends on one canonical session", async () => {
      const {
        actor,
        runnerGroup,
        teamId,
        channelId,
        threadTs,
        event,
        canonicalChatThreadId,
        run1Id,
        claim1,
        defaultAgentId,
      } = prepared;
      const queuedWebMessage = await chat.requestSendEvent(
        actor,
        {
          agentId: defaultAgentId,
          prompt: "keep the web session separate",
          threadId: canonicalChatThreadId,
          clientEventId: randomUUID(),
        },
        [201],
      );
      expect(queuedWebMessage.body).toMatchObject({
        runId: null,
        threadId: canonicalChatThreadId,
      });

      const stickyBody = JSON.stringify({
        type: "event_callback",
        team_id: teamId,
        event_id: `EvBDD${randomUUID().replace(/-/g, "")}`,
        event: {
          ...event,
          text: "stay canonical on the same route",
          ts: "2911.000200",
          thread_ts: threadTs,
        },
      });
      await integrations.requestSlackEvent(
        stickyBody,
        integrations.signedSlackIngressHeaders(stickyBody),
        [200],
      );
      await flushWaitUntilForTest();

      context.mocks.slack.chat.postMessage.mockClear();
      // Store this delivery in the shape an older API wrote, with the retired
      // `vm0` brand, to pin that current delivery ignores the field.
      const removeLegacyBrand =
        await installLegacySlackChatCallbackBrandFixture(run1Id);
      const completion = await settleIncludingAbort(
        (async () => {
          await completeSlackTriggeredRun({
            runId: run1Id,
            sandboxToken: claim1.sandboxToken,
            cliAgentType: claim1.cliAgentType,
            assistantText: "Executing command...",
            resultText: "Canonical Slack answer one",
          });
          await flushWaitUntilAndAssert(() => {
            expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
            expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
              expect.objectContaining({
                channel: channelId,
                thread_ts: threadTs,
                text: "Canonical Slack answer one",
              }),
            );
          });
        })(),
      );
      await removeLegacyBrand();
      if (!completion.ok) {
        throw completion.error;
      }
      await flushWaitUntilForTest();
      const run1 = await runs.readRun(actor, run1Id);
      const slackSessionId = run1.result?.agentSessionId;
      if (!slackSessionId) {
        throw new Error(
          "Expected the first canonical Slack run to save a session",
        );
      }

      const queuedRuns = await pollQueuedWebAndSlackRuns({
        actor,
        runnerGroup,
        expectedSlackSessionId: `bdd-slack-cli-${run1Id}`,
      });
      const webRunId = queuedRuns.webRunId;
      let claim2 = queuedRuns.claim2;
      let run2Id = queuedRuns.run2Id;

      const webClaim = await runs.claimRunnerJob(webRunId);
      expect(webClaim.resumeSession?.sessionId).toBe(`bdd-slack-cli-${run1Id}`);
      context.mocks.slack.chat.postMessage.mockClear();
      await completeSlackTriggeredRun({
        runId: webRunId,
        sandboxToken: webClaim.sandboxToken,
        cliAgentType: webClaim.cliAgentType,
        assistantText: "Web answer stays off Slack",
      });
      await flushWaitUntilForTest();
      expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
      const webRun = await runs.readRun(actor, webRunId);
      const webSessionId = webRun.result?.agentSessionId;
      if (!webSessionId) {
        throw new Error("Expected the Web run to save its canonical session");
      }
      expect(webSessionId).toBe(slackSessionId);

      ({ run2Id, claim2 } = await ensureSlackRunClaimed({
        runnerGroup,
        run2Id,
        claim2,
      }));
      expect(claim2.resumeSession?.sessionId).toBe(`bdd-slack-cli-${webRunId}`);
      await expect(readRunLog(actor, webRunId)).resolves.toMatchObject({
        triggerSource: "web",
      });
      const slackRunLog = await readRunLog(actor, run2Id);
      expect(slackRunLog.triggerSource).toBe("slack");
      expect(slackRunLog.prompt).toContain("stay canonical on the same route");
      await completeSlackTriggeredRun({
        runId: run2Id,
        sandboxToken: claim2.sandboxToken,
        cliAgentType: claim2.cliAgentType,
        assistantText: "Canonical Slack answer two",
      });
      await flushWaitUntilAndAssert(() => {
        expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
        expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: channelId,
            thread_ts: threadTs,
            text: "Canonical Slack answer two",
          }),
        );
      });
      expect(
        (await chat.listThreadEvents(actor, canonicalChatThreadId)).events,
      ).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "output.message",
            content: "Canonical Slack answer two",
          }),
        ]),
      );
      const run2 = await runs.readRun(actor, run2Id);
      expect(run2.result?.agentSessionId).toBe(slackSessionId);
      expect(run2.result?.agentSessionId).toBe(webSessionId);
    });
  });

  it.each(["gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-luna"] as const)(
    "admits canonical Slack %s turns into one Pi session without duplicate ownership",
    async (selectedModel) => {
      const scenario = await establishCanonicalSlackHistory(
        await configureCanonicalSlackPiActor(selectedModel),
      );
      const firstTurn = await runFirstCanonicalSlackPiTurn(scenario);
      const firstSessionId = await expectFirstSlackPiExecution({
        scenario,
        turn: firstTurn,
      });
      await expectSlackPiOwnership({
        scenario,
        runId: firstTurn.runId,
        assistantText: "Canonical Slack Pi answer",
      });
      const continuedTurn = await claimContinuedSlackPiTurn({
        scenario,
        firstPrompt: firstTurn.prompt,
        firstSessionId,
      });
      await cancelContinuedSlackPiTurn({
        scenario,
        turn: continuedTurn,
      });

      const successfulContinuation = await runSuccessfulContinuedSlackPiTurn({
        scenario,
        firstPrompt: firstTurn.prompt,
        firstSessionId,
      });
      await expectSlackPiOwnership({
        scenario,
        runId: successfulContinuation.runId,
        assistantText: "Continued Slack Pi answer",
      });
      await expect(
        runs.readRun(scenario.actor, successfulContinuation.runId),
      ).resolves.toMatchObject({ status: "completed" });
    },
    90_000,
  );

  describe("with a configured Slack workspace", () => {
    async function prepareScenario() {
      const actor = bdd.user();
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      integrations.configureSlackAppMocks();
      integrations.acceptSlackSessionHistoryDownloads();
      const runnerGroup = runs.configureRunnerGroup();
      await runs.grantProEntitlement(actor);
      await integrations.configureSlackRunModelPolicies(actor);
      await bdd.readOnboardingStatus(actor);
      const slackUserId = uniqueSlackUserId();
      const { teamId } = await integrations.installSlackWorkspace(actor, {
        installerSlackUserId: slackUserId,
      });
      integrations.clearSlackCallHistory();

      const channelId = "D_BDD_SESSION_ROUTING";
      const firstMessageTs = "2950.000100";
      return {
        teamId,
        slackUserId,
        firstMessageTs,
        channelId,
        runnerGroup,
        actor,
      };
    }
    let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
    beforeEach(async () => {
      preparedScenario = await prepareScenario();
    });
    it("resumes the main Slack DM session with the org default agent", async () => {
      const { teamId, slackUserId, firstMessageTs, channelId, runnerGroup } =
        preparedScenario;
      await integrations.postSlackEvent(teamId, {
        type: "message",
        channel_type: "im",
        user: slackUserId,
        text: "remember the main Slack DM",
        ts: firstMessageTs,
        channel: channelId,
      });
      const firstRunId = await pollSlackRun(runnerGroup);
      const firstClaim = await runs.claimRunnerJob(firstRunId);
      expect(firstClaim.resumeSession).toBeNull();
      await completeSlackTriggeredRun({
        runId: firstRunId,
        sandboxToken: firstClaim.sandboxToken,
        cliAgentType: firstClaim.cliAgentType,
      });

      const returnMessageTs = "2950.000300";
      await integrations.postSlackEvent(teamId, {
        type: "message",
        channel_type: "im",
        user: slackUserId,
        text: "return to the default Slack DM agent",
        ts: returnMessageTs,
        channel: channelId,
      });
      const returnToDefaultRunId = await pollSlackRun(runnerGroup);
      const returnToDefaultClaim =
        await runs.claimRunnerJob(returnToDefaultRunId);
      expect(returnToDefaultClaim.resumeSession?.sessionId).toBe(
        `bdd-slack-cli-${firstRunId}`,
      );
      await completeSlackTriggeredRun({
        runId: returnToDefaultRunId,
        sandboxToken: returnToDefaultClaim.sandboxToken,
        cliAgentType: returnToDefaultClaim.cliAgentType,
        assistantText: "Returned main Slack DM answer",
      });
      await flushWaitUntilForTest();
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: channelId,
          thread_ts: returnMessageTs,
          text: "Returned main Slack DM answer",
        }),
      );
    });

    it("switches the main Slack DM thread model from the DM model picker", async () => {
      const {
        actor,
        teamId,
        slackUserId,
        firstMessageTs,
        channelId,
        runnerGroup,
      } = preparedScenario;
      await integrations.postSlackEvent(teamId, {
        type: "message",
        channel_type: "im",
        user: slackUserId,
        text: "start the main Slack DM",
        ts: firstMessageTs,
        channel: channelId,
      });
      const firstRunId = await pollSlackRun(runnerGroup);
      const firstClaim = await runs.claimRunnerJob(firstRunId);
      expect(firstClaim.cliAgentType).toBe("claude-code");
      await completeSlackTriggeredRun({
        runId: firstRunId,
        sandboxToken: firstClaim.sandboxToken,
        cliAgentType: firstClaim.cliAgentType,
      });
      await flushWaitUntilForTest();
      const { chatThreadId } = await ownedThreadWhere(
        actor,
        launchedBy(firstRunId),
      );
      const modelCommand = await integrations.postSlackCommand({
        teamId,
        userId: slackUserId,
        channelId,
        text: "model",
        triggerId: "trigger-main-dm-model",
      });
      expect(modelCommand).toBe("");
      expect(context.mocks.slack.views.open).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger_id: "trigger-main-dm-model",
          view: expect.objectContaining({
            private_metadata: JSON.stringify({ channelId, chatThreadId }),
          }),
        }),
      );

      const selectModel = await integrations.postSlackInteractive(
        integrations.modelPickerSubmission({
          workspaceId: teamId,
          slackUserId,
          selectedValue: "gpt-6-astra",
          channelId,
          chatThreadId,
        }),
      );
      expect(selectModel).toBe("");
      expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: channelId,
          user: slackUserId,
          text: "Switched to *GPT 6 Astra* for this conversation.",
        }),
      );
      // The picker leaves the member preference the fixture configured.
      await expect(
        integrations.readUserModelPreference(actor),
      ).resolves.toMatchObject({ selectedModel: "claude-fable-5-1" });
      expect(
        (await chat.readThreadMetadata(actor, chatThreadId)).selectedModel,
      ).toBe("gpt-6-astra");
      const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
      if (threadEvents.status !== 200) {
        throw new Error("Expected Slack thread events to load");
      }
      expect(threadEvents.body.events).toContainEqual(
        expect.objectContaining({
          kind: "model_selection_updated",
          chatThreadId,
          selectedModel: "gpt-6-astra",
        }),
      );

      await integrations.postSlackEvent(teamId, {
        type: "message",
        channel_type: "im",
        user: slackUserId,
        text: "continue the main Slack DM",
        ts: "2950.000400",
        channel: channelId,
      });
      const switchedRunId = await pollSlackRun(runnerGroup);
      const switchedClaim = await runs.claimRunnerJob(switchedRunId);
      expect(switchedClaim.cliAgentType).toBe("codex");
      expect(switchedClaim.environment).toMatchObject({
        OPENAI_MODEL: "gpt-6-astra",
      });
    });
  });

  it("forks Slack DM threads without replacing the main session", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    integrations.configureSlackAppMocks();
    integrations.acceptSlackSessionHistoryDownloads();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await integrations.configureSlackRunModelPolicies(actor);
    await bdd.readOnboardingStatus(actor);
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    integrations.clearSlackCallHistory();

    const channelId = "D_BDD_THREAD_SESSION_ROUTING";
    const mainMessageTs = "2960.000100";
    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "remember the main Slack DM",
      ts: mainMessageTs,
      channel: channelId,
    });
    const mainRunId = await pollSlackRun(runnerGroup);
    const mainClaim = await runs.claimRunnerJob(mainRunId);
    expect(mainClaim.resumeSession).toBeNull();
    await completeSlackTriggeredRun({
      runId: mainRunId,
      sandboxToken: mainClaim.sandboxToken,
      cliAgentType: mainClaim.cliAgentType,
    });
    // The completion response precedes its waitUntil callback and queue drain.
    // Own that work before the next ingress can enter the same scheduler.
    await flushWaitUntilForTest();

    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "open a Slack DM thread",
      ts: "2960.000200",
      thread_ts: mainMessageTs,
      channel: channelId,
    });
    const threadRunId = await pollSlackRun(runnerGroup);
    const threadClaim = await runs.claimRunnerJob(threadRunId);
    expect(threadClaim.resumeSession).toBeNull();
    await completeSlackTriggeredRun({
      runId: threadRunId,
      sandboxToken: threadClaim.sandboxToken,
      cliAgentType: threadClaim.cliAgentType,
    });
    await flushWaitUntilForTest();

    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "continue the Slack DM thread",
      ts: "2960.000300",
      thread_ts: mainMessageTs,
      channel: channelId,
    });
    const threadFollowUpRunId = await pollSlackRun(runnerGroup);
    const threadFollowUpClaim = await runs.claimRunnerJob(threadFollowUpRunId);
    expect(threadFollowUpClaim.resumeSession?.sessionId).toBe(
      `bdd-slack-cli-${threadRunId}`,
    );
    await completeSlackTriggeredRun({
      runId: threadFollowUpRunId,
      sandboxToken: threadFollowUpClaim.sandboxToken,
      cliAgentType: threadFollowUpClaim.cliAgentType,
    });
    await flushWaitUntilForTest();

    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "return to the main Slack DM",
      ts: "2960.000400",
      channel: channelId,
    });
    const returnToMainRunId = await pollSlackRun(runnerGroup);
    const returnToMainClaim = await runs.claimRunnerJob(returnToMainRunId);
    expect(returnToMainClaim.resumeSession?.sessionId).toBe(
      `bdd-slack-cli-${mainRunId}`,
    );
  });

  it("admits a later canonical-route retry after its first ingress insert fails", async () => {
    const actor = bdd.user();
    const blockerActor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    integrations.configureSlackAppMocks();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
    await runs.grantProEntitlement(blockerActor);
    await runs.ensureOrgModelProvider(blockerActor, {
      model: "claude-fable-5-1",
    });
    const slackUserId = uniqueSlackUserId();
    const blockerSlackUserId = uniqueSlackUserId();
    const targetInstallation = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    const blockerInstallation = await integrations.installSlackWorkspace(
      blockerActor,
      {
        installerSlackUserId: blockerSlackUserId,
      },
    );
    const channelId = "C_BDD_CANONICAL_RETRY_RECOVERY";
    const threadTs = "3100.000100";
    const initialEventId = `EvBDD${randomUUID().replace(/-/g, "")}`;
    const initialBody = JSON.stringify({
      type: "event_callback",
      team_id: targetInstallation.teamId,
      event_id: initialEventId,
      event: {
        type: "app_mention",
        user: slackUserId,
        text: `<@${targetInstallation.botUserId}> create this route`,
        ts: "3100.000200",
        thread_ts: threadTs,
        channel: channelId,
        channel_type: "channel",
      },
    });
    await integrations.requestSlackEvent(
      initialBody,
      integrations.signedSlackIngressHeaders(initialBody),
      [200],
    );
    await flushWaitUntilForTest();

    const recoveredEventId = `EvBDD${randomUUID().replace(/-/g, "")}`;
    const blockerBody = JSON.stringify({
      type: "event_callback",
      team_id: blockerInstallation.teamId,
      event_id: recoveredEventId,
      event: {
        type: "app_mention",
        user: blockerSlackUserId,
        text: `<@${blockerInstallation.botUserId}> reserve this event id`,
        ts: "4100.000100",
        channel: "C_BDD_CANONICAL_RETRY_BLOCKER",
        channel_type: "channel",
      },
    });
    await integrations.requestSlackEvent(
      blockerBody,
      integrations.signedSlackIngressHeaders(blockerBody),
      [200],
    );
    await flushWaitUntilForTest();

    const recoveredBody = JSON.stringify({
      type: "event_callback",
      team_id: targetInstallation.teamId,
      event_id: recoveredEventId,
      event: {
        type: "app_mention",
        user: slackUserId,
        text: `<@${targetInstallation.botUserId}> recover this event after admission conflict`,
        ts: "3100.000300",
        thread_ts: threadTs,
        channel: channelId,
        channel_type: "channel",
      },
    });
    await integrations.requestSlackEvent(
      recoveredBody,
      integrations.signedSlackIngressHeaders(recoveredBody),
      [500],
    );
    let targetState = await integrations.readSlackTestState(
      targetInstallation.teamId,
    );
    expect(
      targetState.chat_ingress.some((ingress) => {
        return ingress.eventId === recoveredEventId;
      }),
    ).toBeFalsy();

    await integrations.deleteSlackTestState(blockerInstallation.teamId);
    await integrations.requestSlackEvent(
      recoveredBody,
      {
        ...integrations.signedSlackIngressHeaders(recoveredBody),
        "x-slack-retry-num": "1",
      },
      [200],
    );
    await flushWaitUntilForTest();

    targetState = await integrations.readSlackTestState(
      targetInstallation.teamId,
    );
    expect(targetState.chat_ingress).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: initialEventId,
          status: "processed",
        }),
        expect.objectContaining({
          eventId: recoveredEventId,
          payload: recoveredBody,
          status: "processed",
          retryCount: 1,
        }),
      ]),
    );
    expect(targetState.pending_chat_events).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "input.prompt",
        }),
      ]),
    );
    const recoveredThreadId = targetState.chat_thread_routes[0]?.chatThreadId;
    if (!recoveredThreadId) {
      throw new Error("Expected recovered Slack route to own a chat thread");
    }
    expect(
      (await chat.listThreadEvents(actor, recoveredThreadId)).events,
    ).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "input.prompt",
          content: null,
          userMessage: {
            version: 1,
            parts: [
              {
                type: "text",
                text: "@Slack User recover this event after admission conflict",
              },
              {
                type: "source",
                kind: "slack",
                href: "https://vm0.slack.com/archives/C_BDD_CANONICAL_RETRY_RECOVERY/p3100000300",
              },
            ],
          },
        }),
      ]),
    );
  });

  it("routes retry-only Slack events through canonical ingress", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    integrations.configureSlackAppMocks();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    const threadTs = "2900.000300";
    const channelId = "C_BDD_RETRY_INGRESS";
    const retryEventId = `EvBDD${randomUUID().replace(/-/g, "")}`;
    const retryBody = JSON.stringify({
      type: "event_callback",
      team_id: teamId,
      event_id: retryEventId,
      event: {
        type: "app_mention",
        user: slackUserId,
        text: "retry this route through canonical ingress",
        ts: threadTs,
        channel: channelId,
        channel_type: "channel",
      },
    });
    await integrations.requestSlackEvent(
      retryBody,
      {
        ...integrations.signedSlackIngressHeaders(retryBody),
        "x-slack-retry-num": "1",
      },
      [200],
    );
    await flushWaitUntilForTest();

    const state = await integrations.readSlackTestState(teamId);
    expect(state.chat_thread_routes).toHaveLength(1);
    expect(state.chat_thread_routes[0]).toMatchObject({
      channelId,
      threadTs,
      chatThreadId: expect.any(String),
    });
    expect(state.chat_ingress).toStrictEqual([
      expect.objectContaining({
        eventId: retryEventId,
        status: "processed",
        retryCount: 1,
      }),
    ]);
    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).toHaveBeenCalledWith({
      channel_id: channelId,
      thread_ts: threadTs,
      status: "is thinking...",
    });
  });

  it("tells the Slack sender when the org is at its concurrent run limit", async () => {
    // One active run fills the org, independent of the plan's own limit.
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    integrations.configureSlackAppMocks();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "occupy the only org run slot",
      ts: "2910.000100",
      channel: "C_BDD_ORG_FULL_ACTIVE",
      channel_type: "channel",
    });
    const activeRunId = await pollSlackRun(runnerGroup);

    const channelId = "C_BDD_ORG_FULL_WAITING";
    const threadTs = "2910.000200";
    context.mocks.slack.chat.postMessage.mockClear();
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "wait for an org run slot",
      ts: threadTs,
      channel: channelId,
      channel_type: "channel",
    });
    await flushWaitUntilForTest();

    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: channelId,
        thread_ts: threadTs,
        text: "The workspace has reached its concurrent run limit; this will start automatically when a slot frees up.",
      }),
    );
    // The waiting thread does not keep the admission "is thinking..." status.
    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).toHaveBeenLastCalledWith({
      channel_id: channelId,
      thread_ts: threadTs,
      status: "",
    });

    await runs.requestCancelRun(actor, activeRunId, [200]);
    await flushWaitUntilForTest();
  });

  it("titles canonical Slack threads when their run is created", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    integrations.configureSlackAppMocks();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });

    const titlePrompts: string[] = [];
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("Generate a short, descriptive title")) {
        titlePrompts.push(body.messages[1]?.content ?? "");
        return "Canonical Slack Title";
      }
      return "Generated summary";
    });

    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    const channelId = "C_BDD_EAGER_TITLE";
    const threadTs = "2960.000100";
    const prompt = "title this canonical Slack thread";
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: prompt,
      ts: threadTs,
      channel: channelId,
      channel_type: "channel",
    });
    const runId = await pollSlackRun(runnerGroup);
    const claim = await runs.claimRunnerJob(runId);
    await flushWaitUntilForTest();

    const { chatThreadId } = await ownedThreadWhere(actor, launchedBy(runId));
    const beforeComplete = await chat.requestThreadEvents(actor, {}, [200]);
    if (beforeComplete.status !== 200) {
      throw new Error("Expected canonical Slack thread events to load");
    }
    // The title lands while the run is still in flight, so Slack threads no
    // longer wait for the terminal callback to be named.
    expect(beforeComplete.body.events).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "renamed",
          chatThreadId,
          title: "Canonical Slack Title",
        }),
      ]),
    );
    expect(titlePrompts).toHaveLength(1);
    expect(titlePrompts[0]).toContain(prompt);

    await completeSlackTriggeredRun({
      runId,
      sandboxToken: claim.sandboxToken,
      cliAgentType: claim.cliAgentType,
      assistantText: "Canonical Slack titled answer",
    });
    await flushWaitUntilForTest();

    expect(titlePrompts).toHaveLength(1);
  });

  it("uses default launch bindings for canonical Slack threads", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    integrations.configureSlackAppMocks();
    integrations.acceptSlackSessionHistoryDownloads();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await integrations.configureSlackRunModelPolicies(actor);
    const onboarding = await bdd.readOnboardingStatus(actor);
    if (!onboarding.defaultAgentId) {
      throw new Error("Expected onboarding to configure a default agent");
    }
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    integrations.clearSlackCallHistory();

    const channelId = "C_BDD_RUNS";
    const threadTs = "3000.000100";
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "summarize this thread",
      ts: threadTs,
      channel: channelId,
    });
    await flushWaitUntilAndAssert(() => {
      expect(
        context.mocks.slack.assistant.threads.setStatus,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: channelId,
          thread_ts: threadTs,
          status: "is thinking...",
        }),
      );
    });
    const run1Id = await pollSlackRun(runnerGroup);
    const claim1 = await runs.claimRunnerJob(run1Id);
    expect(claim1.prompt).toBe("summarize this thread");
    expect(claim1.platformEnvironment.OKOU_CURRENT_INTEGRATION).toBe("slack");
    expect(claim1.appendSystemPrompt ?? "").toContain(
      "You are currently running inside: Slack",
    );
    expect(claim1.appendSystemPrompt ?? "").toContain(
      "Slack display name: Slack User",
    );
    expect(claim1.cliAgentType).toBe("claude-code");
    expect(claim1.environment).toMatchObject({
      ANTHROPIC_API_KEY: expect.stringMatching(/.+/),
    });
    const running = await runs.readRun(actor, run1Id);
    expect(running.status).toBe("running");
    await expect(readRunLog(actor, run1Id)).resolves.toMatchObject({
      triggerSource: "slack",
    });

    await completeSlackTriggeredRun({
      runId: run1Id,
      sandboxToken: claim1.sandboxToken,
      cliAgentType: "claude-code",
      assistantText: "BDD canonical Slack response",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: channelId, thread_ts: threadTs }),
      );
    });
    const run1 = await runs.readRun(actor, run1Id);
    expect(run1.status).toBe("completed");
    const session1 = run1.result?.agentSessionId;
    if (!session1) {
      throw new Error("Expected completed Slack run to expose its session");
    }

    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "follow up in the same thread",
      ts: "3000.000200",
      thread_ts: threadTs,
      channel: channelId,
    });
    const run2Id = await pollSlackRun(runnerGroup);
    const claim2 = await runs.claimRunnerJob(run2Id);
    expect(claim2.resumeSession?.sessionId).toBe(`bdd-slack-cli-${run1Id}`);
    await completeSlackTriggeredRun({
      runId: run2Id,
      sandboxToken: claim2.sandboxToken,
      cliAgentType: "claude-code",
    });
    const run2 = await runs.readRun(actor, run2Id);
    expect(run2.result?.agentSessionId).toBe(session1);
  });

  it("pins model choices to canonical Slack threads", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    integrations.configureSlackAppMocks();
    integrations.acceptSlackSessionHistoryDownloads();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await integrations.configureSlackRunModelPolicies(actor);
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });

    const channelId = "C_BDD_MODEL_BINDING";
    await integrations.updateUserModelPreference(actor, "gpt-6-astra");
    const gptThreadTs = "3100.000100";
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "use gpt for this",
      ts: gptThreadTs,
      channel: channelId,
    });
    const gptRunId = await pollSlackRun(runnerGroup);
    const gptClaim = await runs.claimRunnerJob(gptRunId);
    expect(gptClaim.cliAgentType).toBe("codex");
    expect(gptClaim.environment).toMatchObject({
      OPENAI_API_KEY: expect.stringMatching(/.+/),
      OPENAI_MODEL: "gpt-6-astra",
    });
    await completeSlackTriggeredRun({
      runId: gptRunId,
      sandboxToken: gptClaim.sandboxToken,
      cliAgentType: "codex",
    });
    const gptRun = await runs.readRun(actor, gptRunId);
    const gptSessionId = gptRun.result?.agentSessionId;
    if (!gptSessionId) {
      throw new Error("Expected GPT Slack run to expose its session");
    }

    await integrations.updateUserModelPreference(actor, "claude-fable-5-1");
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "back to claude",
      ts: "3100.000200",
      thread_ts: gptThreadTs,
      channel: channelId,
    });
    const continuationRunId = await pollSlackRun(runnerGroup);
    const continuationClaim = await runs.claimRunnerJob(continuationRunId);
    expect(continuationClaim.cliAgentType).toBe("codex");
    expect(continuationClaim.environment).toMatchObject({
      OPENAI_MODEL: "gpt-6-astra",
    });
    expect(continuationClaim.resumeSession?.sessionId).toBe(
      `bdd-slack-cli-${gptRunId}`,
    );
    await completeSlackTriggeredRun({
      runId: continuationRunId,
      sandboxToken: continuationClaim.sandboxToken,
      cliAgentType: "codex",
    });
    const continuationRun = await runs.readRun(actor, continuationRunId);
    expect(continuationRun.result?.agentSessionId).toBe(gptSessionId);
  });

  it("captures the system default for a NULL Slack thread without changing its pin", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    integrations.configureSlackAppMocks();
    integrations.acceptSlackSessionHistoryDownloads();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await integrations.configureSlackRunModelPolicies(actor);
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });

    const channelId = "C_BDD_NULL_MODEL";
    const threadTs = "3150.000100";
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "establish the historical Slack model",
      ts: threadTs,
      channel: channelId,
    });
    const firstRunId = await pollSlackRun(runnerGroup);
    const firstClaim = await runs.claimRunnerJob(firstRunId);
    expect(firstClaim.cliAgentType).toBe("claude-code");
    expect(firstClaim.environment).toMatchObject({
      ANTHROPIC_API_KEY: expect.stringMatching(/.+/),
      ANTHROPIC_MODEL: "claude-fable-5-1",
    });
    await completeSlackTriggeredRun({
      runId: firstRunId,
      sandboxToken: firstClaim.sandboxToken,
      cliAgentType: firstClaim.cliAgentType,
    });
    await flushWaitUntilForTest();

    const { chatThreadId } = await ownedThreadWhere(
      actor,
      launchedBy(firstRunId),
    );
    const historicalMessages = await chat.listThreadEvents(actor, chatThreadId);
    expect(historicalMessages.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.prompt",
        runId: firstRunId,
      }),
    );

    await chat.updateThreadModelSelection(actor, chatThreadId, null);
    await integrations.updateUserModelPreference(actor, "gpt-6-astra");
    await seedBuiltInModelCandidateKeys(context, SEEDED_SYSTEM_DEFAULT_MODEL);
    expect(
      (await chat.readThreadMetadata(actor, chatThreadId)).selectedModel,
    ).toBeNull();

    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "resolve the current canonical Slack model",
      ts: "3150.000200",
      thread_ts: threadTs,
      channel: channelId,
    });
    // An existing thread without a pin uses the system default, not the
    // member preference.
    const resolvedRunId = await pollSlackRun(runnerGroup);
    expect((await runs.readRun(actor, resolvedRunId)).source.model).toBe(
      SEEDED_SYSTEM_DEFAULT_MODEL,
    );
    expect(
      (await chat.readThreadMetadata(actor, chatThreadId)).selectedModel,
    ).toBeNull();

    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    if (threadEvents.status !== 200) {
      throw new Error("Expected canonical Slack thread events to load");
    }
    expect(threadEvents.body.events).not.toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        chatThreadId,
        selectedModel: "gpt-6-astra",
      }),
    );

    await runs.requestCancelRun(actor, resolvedRunId, [200]);
  }, 90_000);

  it("prompts disconnected Slack users and filters non-actionable messages", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();
    const { teamId } = await integrations.installSlackWorkspace(actor);
    const slackUserId = uniqueSlackUserId();
    integrations.clearSlackCallHistory();

    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "hello agent",
      ts: "2000.000100",
      channel: "C_BDD_LOGIN",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C_BDD_LOGIN",
          user: slackUserId,
        }),
      );
      expect(
        JSON.stringify(context.mocks.slack.chat.postEphemeral.mock.calls),
      ).toContain("connect your account");
    });

    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "hello in dm",
      ts: "2000.000200",
      channel: "D_BDD_LOGIN",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "D_BDD_LOGIN",
          text: "Please connect your account first",
        }),
      );
    });

    context.mocks.slack.chat.postMessage.mockClear();
    context.mocks.slack.chat.postEphemeral.mockClear();
    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "bot message",
      ts: "2000.000300",
      channel: "D_BDD_LOGIN",
      bot_id: "B_BDD",
    });
    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "edited message",
      ts: "2000.000400",
      channel: "D_BDD_LOGIN",
      subtype: "message_changed",
    });
    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "channel",
      user: slackUserId,
      text: "channel chatter",
      ts: "2000.000500",
      channel: "C_BDD_LOGIN",
    });
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();

    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "file upload",
      ts: "2000.000600",
      channel: "D_BDD_LOGIN",
      subtype: "file_share",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
      expect(slackPostMessageCallsJson()).toContain(
        "Please connect your account first",
      );
    });

    const unbound = await integrations.installSlackWorkspace(null);
    context.mocks.slack.chat.postMessage.mockClear();
    context.mocks.slack.chat.postEphemeral.mockClear();
    context.mocks.slack.assistant.threads.setStatus.mockClear();
    await integrations.postSlackEvent(
      `T_BDD_MISSING_${randomUUID().slice(0, 6)}`,
      {
        type: "app_mention",
        user: slackUserId,
        text: "hello nowhere",
        ts: "2000.000700",
        channel: "C_BDD_LOGIN",
      },
    );
    await integrations.postSlackEvent(unbound.teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "unbound dm",
      ts: "2000.000800",
      channel: "D_BDD_LOGIN",
    });
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).not.toHaveBeenCalled();
  });

  it("notifies connected Slack users when no usable org agent is configured", async () => {
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();

    const bare = bdd.user();
    const bareSlackUserId = uniqueSlackUserId();
    const bareInstall = await integrations.installSlackWorkspace(bare, {
      installerSlackUserId: bareSlackUserId,
    });
    integrations.clearSlackCallHistory();
    await integrations.postSlackEvent(bareInstall.teamId, {
      type: "app_mention",
      user: bareSlackUserId,
      text: "hello agent",
      ts: "2100.000100",
      channel: "C_BDD_NOAGENT",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C_BDD_NOAGENT",
          user: bareSlackUserId,
          text: expect.stringContaining("No agent is configured"),
        }),
      );
    });

    // `/okou switch` no longer opens an agent picker: Slack always uses the
    // org default agent.
    const emptySwitch = await integrations.postSlackCommand({
      teamId: bareInstall.teamId,
      userId: bareSlackUserId,
      channelId: "C_BDD_NOAGENT",
      text: "switch",
      triggerId: "trigger-bdd-noagent-switch",
    });
    expect(JSON.stringify(emptySwitch)).toContain(
      "Slack always uses your org's default agent.",
    );
    expect(context.mocks.slack.views.open).not.toHaveBeenCalled();

    // A legacy deletion of the org default clears orgMetadata.defaultAgentId at the
    // DB level (FK onDelete: "set null"), and active onboarding flows only
    // configure existing agents, so resolveEffectiveCompose's "not_found"
    // status ("configured agent could not be found" notice) is unreachable
    // through public APIs. The deleted-default journey lands on the
    // "not_configured" status's "No agent is configured" notice, delivered
    // through the DM postMessage branch here instead of the channel ephemeral.
    // The "not_accessible" status is covered by the hidden-private-default
    // journey in this describe.
    const onboarded = bdd.user();
    await bdd.bootstrapLimitedFreeOnboarding(onboarded, {
      displayName: "BDD Slack Deleted Agent",
    });
    const status = await bdd.readOnboardingStatus(onboarded);
    if (!status.defaultAgentId) {
      throw new Error("Expected onboarding to configure a default agent");
    }
    await seedLegacyMissingDefaultAgentFixture(status.defaultAgentId);
    const missingSlackUserId = uniqueSlackUserId();
    const missingInstall = await integrations.installSlackWorkspace(onboarded, {
      installerSlackUserId: missingSlackUserId,
    });
    integrations.clearSlackCallHistory();
    await integrations.postSlackEvent(missingInstall.teamId, {
      type: "message",
      channel_type: "im",
      user: missingSlackUserId,
      text: "hello in dm",
      ts: "2100.000200",
      channel: "D_BDD_MISSING_AGENT",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "D_BDD_MISSING_AGENT",
          text: expect.stringContaining("No agent is configured"),
        }),
      );
    });
  });

  it("serves Slack slash commands for help, connect, switch, model, and disconnect", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();
    await bdd.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "BDD Slack Default Agent",
    });
    const status = await bdd.readOnboardingStatus(actor);
    const defaultAgentId = status.defaultAgentId;
    if (!defaultAgentId) {
      throw new Error("Expected onboarding to configure a default agent");
    }
    const slackUserId = uniqueSlackUserId();
    const { teamId, botUserId } = await integrations.installSlackWorkspace(
      actor,
      {
        installerSlackUserId: slackUserId,
      },
    );
    integrations.clearSlackCallHistory();

    for (const text of ["", "help", "unknown"]) {
      const help = await integrations.postSlackCommand({
        teamId,
        userId: slackUserId,
        channelId: "C_BDD_CMD",
        text,
      });
      const helpJson = JSON.stringify(help);
      expect(helpJson).toContain(`<@${botUserId}> Slack Bot Help`);
      expect(helpJson).not.toContain("/okou switch");
      expect(helpJson).toContain("/okou model");
      expect(helpJson).toContain(`<@${botUserId}>`);
    }

    const alreadyConnected = await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_CMD",
      text: "connect",
    });
    expect(JSON.stringify(alreadyConnected)).toContain("already connected");

    context.mocks.slack.views.open.mockClear();
    const switchResponse = await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_CMD",
      text: "switch",
      triggerId: "trigger-bdd-switch",
    });
    expect(JSON.stringify(switchResponse)).toContain(
      "Slack always uses your org's default agent.",
    );
    expect(context.mocks.slack.views.open).not.toHaveBeenCalled();

    await integrations.updateUserModelPreference(
      actor,
      SEEDED_SYSTEM_DEFAULT_MODEL,
    );
    const modelResponse = await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_CMD",
      text: "model",
      triggerId: "trigger-bdd-model",
    });
    expect(JSON.stringify(modelResponse)).toContain(
      "existing Okou Slack main DM conversation",
    );
    expect(context.mocks.slack.views.open).not.toHaveBeenCalled();

    const disconnected = await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_CMD",
      text: "disconnect",
    });
    expect(JSON.stringify(disconnected)).toContain("disconnected");
    expect(context.mocks.slack.views.publish).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: slackUserId }),
    );
    const connectStatus = await integrations.requestSlackConnectStatus(
      actor,
      [200],
    );
    expect(connectStatus.body).toMatchObject({ isConnected: false });

    const notConnected = await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_CMD",
      text: "disconnect",
    });
    expect(JSON.stringify(notConnected)).toContain("not connected");

    const loginPrompt = await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_CMD",
      text: "connect",
    });
    expect(JSON.stringify(loginPrompt)).toContain(
      "https://app.okou.test/settings/slack",
    );
  });

  it("handles Slack commands for unknown workspaces and unbound installations", async () => {
    integrations.configureSlackAppMocks();
    const slackUserId = uniqueSlackUserId();
    const uninstalledTeamId = `T_BDD_NONE_${randomUUID().slice(0, 8)}`;

    const notInstalled = await integrations.postSlackCommand({
      teamId: uninstalledTeamId,
      userId: slackUserId,
      text: "connect",
    });
    expect(JSON.stringify(notInstalled)).toContain("hasn't been set up");

    const uninstalledHelp = await integrations.postSlackCommand({
      teamId: uninstalledTeamId,
      userId: slackUserId,
      text: "help",
    });
    const uninstalledHelpJson = JSON.stringify(uninstalledHelp);
    expect(uninstalledHelpJson).toContain("Slack Bot Help");
    expect(uninstalledHelpJson).toContain("mention it in a channel");
    expect(uninstalledHelpJson).not.toContain("@Okou");

    const unbound = await integrations.installSlackWorkspace(null);
    const help = await integrations.postSlackCommand({
      teamId: unbound.teamId,
      userId: slackUserId,
      text: "help",
    });
    const helpJson = JSON.stringify(help);
    expect(helpJson).toContain("/okou connect");
    expect(helpJson).not.toContain("/okou switch");
    expect(helpJson).not.toContain("/okou model");
  });

  it("prompts for login when switching agents without a Slack connection", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();
    await bdd.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "BDD Slack Login Agent",
    });
    const { teamId } = await integrations.installSlackWorkspace(actor);
    integrations.clearSlackCallHistory();

    const disconnectedUserId = uniqueSlackUserId();
    const response = await integrations.postSlackCommand({
      teamId,
      userId: disconnectedUserId,
      channelId: "C_BDD_CMD",
      text: "switch",
    });
    const responseJson = JSON.stringify(response);
    expect(responseJson).toContain("ephemeral");
    expect(responseJson).toContain("connect");
    expect(context.mocks.slack.views.open).not.toHaveBeenCalled();
  });

  it("rejects stale Slack picker submissions without a routed main DM", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();

    await bdd.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "BDD Slack Picker Default",
    });
    await runs.grantProEntitlement(actor);
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    integrations.clearSlackCallHistory();

    const selectModel = await integrations.postSlackInteractive(
      integrations.modelPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: "gpt-6-astra",
        channelId: "C_BDD_PICK",
      }),
    );
    expect(selectModel).toMatchObject({
      response_action: "errors",
      errors: {
        model_select_block: expect.stringContaining("out of date"),
      },
    });
    expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
    await expect(
      integrations.readUserModelPreference(actor),
    ).resolves.toMatchObject({
      selectedModel: null,
    });

    const replaceModel = await integrations.postSlackInteractive(
      integrations.modelPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: "gpt-6-luna",
        channelId: "C_BDD_PICK",
      }),
    );
    expect(replaceModel).toMatchObject({ response_action: "errors" });
    await expect(
      integrations.readUserModelPreference(actor),
    ).resolves.toMatchObject({
      selectedModel: null,
    });

    const rejectedModel = await integrations.postSlackInteractive(
      integrations.modelPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: "model-outside-policy",
        channelId: "C_BDD_PICK",
      }),
    );
    expect(rejectedModel).toMatchObject({ response_action: "errors" });
    await expect(
      integrations.readUserModelPreference(actor),
    ).resolves.toMatchObject({
      selectedModel: null,
    });
  });

  it("refreshes Slack App Home, welcomes once, and cleans up lifecycle events", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();
    await bdd.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "BDD Slack Home Agent",
    });
    const slackUserId = uniqueSlackUserId();
    const install = await integrations.installSlackWorkspace(null);
    await integrations.connectSlackUser(actor, {
      workspaceId: install.teamId,
      slackUserId,
      channelId: "C_BDD_HOME",
    });
    integrations.clearSlackCallHistory();
    const teamId = install.teamId;

    await integrations.postSlackEvent(teamId, {
      type: "app_home_opened",
      user: slackUserId,
      tab: "home",
      channel: "D_BDD_HOME",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.views.publish).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: slackUserId }),
      );
      expect(
        JSON.stringify(context.mocks.slack.views.publish.mock.calls),
      ).toContain("Connected to Okou");
    });

    context.mocks.slack.views.publish.mockClear();
    await integrations.postSlackEvent(teamId, {
      type: "app_home_opened",
      user: slackUserId,
      tab: "home",
      channel: "D_BDD_HOME",
    });
    await flushWaitUntilAndAssert(() => {
      expect(
        JSON.stringify(context.mocks.slack.views.publish.mock.calls),
      ).toContain("Connected to Okou");
    });

    await integrations.postSlackEvent(teamId, {
      type: "app_home_opened",
      user: slackUserId,
      tab: "messages",
      channel: "D_BDD_HOME",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "D_BDD_HOME" }),
      );
    });
    await integrations.postSlackEvent(teamId, {
      type: "app_home_opened",
      user: slackUserId,
      tab: "messages",
      channel: "D_BDD_HOME",
    });
    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();

    context.mocks.slack.views.publish.mockClear();
    const homeDisconnect = {
      type: "block_actions",
      user: { id: slackUserId, username: "bdduser", team_id: teamId },
      team: { id: teamId, domain: "bdd" },
      actions: [{ action_id: "home_disconnect", block_id: "home" }],
    };
    mockEnv("APP_URL", "https://app.okou.ai");
    const disconnected =
      await integrations.postSlackInteractive(homeDisconnect);
    expect(disconnected).toBe("");
    expect(context.mocks.slack.views.publish).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(context.mocks.slack.views.publish.mock.calls),
    ).toContain("https://app.okou.ai/settings/slack");
    mockEnv("APP_URL", "https://app.okou.test");
    const disconnectedStatus = await integrations.requestSlackConnectStatus(
      actor,
      [200],
    );
    expect(disconnectedStatus.body).toMatchObject({ isConnected: false });

    const repeatDisconnect =
      await integrations.postSlackInteractive(homeDisconnect);
    expect(repeatDisconnect).toBe("");
    expect(context.mocks.slack.views.publish).toHaveBeenCalledOnce();

    context.mocks.slack.views.publish.mockClear();
    await integrations.postSlackEvent(teamId, {
      type: "app_home_opened",
      user: slackUserId,
      tab: "home",
      channel: "D_BDD_HOME",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.views.publish).toHaveBeenCalledOnce();
      expect(
        JSON.stringify(context.mocks.slack.views.publish.mock.calls),
      ).toContain("Account not connected");
    });
    await integrations.postSlackEvent(teamId, {
      type: "app_home_opened",
      user: slackUserId,
      tab: "messages",
      channel: "D_BDD_HOME",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
    });

    context.mocks.slack.views.publish.mockClear();
    await integrations.postSlackEvent(
      `T_BDD_NOWHERE_${randomUUID().slice(0, 6)}`,
      {
        type: "app_home_opened",
        user: slackUserId,
        tab: "home",
        channel: "D_BDD_HOME",
      },
    );
    expect(context.mocks.slack.views.publish).not.toHaveBeenCalled();

    await integrations.postSlackEvent(teamId, { type: "app_uninstalled" });
    await flushWaitUntilForTest();
    await expect(
      (async () => {
        const status = await integrations.requestSlackIntegrationStatus(
          actor,
          [200],
        );
        return "isInstalled" in status.body ? status.body.isInstalled : null;
      })(),
    ).resolves.toBeFalsy();
    const orgStatus = await integrations.requestSlackIntegrationStatus(
      actor,
      [200],
    );
    expect(orgStatus.body).toMatchObject({
      isInstalled: false,
      isConnected: false,
    });
    const stateAfterUninstall = await integrations.readSlackTestState(teamId);
    expect(stateAfterUninstall.installation).toBeNull();
    expect(stateAfterUninstall.connections).toHaveLength(0);

    const unbound = await integrations.installSlackWorkspace(null);
    await integrations.postSlackEvent(unbound.teamId, {
      type: "app_uninstalled",
    });
    await flushWaitUntilForTest();
    await expect(
      (async () => {
        const state = await integrations.readSlackTestState(unbound.teamId);
        return state.installation;
      })(),
    ).resolves.toBeNull();
    const unboundState = await integrations.readSlackTestState(unbound.teamId);
    expect(unboundState.installation).toBeNull();

    const revoked = await integrations.installSlackWorkspace(null);
    await integrations.connectSlackUser(actor, {
      workspaceId: revoked.teamId,
      slackUserId,
      channelId: "C_BDD_HOME",
    });
    await integrations.postSlackEvent(revoked.teamId, {
      type: "tokens_revoked",
      tokens: { bot: ["xoxb-revoked"] },
    });
    await flushWaitUntilForTest();
    await expect(
      (async () => {
        const state = await integrations.readSlackTestState(revoked.teamId);
        return state.installation;
      })(),
    ).resolves.toBeNull();
    const revokedState = await integrations.readSlackTestState(revoked.teamId);
    expect(revokedState.installation).toBeNull();
    expect(revokedState.connections).toHaveLength(0);
  });

  it("replies with canonical run-creation errors for Slack messages", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();
    await bdd.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "BDD Slack Failing Default",
    });
    if (!actor.orgId) {
      throw new Error("Expected Slack failing default actor to have an org");
    }
    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "pro",
      credits: 20_000,
    });
    await integrations.configureSlackRunModelPolicies(actor);
    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "pro",
      credits: 0,
    });
    await upsertOrgPlanEntitlementFixture({
      orgId: actor.orgId,
      status: "suspended",
      canBuyCredits: false,
    });
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    integrations.clearSlackCallHistory();

    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "please run something",
      ts: "5000.000100",
      channel: "D_BDD_FAIL",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "D_BDD_FAIL",
          thread_ts: "5000.000100",
          text: expect.stringContaining("Compare plans"),
        }),
      );
    });
    expect(slackPostMessageCallsJson()).not.toContain("Sent via");
    await flushWaitUntilAndAssert(() => {
      expect(
        context.mocks.slack.assistant.threads.setStatus,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: "D_BDD_FAIL",
          status: "is thinking...",
        }),
      );
      expect(
        context.mocks.slack.assistant.threads.setStatus,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ channel_id: "D_BDD_FAIL", status: "" }),
      );
    });
  });

  it("keeps the Slack Fast footer bound to the originating run", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    integrations.configureSlackAppMocks();
    integrations.acceptSlackSessionHistoryDownloads();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: codexFastAuthJson() },
      },
      [200, 201],
    );
    await runs.updateOrgModelPolicies(actor, [
      {
        model: "gpt-6-astra",
        preferred: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);
    await bdd.readOnboardingStatus(actor);
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    integrations.clearSlackCallHistory();

    const channelId = "C_BDD_FAST_FOOTER";
    const threadTs = "3999.000100";
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "start the standard codex thread",
      ts: threadTs,
      channel: channelId,
    });
    const standardRunId = await pollSlackRun(runnerGroup);
    const standardClaim = await runs.claimRunnerJob(standardRunId);
    await completeSlackTriggeredRun({
      runId: standardRunId,
      sandboxToken: standardClaim.sandboxToken,
      cliAgentType: "codex",
      codexAgentMessageText: "standard answer",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "standard answer" }),
      );
    });
    const standardFooter = slackPostMessageCallsJson();
    expect(standardFooter).toContain("GPT 6 Astra");
    expect(standardFooter).not.toContain("GPT 6 Astra Fast");

    const { chatThreadId: threadId } = await ownedThreadWhere(
      actor,
      launchedBy(standardRunId),
    );
    await chat.updateThreadModelSelection(actor, threadId, "gpt-6-astra", {
      codexServiceTier: "fast",
    });
    context.mocks.slack.chat.postMessage.mockClear();

    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "answer this one in fast mode",
      ts: "3999.000200",
      thread_ts: threadTs,
      channel: channelId,
    });
    const fastRunId = await pollSlackRun(runnerGroup);
    const fastClaim = await runs.claimRunnerJob(fastRunId);
    expect(fastClaim.cliAgentType).toBe("codex");
    expect(fastClaim.platformEnvironment.OKOU_CODEX_SERVICE_TIER).toBe("fast");
    const fastOkouToken = fastClaim.platformEnvironment.OKOU_TOKEN;
    if (!fastOkouToken) {
      throw new Error("Expected the Slack Fast run to expose OKOU_TOKEN");
    }

    const agentSend = await integrations.requestSendSlackMessageAsRun(
      fastOkouToken,
      {
        channel: channelId,
        text: "agent-initiated fast message",
      },
      [200],
    );
    expect(agentSend.body).toMatchObject({ ok: true });
    expect(slackPostMessageCallsJson()).toContain("GPT 6 Astra Fast");

    await chat.updateThreadModelSelection(actor, threadId, "gpt-6-astra", {
      codexServiceTier: null,
    });
    context.mocks.slack.chat.postMessage.mockClear();
    await completeSlackTriggeredRun({
      runId: fastRunId,
      sandboxToken: fastClaim.sandboxToken,
      cliAgentType: "codex",
      codexAgentMessageText: "fast answer",
    });
    await flushWaitUntilAndAssert(() => {
      expect(slackPostMessageCallsJson()).toContain("GPT 6 Astra Fast");
    });
  });

  it("delivers canonical Slack callbacks for progress, attribution footers, failures, and Slack errors", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    integrations.configureSlackAppMocks();
    integrations.acceptSlackSessionHistoryDownloads();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await integrations.configureSlackRunModelPolicies(actor);
    await bdd.readOnboardingStatus(actor);
    await integrations.enableOkouDebug(actor);
    const slackUser1 = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUser1,
    });
    integrations.clearSlackCallHistory();

    const channelId = "C_BDD_ORG_CB";
    const threadT1 = "4000.000100";
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUser1,
      text: "summarize the thread",
      ts: threadT1,
      channel: channelId,
    });
    const run1Id = await pollSlackRun(runnerGroup);
    const claim1 = await runs.claimRunnerJob(run1Id);
    context.mocks.slack.assistant.threads.setStatus.mockClear();
    await webhooks.requestAgentHeartbeat(
      { runId: run1Id },
      { authorization: `Bearer ${claim1.sandboxToken}` },
      [200],
    );
    await flushWaitUntilAndAssert(() => {
      expect(
        context.mocks.slack.assistant.threads.setStatus,
      ).toHaveBeenCalledWith({
        channel_id: channelId,
        thread_ts: threadT1,
        status: "is thinking...",
      });
    });

    let failedMessagePublishCount = 0;
    let failedThreadListPublishCount = 0;
    context.mocks.ably.publish.mockImplementation((topic: unknown) => {
      if (
        typeof topic === "string" &&
        topic.startsWith("chatThreadMessageCreated:")
      ) {
        failedMessagePublishCount++;
        return Promise.reject(new Error("message realtime publish failed"));
      }
      if (topic === "threadListChanged") {
        failedThreadListPublishCount++;
        return Promise.reject(new Error("thread list publish failed"));
      }
      return Promise.resolve(undefined);
    });
    await completeSlackTriggeredRun({
      runId: run1Id,
      sandboxToken: claim1.sandboxToken,
      cliAgentType: "claude-code",
      resultText: "SLACK_BDD_OUTPUT",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          channel: channelId,
          thread_ts: threadT1,
          text: "SLACK_BDD_OUTPUT",
          blocks: [
            { type: "markdown", text: "SLACK_BDD_OUTPUT" },
            {
              type: "context",
              elements: [{ type: "mrkdwn", text: "Claude Fable 5.1" }],
            },
          ],
        }),
      );
    });
    expect(failedMessagePublishCount).toBeGreaterThan(0);
    expect(failedThreadListPublishCount).toBeGreaterThan(0);
    context.mocks.ably.publish.mockResolvedValue(undefined);

    await flushWaitUntilAndAssert(() => {
      expect(
        context.mocks.slack.assistant.threads.setStatus,
      ).toHaveBeenLastCalledWith({
        channel_id: channelId,
        thread_ts: threadT1,
        status: "",
      });
    });
    const run1 = await runs.readRun(actor, run1Id);
    expect(run1.status).toBe("completed");

    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUser1,
      text: "answer through codex items",
      ts: "4000.000200",
      channel: channelId,
    });
    const run2Id = await pollSlackRun(runnerGroup);
    const claim2 = await runs.claimRunnerJob(run2Id);
    await completeSlackTriggeredRun({
      runId: run2Id,
      sandboxToken: claim2.sandboxToken,
      cliAgentType: "claude-code",
      codexAgentMessageText: "final codex answer",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "final codex answer" }),
      );
    });

    if (!actor.orgId) {
      throw new Error("Expected the Slack chain actor to have an org");
    }
    const actor2 = integrations.user({
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    await bdd.completeOnboarding(actor2);

    const slackUser2 = uniqueSlackUserId();
    await integrations.connectSlackUser(actor2, {
      workspaceId: teamId,
      slackUserId: slackUser2,
    });
    // A member's new thread starts from their own preference.
    await integrations.updateUserModelPreference(actor2, "claude-fable-5-1");
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUser2,
      text: "second opinion in the same thread",
      ts: "4000.000150",
      thread_ts: threadT1,
      channel: channelId,
    });
    const run3Id = await pollSlackRun(runnerGroup);
    const claim3 = await runs.claimRunnerJob(run3Id);
    context.mocks.slack.chat.postMessage.mockClear();
    await completeSlackTriggeredRun({
      runId: run3Id,
      sandboxToken: claim3.sandboxToken,
      cliAgentType: "claude-code",
      resultText: "SECOND_OPINION_OUTPUT",
    });
    await flushWaitUntilAndAssert(() => {
      expect(slackPostMessageCallsJson()).toContain(
        `Reply to <@${slackUser2}>`,
      );
    });
    const run3 = await runs.readRun(actor2, run3Id);
    expect(run3.status).toBe("completed");

    const threadT3 = "4000.000300";
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUser1,
      text: "resume a broken checkpoint",
      ts: threadT3,
      channel: channelId,
    });
    const run4Id = await pollSlackRun(runnerGroup);
    const claim4 = await runs.claimRunnerJob(run4Id);
    await webhooks.requestAgentComplete(
      {
        runId: run4Id,
        exitCode: 1,
        error: "Cannot continue session from checkpoint",
      },
      { authorization: `Bearer ${claim4.sandboxToken}` },
      [200],
    );
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text: "Cannot continue session from checkpoint",
        }),
      );
    });
    const run4 = await runs.readRun(actor, run4Id);
    expect(run4.status).toBe("failed");

    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUser1,
      text: "try the broken thing again",
      ts: "4000.000310",
      thread_ts: threadT3,
      channel: channelId,
    });
    const run5Id = await pollSlackRun(runnerGroup);
    const claim5 = await runs.claimRunnerJob(run5Id);
    await webhooks.requestAgentComplete(
      { runId: run5Id, exitCode: 1 },
      { authorization: `Bearer ${claim5.sandboxToken}` },
      [200],
    );
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text: "Oops, something went wrong. Please try again later.",
        }),
      );
    });
    const run5 = await runs.readRun(actor, run5Id);
    expect(run5.status).toBe("failed");

    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUser1,
      text: "post into a vanished channel",
      ts: "4000.000400",
      channel: channelId,
    });
    const run6Id = await pollSlackRun(runnerGroup);
    const claim6 = await runs.claimRunnerJob(run6Id);
    context.mocks.slack.chat.postMessage.mockRejectedValueOnce(
      Object.assign(new Error("channel_not_found"), {
        data: { ok: false, error: "channel_not_found" },
      }),
    );
    await completeSlackTriggeredRun({
      runId: run6Id,
      sandboxToken: claim6.sandboxToken,
      cliAgentType: "claude-code",
      resultText: "UNDELIVERED_OUTPUT",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          channel: channelId,
          thread_ts: "4000.000400",
          text: "UNDELIVERED_OUTPUT",
        }),
      );
    });
    const run6 = await runs.readRun(actor, run6Id);
    expect(run6.status).toBe("completed");
  }, 90_000);

  it("keeps canonical Slack callbacks visible when status updates fail and installs vanish", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    integrations.configureSlackAppMocks();
    integrations.acceptSlackSessionHistoryDownloads();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await bdd.readOnboardingStatus(actor);
    await integrations.configureSlackRunModelPolicies(actor);
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    integrations.clearSlackCallHistory();

    const channelId = "C_BDD_CALLBACK_RESILIENCE";
    const threadU1 = "5100.000100";
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "run while Slack status updates fail",
      ts: threadU1,
      channel: channelId,
    });
    const run1Id = await pollSlackRun(runnerGroup);
    const claim1 = await runs.claimRunnerJob(run1Id);
    expect(claim1.cliAgentType).toBe("claude-code");
    expect(claim1.environment).toMatchObject({
      ANTHROPIC_API_KEY: expect.stringMatching(/.+/),
      ANTHROPIC_MODEL: "claude-fable-5-1",
    });

    context.mocks.slack.assistant.threads.setStatus.mockRejectedValueOnce(
      new Error("status_boom"),
    );
    await webhooks.requestAgentHeartbeat(
      { runId: run1Id },
      { authorization: `Bearer ${claim1.sandboxToken}` },
      [200],
    );
    await flushWaitUntilAndAssert(() => {
      expect(
        context.mocks.slack.assistant.threads.setStatus,
      ).toHaveBeenLastCalledWith({
        channel_id: channelId,
        thread_ts: threadU1,
        status: "is thinking...",
      });
    });

    await completeSlackTriggeredRun({
      runId: run1Id,
      sandboxToken: claim1.sandboxToken,
      cliAgentType: "claude-code",
      resultText: "CALLBACK_RESILIENCE_OUTPUT",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          channel: channelId,
          thread_ts: threadU1,
          text: "CALLBACK_RESILIENCE_OUTPUT",
        }),
      );
    });
    const run1 = await runs.readRun(actor, run1Id);
    expect(run1.status).toBe("completed");

    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "survive the uninstall",
      ts: "5100.000200",
      channel: channelId,
    });
    const run2Id = await pollSlackRun(runnerGroup);
    const claim2 = await runs.claimRunnerJob(run2Id);
    await integrations.postSlackEvent(teamId, { type: "app_uninstalled" });
    context.mocks.slack.assistant.threads.setStatus.mockClear();
    await webhooks.requestAgentHeartbeat(
      { runId: run2Id },
      { authorization: `Bearer ${claim2.sandboxToken}` },
      [200],
    );
    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).not.toHaveBeenCalled();

    context.mocks.slack.chat.postMessage.mockClear();
    await completeSlackTriggeredRun({
      runId: run2Id,
      sandboxToken: claim2.sandboxToken,
      cliAgentType: "claude-code",
    });
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    const run2 = await runs.readRun(actor, run2Id);
    expect(run2.status).toBe("completed");
  }, 90_000);
});

describe("INT-02: Telegram integration", () => {
  it("keeps unlinked bot and missing upload errors visible through APIs", async () => {
    const actor = integrations.user();
    const missingBotId = "999999999";

    const linkStatus = await integrations.readTelegramLinkStatus(
      actor,
      missingBotId,
    );
    expect(linkStatus).toMatchObject({ linked: false });

    const missingUpload = await integrations.requestTelegramUploadComplete(
      actor,
      {
        uploadId: "11111111-1111-4111-8111-111111111111",
        botId: missingBotId,
        chatId: "12345",
      },
      [404],
    );
    expect(missingUpload.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("keeps Telegram webhook missing, auth, and no-op update boundaries visible", async () => {
    const missingCustomBot = await integrations.requestTelegramWebhook(
      "999999999",
      "{}",
      { "x-telegram-bot-api-secret-token": "missing-custom-secret" },
      [404],
    );
    expect(missingCustomBot.body).toBe("Not Found");

    mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", undefined);
    mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", undefined);
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", undefined);

    const unconfigured = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      "{}",
      {},
      [404],
    );
    expect(unconfigured.body).toBe("Not Found");

    mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", "123456:bdd-token");
    mockEnv(
      "TELEGRAM_OFFICIAL_WEBHOOK_SECRET",
      TELEGRAM_OFFICIAL_WEBHOOK_SECRET,
    );
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "bdd_official_bot");

    const unauthorized = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      "{}",
      {},
      [401],
    );
    expect(unauthorized.body).toBe("Unauthorized");

    const invalidSecret = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      "{}",
      { "x-telegram-bot-api-secret-token": "bad-secret" },
      [401],
    );
    expect(invalidSecret.body).toBe("Unauthorized");

    const invalidJson = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      "not-json",
      { "x-telegram-bot-api-secret-token": TELEGRAM_OFFICIAL_WEBHOOK_SECRET },
      [400],
    );
    expect(invalidJson.body).toBe("Bad Request");

    const invalidUpdate = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      "null",
      { "x-telegram-bot-api-secret-token": TELEGRAM_OFFICIAL_WEBHOOK_SECRET },
      [400],
    );
    expect(invalidUpdate.body).toBe("Bad Request");

    const noMessage = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      JSON.stringify({ update_id: 1001 }),
      { "x-telegram-bot-api-secret-token": TELEGRAM_OFFICIAL_WEBHOOK_SECRET },
      [200],
    );
    expect(noMessage.body).toBe("OK");

    const noContentMessage = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      JSON.stringify({
        update_id: 1002,
        message: {
          message_id: 42,
          chat: { id: 12_345, type: "private" },
          from: { id: 54_321, first_name: "BDD" },
        },
      }),
      { "x-telegram-bot-api-secret-token": TELEGRAM_OFFICIAL_WEBHOOK_SECRET },
      [200],
    );
    expect(noContentMessage.body).toBe("OK");
  });

  it("uses Okou app links in official Telegram missing-agent guidance", async () => {
    const officialToken = "123456:bdd-official-okou-token";
    const officialUsername = "bdd_official_okou_bot";
    mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", officialToken);
    mockEnv(
      "TELEGRAM_OFFICIAL_WEBHOOK_SECRET",
      TELEGRAM_OFFICIAL_WEBHOOK_SECRET,
    );
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", officialUsername);
    const sentMessages: unknown[] = [];
    server.use(
      http.post(
        `https://api.telegram.org/bot${officialToken}/sendMessage`,
        async ({ request }) => {
          sentMessages.push(await request.json());
          return HttpResponse.json({
            ok: true,
            result: { message_id: 301, chat: { id: 91_234_567 } },
          });
        },
      ),
    );

    const actor = integrations.user();
    bdd.acceptAgentStorageWrites();
    await bdd.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "BDD Telegram Missing Agent",
    });
    const onboarding = await bdd.readOnboardingStatus(actor);
    if (!onboarding.defaultAgentId) {
      throw new Error("Expected Telegram onboarding to configure an agent");
    }

    const telegramUserId = randomInt(100_000_000, 999_999_999);
    await integrations.requestLinkTelegram(
      actor,
      {
        telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
        telegramAuth: telegramLoginAuth(officialToken, {
          id: telegramUserId,
          first_name: "BDD",
          username: "bdd_official_okou_user",
        }),
      },
      [200],
    );
    await seedLegacyMissingDefaultAgentFixture(onboarding.defaultAgentId);

    const inbound = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      JSON.stringify({
        update_id: 2100,
        message: {
          message_id: 88,
          chat: { id: telegramUserId, type: "private" },
          from: {
            id: telegramUserId,
            first_name: "BDD",
            username: "bdd_official_okou_user",
          },
          text: "hello",
        },
      }),
      { "x-telegram-bot-api-secret-token": TELEGRAM_OFFICIAL_WEBHOOK_SECRET },
      [200],
    );
    expect(inbound.body).toBe("OK");
    await flushWaitUntilForTest();
    expect(JSON.stringify(sentMessages)).toContain(
      "Please choose an agent in Okou first.",
    );
  });
  it("keeps Telegram Fast footers bound to the originating run", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    const actor = integrations.user();
    await integrations.enableOkouDebug(actor);
    await configureFastCodexPreference(actor);

    const telegramBotId = randomInt(1_000_000_000, 9_999_999_999);
    const telegramBotToken = `${telegramBotId}:bdd-fast-token`;
    const botId = OFFICIAL_TELEGRAM_BOT_ID;
    mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", telegramBotToken);
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "bdd_official_fast_bot");
    mockEnv(
      "TELEGRAM_OFFICIAL_WEBHOOK_SECRET",
      TELEGRAM_OFFICIAL_WEBHOOK_SECRET,
    );
    const webhookSecret = TELEGRAM_OFFICIAL_WEBHOOK_SECRET;
    const sentMessages: Record<string, unknown>[] = [];
    server.use(
      http.post(
        `https://api.telegram.org/bot${telegramBotToken}/sendChatAction`,
        () => {
          return HttpResponse.json({ ok: true, result: true });
        },
      ),
      http.post(
        `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
        async ({ request }) => {
          sentMessages.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json({
            ok: true,
            result: { message_id: 655, chat: { id: 8_811_224 } },
          });
        },
      ),
    );
    const telegramUserId = randomInt(100_000_000, 999_999_999);
    await integrations.requestLinkTelegram(
      actor,
      {
        telegramBotId: botId,
        telegramAuth: telegramLoginAuth(telegramBotToken, {
          id: telegramUserId,
          first_name: "BDD",
          username: "bdd_fast_user",
        }),
      },
      [200],
    );

    const dmChatId = 8_811_224;
    const inbound = await integrations.requestTelegramWebhook(
      botId,
      JSON.stringify({
        update_id: 4002,
        message: {
          message_id: 72,
          chat: { id: dmChatId, type: "private" },
          from: {
            id: telegramUserId,
            first_name: "BDD",
            username: "bdd_fast_user",
          },
          text: "reply using the originating Fast run",
        },
      }),
      { "x-telegram-bot-api-secret-token": webhookSecret },
      [200],
    );
    expect(inbound.body).toBe("OK");

    const runId = await pollRunnerRun(
      runnerGroup,
      "Expected the Fast Telegram DM to dispatch a run",
    );
    const claim = await runs.claimRunnerJob(runId);
    expect(claim.cliAgentType).toBe("codex");
    expect(claim.platformEnvironment.OKOU_CODEX_SERVICE_TIER).toBe("fast");
    const okouToken = claim.platformEnvironment.OKOU_TOKEN;
    if (!okouToken) {
      throw new Error("Expected the Telegram Fast run to expose OKOU_TOKEN");
    }

    const agentSend = await integrations.requestSendTelegramMessageAsRun(
      okouToken,
      {
        botId,
        chatId: String(dmChatId),
        text: "agent-initiated fast message",
      },
      [200],
    );
    expect(agentSend.body).toMatchObject({ ok: true });
    expect(JSON.stringify(sentMessages)).toContain("GPT 6 Astra Fast");

    sentMessages.length = 0;
    await integrations.updateUserModelPreference(actor, "gpt-6-astra", null);
    await completeSlackTriggeredRun({
      runId,
      sandboxToken: claim.sandboxToken,
      cliAgentType: "codex",
      codexAgentMessageText: "telegram fast reply",
    });
    await flushWaitUntilAndAssert(() => {
      expect(sentMessages).toStrictEqual([
        expect.objectContaining({
          text: "telegram fast reply\n\n<i>GPT 6 Astra Fast</i>",
        }),
      ]);
    });
  });

  it("refreshes telegram typing for pending webhook-dispatched runs", async () => {
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    const actor = integrations.user();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });

    const typingBotId = randomInt(1_000_000_000, 9_999_999_999);
    const typingBotToken = `${typingBotId}:bdd-typing-token`;
    const botId = OFFICIAL_TELEGRAM_BOT_ID;
    mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", typingBotToken);
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "bdd_official_typing_bot");
    mockEnv(
      "TELEGRAM_OFFICIAL_WEBHOOK_SECRET",
      TELEGRAM_OFFICIAL_WEBHOOK_SECRET,
    );
    const webhookSecret = TELEGRAM_OFFICIAL_WEBHOOK_SECRET;
    await bdd.readOnboardingStatus(actor);
    const chatActions: {
      readonly chat_id: string;
      readonly action: string;
    }[] = [];
    server.use(
      http.post(
        `https://api.telegram.org/bot${typingBotToken}/sendChatAction`,
        async ({ request }) => {
          chatActions.push(
            (await request.json()) as (typeof chatActions)[number],
          );
          return HttpResponse.json({ ok: true, result: true });
        },
      ),
      http.post(
        `https://api.telegram.org/bot${typingBotToken}/sendMessage`,
        () => {
          return HttpResponse.json({
            ok: true,
            result: { message_id: 654, chat: { id: 999_111 } },
          });
        },
      ),
    );
    const telegramUserId = randomInt(100_000_000, 999_999_999);
    await integrations.requestLinkTelegram(
      actor,
      {
        telegramBotId: botId,
        telegramAuth: telegramLoginAuth(typingBotToken, {
          id: telegramUserId,
          first_name: "BDD",
          username: "bdd_typing_user",
        }),
      },
      [200],
    );
    const linkStatus = await integrations.readTelegramLinkStatus(actor, botId);
    expect(linkStatus).toMatchObject({ linked: true });

    // A linked DM dispatches a run carrying a pending Telegram callback.
    const dmChatId = 8_811_223;
    const dm = await integrations.requestTelegramWebhook(
      botId,
      JSON.stringify({
        update_id: 4001,
        message: {
          message_id: 71,
          chat: { id: dmChatId, type: "private" },
          from: {
            id: telegramUserId,
            first_name: "BDD",
            username: "bdd_typing_user",
          },
          text: "summarize my telegram inbox",
        },
      }),
      { "x-telegram-bot-api-secret-token": webhookSecret },
      [200],
    );
    expect(dm.body).toBe("OK");

    // Poll only: claiming is not needed for typing refreshes.
    const runId = await pollRunnerRun(
      runnerGroup,
      "Expected the Telegram DM to dispatch a run",
    );
    const typingBody = {
      runId,
      events: [{ type: "assistant", sequenceNumber: 1 }],
    };
    const sandboxHeaders = {
      authorization: `Bearer ${runs.sandboxTokenForRun(actor, runId)}`,
    };
    const actionsBeforeTyping = chatActions.length;
    const typing = await webhooks.requestAgentEvents(
      typingBody,
      sandboxHeaders,
      [200],
    );
    expect(typing.body).toStrictEqual({
      received: 1,
      firstSequence: 1,
      lastSequence: 1,
    });
    await flushWaitUntilForTest();
    expect(chatActions.slice(actionsBeforeTyping)).toStrictEqual([
      { chat_id: String(dmChatId), action: "typing" },
    ]);

    // Run cancellation dispatches completion callbacks via waitUntil. Wait for
    // those side effects to settle before checking that later typing refreshes
    // no longer see pending Telegram callbacks.
    await runs.requestCancelRun(actor, runId, [200]);
    await flushWaitUntilForTest();
    await expect(
      (async () => {
        const run = await runs.readRun(actor, runId);
        return run.status;
      })(),
    ).resolves.toBe("cancelled");
    await flushWaitUntilForTest();
    const actionsAfterCancel = chatActions.length;
    const idleTyping = await webhooks.requestAgentEvents(
      typingBody,
      sandboxHeaders,
      [200],
    );
    expect(idleTyping.body).toStrictEqual({
      received: 1,
      firstSequence: 1,
      lastSequence: 1,
    });
    await flushWaitUntilForTest();
    expect(chatActions).toHaveLength(actionsAfterCancel);
  });
});

describe("INT-03: GitHub and AgentPhone integrations", () => {
  it("keeps GitHub OAuth install and connect-start errors visible through redirects", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    integrations.clearGithubAppProvider();
    await installApiTestConnectorCatalog();

    const unconfiguredInstall = await integrations.requestGithubOauthInstall(
      {},
      [503],
    );
    expect(unconfiguredInstall.body).toStrictEqual({
      error: "GitHub App integration is not configured",
    });

    integrations.configureGithubAppInstallProvider();
    const install = await integrations.requestGithubOauthInstall({}, [307]);
    const installLocation = install.headers.get("location") ?? "";
    expect(installLocation).toContain(
      "https://github.com/apps/bdd-github-app/installations/new",
    );
    expect(new URL(installLocation).searchParams.get("redirect_uri")).toBe(
      "https://api.okou.ai/api/github/app/setup/callback",
    );
    expect(install.headers.get("Cache-Control")).toBe("no-store");

    const admin = integrations.user();
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected GitHub admin test user to have an org");
    }
    const member = integrations.user({
      orgId,
      orgRole: "org:member",
    });
    await integrations.readGithubInstallation(member);
    const nonAdminInstall = await integrations.requestGithubOauthInstall(
      {
        orgId,
        userId: member.userId,
      },
      [307],
    );
    expect(nonAdminInstall.headers.get("location") ?? "").toContain(
      "Only%20organization%20admins%20can%20install%20GitHub",
    );

    const unauthenticatedConnect = await integrations.requestGithubOauthConnect(
      null,
      {},
      [307],
    );
    const unauthenticatedLocation =
      unauthenticatedConnect.headers.get("location");
    if (!unauthenticatedLocation) {
      throw new Error("Expected app sign-in redirect");
    }
    const unauthenticatedUrl = new URL(unauthenticatedLocation);
    expect(unauthenticatedUrl.origin).toBe("https://app.okou.ai");
    expect(unauthenticatedUrl.pathname).toBe("/sign-in");
    const redirectUrl = unauthenticatedUrl.searchParams.get("redirect_url");
    if (!redirectUrl) {
      throw new Error("Expected redirect_url query parameter");
    }
    expect(new URL(redirectUrl).pathname).toBe("/api/github/oauth/connect");

    const actor = integrations.user();
    const invalidSignedConnect = await integrations.requestGithubOauthConnect(
      actor,
      {
        installation: "12345",
        ghUser: "67890",
      },
      [307],
    );
    expect(invalidSignedConnect.headers.get("location") ?? "").toContain(
      "Invalid%20or%20expired%20GitHub%20connect%20link",
    );

    const timestamp = Math.floor(now() / 1000);
    const validSignedMissingInstallation =
      await integrations.requestGithubOauthConnect(
        actor,
        {
          installation: "12345",
          ghUser: "67890",
          ghLogin: "@bdd-github-user",
          ts: timestamp,
          sig: githubConnectSignature({
            installationId: "12345",
            githubUserId: "67890",
            githubUsername: "@bdd-github-user",
            timestamp,
          }),
        },
        [307],
      );
    expect(
      validSignedMissingInstallation.headers.get("location") ?? "",
    ).toContain("No%20GitHub%20installation%20found%20for%20this%20workspace");

    const unconfiguredConnect = await integrations.requestGithubOauthConnect(
      actor,
      {},
      [307],
    );
    expect(unconfiguredConnect.headers.get("location") ?? "").toContain(
      "GitHub%20OAuth%20is%20not%20available",
    );
  });

  it("starts configured GitHub user OAuth with connector state", async () => {
    const tokenRedirectUris: string[] = [];
    server.use(
      http.post(
        "https://github.com/login/oauth/access_token",
        async ({ request }) => {
          const body = new URLSearchParams(await request.text());
          tokenRedirectUris.push(body.get("redirect_uri") ?? "");
          return HttpResponse.json({
            access_token: "bdd-github-user-token",
            scope: "repo,project,workflow",
          });
        },
      ),
      http.get("https://api.github.com/user", () => {
        return HttpResponse.json({
          id: 4242,
          login: "bdd-github-user",
          email: null,
        });
      }),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    integrations.clearGithubAppProvider();
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", "bdd-github-client-id");
    mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "bdd-github-client-secret");
    await installApiTestConnectorCatalog();

    const actor = integrations.user();
    const response = await integrations.requestGithubOauthConnect(
      actor,
      {},
      [307],
    );
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("Expected GitHub authorization redirect");
    }
    const authorizationUrl = new URL(location);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "bdd-github-client-id",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://api.okou.ai/api/connectors/github/callback",
    );
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toMatch(/^[0-9a-f]{64}$/u);
    if (!state) {
      throw new Error("Expected GitHub authorization state");
    }
    await expect(
      readConnectorOAuthAccountMutation(context, state),
    ).resolves.toMatchObject({
      account_mutation: { intent: "add" },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const callback = await connectors.completeOauthCallback(
      "github",
      { code: "bdd-github-code", state },
      { baseUrl: "https://api.okou.ai" },
    );
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.origin).toBe("https://app.okou.ai");
    expect(callbackLocation.searchParams.get("message")).toBeNull();
    expect(callbackLocation.pathname).toBe("/connector/success");

    expect(tokenRedirectUris).toStrictEqual([
      "https://api.okou.ai/api/connectors/github/callback",
    ]);
  });

  it("signs the GitHub install callback redirect in provider state", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    integrations.clearGithubAppProvider();
    integrations.configureGithubAppInstallProvider();

    const installQuery = {
      userId: `user_${randomUUID()}`,
      composeId: `agent_${randomUUID()}`,
    };
    const okouInstall = await integrations.requestGithubOauthInstall(
      installQuery,
      [307],
    );
    const okouStateString =
      new URL(okouInstall.headers.get("location") ?? "").searchParams.get(
        "state",
      ) ?? "";
    expect(okouStateString).not.toBe("");
    const okouState: unknown = JSON.parse(okouStateString);
    expect(okouState).toMatchObject({
      callbackRedirectUri: "https://api.okou.ai/api/github/app/setup/callback",
      callbackRedirectUriSig: expect.stringMatching(/^[0-9a-f]{64}$/u),
      sig: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });

    integrations.configureGithubAppCallbackProvider();
    const okouError = await integrations.requestGithubAppSetupCallback(
      {
        error: "access_denied",
        error_description: "Provider denied access",
        state: okouStateString,
      },
      [307],
    );
    expect(new URL(okouError.headers.get("location") ?? "").origin).toBe(
      "https://app.okou.ai",
    );

    if (!isRecord(okouState)) {
      throw new Error("Expected Okou GitHub OAuth state to be an object");
    }
    const tamperedCallbackState = JSON.stringify({
      ...okouState,
      callbackRedirectUri: "https://attacker.example/callback",
    });
    const tamperedCallback = await integrations.requestGithubAppSetupCallback(
      {
        error: "access_denied",
        error_description: "Provider denied access",
        state: tamperedCallbackState,
      },
      [307],
    );
    expect(new URL(tamperedCallback.headers.get("location") ?? "").origin).toBe(
      "https://app.okou.ai",
    );
  });

  it("keeps GitHub app setup callback errors visible through redirects", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    integrations.clearGithubAppProvider();
    const unconfiguredSetup = await integrations.requestGithubAppSetupCallback(
      {},
      [307],
    );
    expect(unconfiguredSetup.headers.get("location") ?? "").toContain(
      "GitHub%20App%20integration%20is%20not%20configured",
    );

    integrations.configureGithubAppInstallProvider();
    integrations.configureGithubAppCallbackProvider();

    const updateSetup = await integrations.requestGithubAppSetupCallback(
      { setup_action: "update" },
      [307],
    );
    expect(updateSetup.headers.get("location") ?? "").toContain("/workflows");

    const setupError = await integrations.requestGithubAppSetupCallback(
      {
        error: "setup_denied",
        error_description: "Setup denied",
      },
      [307],
    );
    expect(setupError.headers.get("location") ?? "").toContain(
      "Setup%20denied",
    );

    const setupInvalidState = await integrations.requestGithubAppSetupCallback(
      {
        installation_id: "12345",
        setup_action: "install",
        state: "not-a-valid-state",
      },
      [307],
    );
    expect(setupInvalidState.headers.get("location") ?? "").toContain(
      "Invalid%20OAuth%20state",
    );

    const admin = integrations.user();
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected GitHub admin test user to have an org");
    }
    const agent = await bdd.createAgent(admin, {
      displayName: "BDD GitHub setup agent",
    });
    await integrations.readGithubInstallation(admin);
    const installWithState = await integrations.requestGithubOauthInstall(
      {
        orgId,
        userId: admin.userId,
        composeId: agent.agentId,
      },
      [307],
    );
    const signedState =
      new URL(installWithState.headers.get("location") ?? "").searchParams.get(
        "state",
      ) ?? "";
    expect(signedState).not.toBe("");

    const parsedSignedState: unknown = JSON.parse(signedState);
    if (!isRecord(parsedSignedState)) {
      throw new Error("Expected signed GitHub state to be an object");
    }
    const tamperedState = JSON.stringify({
      ...parsedSignedState,
      sig: "0".repeat(64),
    });
    const setupTamperedState = await integrations.requestGithubAppSetupCallback(
      {
        installation_id: "12345",
        setup_action: "install",
        state: tamperedState,
      },
      [307],
    );
    expect(setupTamperedState.headers.get("location") ?? "").toContain(
      "Invalid%20state%20signature",
    );

    const installWithoutAgent = await integrations.requestGithubOauthInstall(
      {
        orgId,
        userId: admin.userId,
      },
      [307],
    );
    const stateWithoutAgent =
      new URL(
        installWithoutAgent.headers.get("location") ?? "",
      ).searchParams.get("state") ?? "";
    expect(stateWithoutAgent).not.toBe("");
    const setupMissingAgent = await integrations.requestGithubAppSetupCallback(
      {
        installation_id: "12345",
        setup_action: "install",
        state: stateWithoutAgent,
      },
      [307],
    );
    expect(setupMissingAgent.headers.get("location") ?? "").toContain(
      "Missing%20default%20agent",
    );

    const requestSetup = await integrations.requestGithubAppSetupCallback(
      {
        setup_action: "request",
        state: signedState,
      },
      [307],
    );
    expect(requestSetup.headers.get("location") ?? "").toContain(
      "permission%20to%20install%20this%20GitHub%20App",
    );

    const missingInstallation =
      await integrations.requestGithubAppSetupCallback(
        {
          setup_action: "install",
          state: signedState,
        },
        [307],
      );
    expect(missingInstallation.headers.get("location") ?? "").toContain(
      "Missing%20installation%20ID%20from%20GitHub",
    );
  });

  it("keeps GitHub no-install read and upload-init surfaces visible through APIs", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    integrations.configureGithubAppInstallProvider();
    const actor = integrations.user();

    const installation = await integrations.readGithubInstallation(actor);
    expect(installation.status).toBe(404);
    expect(installation.body).toMatchObject({
      error: {
        message: "No GitHub installation found",
        code: "NOT_FOUND",
      },
    });
    const adminInstallUrl =
      "installUrl" in installation.body ? installation.body.installUrl : null;
    if (!adminInstallUrl) {
      throw new Error("Expected an install URL for organization admins");
    }
    expect(adminInstallUrl).toContain(
      "https://github.com/apps/bdd-github-app/installations/new",
    );
    expect(new URL(adminInstallUrl).searchParams.get("redirect_uri")).toBe(
      "https://api.okou.ai/api/github/app/setup/callback",
    );

    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected GitHub admin test user to have an org");
    }
    const member = integrations.user({ orgId, orgRole: "org:member" });
    const memberInstallation =
      await integrations.readGithubInstallation(member);
    expect(memberInstallation.status).toBe(404);
    expect(
      "installUrl" in memberInstallation.body
        ? memberInstallation.body.installUrl
        : "unset",
    ).toBeNull();

    chat.mockEmptyObjectStorage();
    const upload = await integrations.requestGithubUploadInit(
      actor,
      {
        filename: "artifact.txt",
        contentType: "text/plain",
        length: 10,
      },
      [200],
    );
    expect(upload.body).toMatchObject({
      filename: "artifact.txt",
      contentType: "text/plain",
      size: 10,
    });
    expect("uploadUrl" in upload.body ? upload.body.uploadUrl : "").toMatch(
      /^https?:\/\//,
    );

    const uploadId =
      "uploadId" in upload.body
        ? upload.body.uploadId
        : "22222222-2222-4222-8222-222222222222";
    const complete = await integrations.requestGithubUploadComplete(
      actor,
      {
        uploadId,
        repo: "okou-ai/okou",
        issueNumber: 1,
        caption: "BDD GitHub upload",
      },
      [404],
    );
    expect(complete.body).toStrictEqual({
      error: {
        message: "No GitHub installation found",
        code: "NOT_FOUND",
      },
    });
  });

  it("keeps AgentPhone status, invalid connect, auth, and unlinked-send errors visible through APIs", async () => {
    const actor = integrations.user();
    integrations.configureAgentPhoneProvider();

    const initialStatus = await integrations.getAgentPhoneLinkStatus(actor);
    expect(initialStatus).toStrictEqual({
      linked: false,
      agentPhoneNumber: "+19039853128",
      configured: true,
    });

    const invalidConnect = await integrations.requestConnectAgentPhone(
      actor,
      {
        phoneHandle: "+15555551212",
        agentphoneAgentId: "agt-bdd-agentphone",
        timestamp: Math.floor(now() / 1000),
        signature: "bad-signature",
        channel: "sms",
      },
      [400],
    );
    expect(invalidConnect.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    const unauthorizedMessage = await integrations.requestSendPhoneMessage(
      null,
      {
        text: "BDD AgentPhone message",
      },
      [401],
    );
    expect(unauthorizedMessage.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const unlinkedSend = await integrations.requestSendPhoneMessage(
      actor,
      { text: "not linked" },
      [404],
    );
    expect(unlinkedSend.body).toStrictEqual({
      error: {
        message: "No phone is connected to this Okou account",
        code: "NOT_FOUND",
      },
    });

    chat.mockEmptyObjectStorage();
    const uploadInit = await integrations.requestPhoneUploadInit(
      actor,
      {
        filename: "agentphone-note.txt",
        contentType: "text/plain",
        length: 13,
      },
      [200],
    );
    expect(uploadInit.body).toMatchObject({
      filename: "agentphone-note.txt",
      contentType: "text/plain",
      size: 13,
    });
    expect(
      "uploadUrl" in uploadInit.body ? uploadInit.body.uploadUrl : "",
    ).toMatch(/^https?:\/\//);

    const phoneUploadId =
      "uploadId" in uploadInit.body
        ? uploadInit.body.uploadId
        : "33333333-3333-4333-8333-333333333333";
    context.mocks.s3.send.mockResolvedValue({ Contents: [] });
    const missingUpload = await integrations.requestPhoneUploadComplete(
      actor,
      {
        uploadId: phoneUploadId,
        caption: "BDD AgentPhone upload",
      },
      [404],
    );
    expect(missingUpload.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const missingDownload = await integrations.requestPhoneDownloadFile(
      actor,
      "missing-agentphone-file",
      [404],
    );
    expect(missingDownload.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("keeps AgentPhone start-link, unlink, and webhook boundaries visible through APIs", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const actor = integrations.user();
    integrations.clearAgentPhoneProvider();

    const unauthorizedStart = await integrations.requestStartAgentPhoneLink(
      null,
      { phoneHandle: "+15555551212" },
      [401],
    );
    expect(unauthorizedStart.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const invalidPhone = await integrations.requestStartAgentPhoneLink(
      actor,
      { phoneHandle: "not-a-phone" },
      [400],
    );
    expect(invalidPhone.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    const notConfigured = await integrations.requestStartAgentPhoneLink(
      actor,
      { phoneHandle: "+15555551212" },
      [503],
    );
    expect(notConfigured.body).toStrictEqual({
      error: {
        message: "Phone messaging is not configured",
        code: "NOT_CONFIGURED",
      },
    });

    integrations.configureAgentPhoneProvider();
    let connectUrl: string | undefined;
    server.use(
      agentPhoneVerificationSend(200, (body) => {
        if (!isRecord(body) || typeof body.body !== "string") {
          return;
        }
        const match = body.body.match(/https?:\/\/\S+/u);
        if (match) {
          connectUrl = match[0];
        }
      }),
    );
    const phoneHandle = uniquePhoneHandle();
    const sent = await integrations.requestStartAgentPhoneLink(
      actor,
      { phoneHandle },
      [200],
    );
    expect(sent.body).toStrictEqual({
      phoneHandle,
      verificationSent: true,
    });

    const cooledDown = await integrations.requestStartAgentPhoneLink(
      actor,
      { phoneHandle },
      [429],
    );
    expect(cooledDown.body).toMatchObject({
      error: { code: "TOO_MANY_REQUESTS" },
    });

    if (!connectUrl) {
      throw new Error("Expected AgentPhone verification text to include a URL");
    }
    const connectParams = new URL(connectUrl).searchParams;
    expect(new URL(connectUrl).origin).toBe("https://app.okou.ai");
    expect([...connectParams.keys()]).toStrictEqual([
      "handle",
      "agent",
      "ts",
      "sig",
      "channel",
    ]);
    const timestamp = Number(connectParams.get("ts") ?? "");
    if (!Number.isFinite(timestamp)) {
      throw new Error("Expected AgentPhone connect URL to include timestamp");
    }
    const connectBody = {
      phoneHandle: connectParams.get("handle") ?? "",
      agentphoneAgentId: connectParams.get("agent") ?? "",
      timestamp,
      signature: connectParams.get("sig") ?? "",
      channel: connectParams.get("channel") ?? undefined,
    };
    const forgedConnect = await integrations.requestConnectAgentPhone(
      actor,
      { ...connectBody, signature: "0".repeat(64) },
      [400],
    );
    expect(forgedConnect.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    const connected = await integrations.requestConnectAgentPhone(
      actor,
      connectBody,
      [200],
    );
    expect(connected.body).toStrictEqual({ phoneHandle });

    const linkedStatus = await integrations.getAgentPhoneLinkStatus(actor);
    expect(linkedStatus).toStrictEqual({
      linked: true,
      phoneHandle,
      agentPhoneNumber: "+19039853128",
      configured: true,
    });

    const missingAgentMessage = await integrations.requestSendPhoneMessage(
      actor,
      { text: "BDD AgentPhone missing agent" },
      [404],
    );
    expect(missingAgentMessage.body).toStrictEqual({
      error: {
        message: "Phone agent not found",
        code: "NOT_FOUND",
      },
    });

    const sentPhoneMessage = await integrations.requestSendPhoneMessage(
      actor,
      {
        agentphoneAgentId: connectBody.agentphoneAgentId,
        text: "BDD linked AgentPhone message",
      },
      [200],
    );
    expect(sentPhoneMessage.body).toStrictEqual({
      ok: true,
      messageId: "msg-bdd-agentphone",
      channel: "sms",
      toNumber: phoneHandle,
    });

    server.use(agentPhoneVerificationSend(503));
    const failedPhoneMessage = await integrations.requestSendPhoneMessage(
      actor,
      {
        agentphoneAgentId: connectBody.agentphoneAgentId,
        text: "BDD AgentPhone provider failure",
      },
      [502],
    );
    expect(failedPhoneMessage.body).toMatchObject({
      error: { code: "AGENTPHONE_ERROR" },
    });

    const duplicateConnect = await integrations.requestConnectAgentPhone(
      integrations.user(),
      connectBody,
      [409],
    );
    expect(duplicateConnect.body).toMatchObject({
      error: { code: "CONFLICT" },
    });

    const alreadyLinkedStart = await integrations.requestStartAgentPhoneLink(
      actor,
      { phoneHandle: uniquePhoneHandle() },
      [409],
    );
    expect(alreadyLinkedStart.body).toMatchObject({
      error: { code: "CONFLICT" },
    });

    const disconnected = await integrations.requestUnlinkAgentPhone(
      actor,
      [204],
    );
    expect(disconnected.body).toBeUndefined();

    const unlinkedStatus = await integrations.getAgentPhoneLinkStatus(actor);
    expect(unlinkedStatus).toStrictEqual({
      linked: false,
      agentPhoneNumber: "+19039853128",
      configured: true,
    });

    const missingUnlink = await integrations.requestUnlinkAgentPhone(
      actor,
      [404],
    );
    expect(missingUnlink.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const unavailable = await integrations.requestStartAgentPhoneLink(
      integrations.user(),
      { phoneHandle: uniquePhoneHandle() },
      [503],
    );
    expect(unavailable.body).toStrictEqual({
      error: {
        message: "Verification text could not be sent",
        code: "PROVIDER_UNAVAILABLE",
      },
    });

    const noConfigWebhook = await integrations.requestAgentPhoneWebhook(
      "{}",
      {},
      [404],
    );
    expect(noConfigWebhook.body).toBe("Not Found");

    integrations.configureAgentPhoneWebhook();
    const rawMessage = JSON.stringify({
      event: "agent.message",
      channel: "sms",
      data: {
        agentId: "agt-bdd-agentphone",
        from: "+15555551212",
        to: "+19039853128",
        message: "hello",
      },
    });

    const invalidSignature = await integrations.requestAgentPhoneWebhook(
      rawMessage,
      {
        "x-webhook-signature": "bad-signature",
        "x-webhook-timestamp": String(Math.floor(now() / 1000)),
      },
      [401],
    );
    expect(invalidSignature.body).toBe("Unauthorized");

    const malformed = await integrations.requestAgentPhoneWebhook(
      "not-json",
      agentPhoneWebhookHeaders("not-json"),
      [400],
    );
    expect(malformed.body).toBe("Bad Request");

    const ignoredLifecycleEvent = JSON.stringify({
      event: "agent.status",
      data: { agentId: "agt-bdd-agentphone" },
    });
    const ignoredLifecycle = await integrations.requestAgentPhoneWebhook(
      ignoredLifecycleEvent,
      agentPhoneWebhookHeaders(
        ignoredLifecycleEvent,
        `evt-bdd-agentphone-${randomUUID()}`,
      ),
      [200],
    );
    expect(ignoredLifecycle.body).toBe("OK");

    const unsupportedChannelEvent = JSON.stringify({
      event: "agent.message",
      channel: "fax",
      data: {
        agentId: "agt-bdd-agentphone",
        from: "+15555551212",
        to: "+19039853128",
        message: "unsupported channel",
      },
    });
    const unsupportedChannel = await integrations.requestAgentPhoneWebhook(
      unsupportedChannelEvent,
      agentPhoneWebhookHeaders(
        unsupportedChannelEvent,
        `evt-bdd-agentphone-${randomUUID()}`,
      ),
      [200],
    );
    expect(unsupportedChannel.body).toBe("OK");

    const missingFieldsEvent = JSON.stringify({
      event: "agent.message",
      channel: "sms",
      data: {
        agentId: "agt-bdd-agentphone",
        to: "+19039853128",
        message: "missing sender",
      },
    });
    const missingFields = await integrations.requestAgentPhoneWebhook(
      missingFieldsEvent,
      agentPhoneWebhookHeaders(
        missingFieldsEvent,
        `evt-bdd-agentphone-${randomUUID()}`,
      ),
      [200],
    );
    expect(missingFields.body).toBe("OK");

    const wrongDestinationEvent = JSON.stringify({
      event: "agent.message",
      channel: "sms",
      data: {
        agentId: "agt-bdd-agentphone",
        from: "+15555551212",
        to: "+15555550000",
        message: "wrong destination",
      },
    });
    const wrongDestination = await integrations.requestAgentPhoneWebhook(
      wrongDestinationEvent,
      agentPhoneWebhookHeaders(
        wrongDestinationEvent,
        `evt-bdd-agentphone-${randomUUID()}`,
      ),
      [200],
    );
    expect(wrongDestination.body).toBe("OK");

    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    server.use(agentPhoneVerificationSend());
    const smsWebhookId = `evt-bdd-agentphone-${randomUUID()}`;
    const incomingSmsEvent = JSON.stringify({
      event: "agent.message",
      channel: "sms",
      data: {
        id: `msg-bdd-agentphone-${randomUUID()}`,
        agentId: "agt-bdd-agentphone",
        from: uniquePhoneHandle(),
        to: "+19039853128",
        message: "/connect",
      },
    });
    const incomingSms = await integrations.requestAgentPhoneWebhook(
      incomingSmsEvent,
      agentPhoneWebhookHeaders(incomingSmsEvent, smsWebhookId),
      [200],
    );
    expect(incomingSms.body).toBe("OK");

    const duplicateSms = await integrations.requestAgentPhoneWebhook(
      incomingSmsEvent,
      agentPhoneWebhookHeaders(incomingSmsEvent, smsWebhookId),
      [200],
    );
    expect(duplicateSms.body).toBe("OK");

    const unmentionedGroupEvent = JSON.stringify({
      event: "agent.message",
      channel: "imessage",
      data: {
        id: `msg-bdd-agentphone-${randomUUID()}`,
        agentId: "agt-bdd-agentphone",
        from: `sender-${randomUUID()}@example.test`,
        to: "+19039853128",
        message: "group update without a Nova mention",
        conversationId: `group-${randomUUID()}`,
        isGroup: true,
        mentioned: false,
      },
    });
    const unmentionedGroup = await integrations.requestAgentPhoneWebhook(
      unmentionedGroupEvent,
      agentPhoneWebhookHeaders(
        unmentionedGroupEvent,
        `evt-bdd-agentphone-${randomUUID()}`,
      ),
      [200],
    );
    expect(unmentionedGroup.body).toBe("OK");
  });
});
