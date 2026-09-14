import {
  seedLegacyMissingDefaultAgentFixture,
  seedLegacyPrivateDefaultAgentFixture,
} from "../../../test-fixtures/legacy-default-agent";
import { createHash, createHmac, randomInt, randomUUID } from "node:crypto";

import { OFFICIAL_TELEGRAM_BOT_ID } from "@okouai/api-contracts/contracts/integrations-telegram";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import {
  readChatEventContextFixture,
  readRunUsageEventsFixture,
} from "../../../test-fixtures/chat-events";
import {
  countPiMemoryStage1CandidatesFixture,
  readmitPiMemoryStage1CandidateFixture,
  readPiConversationIdentityFixture,
  readPiMemoryStage1CandidateFixture,
} from "../../../test-fixtures/pi-memory-stage1-candidates";
import { seededSystemSkillArchive } from "../../../test-fixtures/seeded-system-skill-archive";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import {
  agentPhoneBddWebhookSecret,
  createBddIntegrationApi,
  telegramLoginAuth,
} from "./helpers/api-bdd-integrations";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { readAgentRunCallbacks$ } from "./helpers/agent-run-callback";
import {
  readRunLaunchSnapshotFixture,
  readThreadSessionBinding,
} from "./helpers/runtime-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { readConnectorOAuthAccountMutation } from "./helpers/connector-credential-storage-state";

/*
helper gap:
- INT-01 Slack channel, message, upload, and download-file happy paths still
  need public API setup journeys for externally observable Slack channel/file
  state without diagnostic fixture routes.
- INT-02 Telegram linked-bot, message/upload success, internal callback, and
  cleanup flows still need public API setup helpers for bot installation state.
- INT-03 GitHub installed-app and AgentPhone linked-send happy paths need public
  setup APIs for provider installation and downstream agent state before they
  can be covered without diagnostic fixture routes.
*/

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const connectors = createConnectorBddApi(context);
const integrations = createBddIntegrationApi(context);
const misc = createMiscRoutesApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const callbackStore = createStore();
const TELEGRAM_BOT_ID = 99_887_766;
const TELEGRAM_BOT_TOKEN = `${TELEGRAM_BOT_ID}:bdd-token`;
const TELEGRAM_OFFICIAL_WEBHOOK_SECRET = "telegram-official-bdd-secret";

interface SlackEphemeralBody {
  readonly response_type: "ephemeral";
  readonly blocks: readonly unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

async function expectClaimedSlackDisplayContext(
  events: readonly ChatEvent[],
  messagePermalink: string,
): Promise<void> {
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
  if (!claimedMessage?.revokesEventId) {
    throw new Error("Expected the claimed Slack message");
  }
  const claimedContext = await readChatEventContextFixture(claimedMessage.id);
  const pendingContext = await readChatEventContextFixture(
    claimedMessage.revokesEventId,
  );
  expect(claimedContext).toMatchObject({
    contextType: "slack",
    contextId: expect.any(String),
  });
  expect(pendingContext).toMatchObject({
    contextType: "slack",
    contextId: claimedContext?.contextId,
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

interface SlackModalSelectState {
  readonly triggerId: string | null;
  readonly callbackId: string | null;
  readonly privateMetadata: string | null;
  readonly optionValues: readonly string[];
  readonly optionLabels: readonly string[];
  readonly initialOptionValue: string | null;
}

function readStringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function latestSlackModal(): SlackModalSelectState {
  const call: unknown = context.mocks.slack.views.open.mock.calls.at(-1)?.[0];
  if (!isRecord(call)) {
    throw new Error("Expected Slack views.open to be called with a modal");
  }
  const view = isRecord(call.view) ? call.view : {};
  const blocks = Array.isArray(view.blocks) ? view.blocks : [];
  const optionValues: string[] = [];
  const optionLabels: string[] = [];
  let initialOptionValue: string | null = null;
  for (const block of blocks) {
    if (!isRecord(block) || !isRecord(block.element)) {
      continue;
    }
    const element = block.element;
    if (isRecord(element.initial_option)) {
      initialOptionValue =
        readStringField(element.initial_option, "value") ?? initialOptionValue;
    }
    if (!Array.isArray(element.options)) {
      continue;
    }
    for (const option of element.options) {
      if (!isRecord(option)) {
        continue;
      }
      const value = readStringField(option, "value");
      if (value !== null) {
        optionValues.push(value);
      }
      const label = isRecord(option.text)
        ? readStringField(option.text, "text")
        : null;
      if (label !== null) {
        optionLabels.push(label);
      }
    }
  }
  return {
    triggerId: readStringField(call, "trigger_id"),
    callbackId: readStringField(view, "callback_id"),
    privateMetadata: readStringField(view, "private_metadata"),
    optionValues,
    optionLabels,
    initialOptionValue,
  };
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
      model: "gpt-5.6-sol",
      isDefault: true,
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
      modelProviderId: null,
    },
  ]);
  await bdd.readOnboardingStatus(actor);
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    { [FeatureSwitchKey.CodexFastMode]: true },
  );
  await integrations.updateUserModelPreference(
    actor,
    "gpt-5.6-sol",
    "priority",
  );
}

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
  let runId: string | null = null;
  await expect
    .poll(async () => {
      const poll = await runs.pollRunner(runnerGroup);
      runId = poll.body.job?.runId ?? null;
      return runId;
    })
    .toStrictEqual(expect.any(String));
  if (!runId) {
    throw new Error(message);
  }
  return runId;
}

async function pollSlackRun(runnerGroup: string): Promise<string> {
  return await pollRunnerRun(
    runnerGroup,
    "Expected a Slack-triggered run in the runner queue",
  );
}

async function pollQueuedWebAndSlackRuns(args: {
  readonly runnerGroup: string;
  readonly expectedSlackSessionId: string;
  readonly teamId: string;
}): Promise<{
  readonly webRunId: string;
  readonly run2Id?: string;
  readonly claim2?: Awaited<ReturnType<typeof runs.claimRunnerJob>>;
}> {
  const firstQueuedRunId = await pollRunnerRun(
    args.runnerGroup,
    "Expected the queued Web run in the shared thread queue",
  );
  const state = await integrations.readSlackTestState(args.teamId);
  const firstQueuedRunIsSlack = state.recent_runs.some((run) => {
    return run.id === firstQueuedRunId && run.triggerSource === "slack";
  });
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

function piResponsesTextSse(text: string, sequence: number): string {
  const responseId = `resp_connector_pi_${sequence.toString()}`;
  const messageId = `msg_connector_pi_${sequence.toString()}`;
  const message = {
    type: "message",
    id: messageId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [message],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ]
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

function piResponsesToolSse(sequence: number): string {
  const responseId = `resp_connector_pi_${sequence.toString()}`;
  const itemId = `fc_connector_pi_${sequence.toString()}`;
  const functionArguments = JSON.stringify({ command: "okou --help" });
  const item = {
    type: "function_call",
    id: itemId,
    call_id: `call_connector_pi_${sequence.toString()}`,
    name: "bash",
    arguments: functionArguments,
    status: "completed",
  };
  return [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: itemId,
      delta: functionArguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: itemId,
      arguments: functionArguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ]
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

type SlackPiModel = "gpt-5.6-terra" | "gpt-5.6-sol" | "gpt-5.6-luna";

interface SlackPiActorSetup {
  readonly selectedModel: SlackPiModel;
  readonly actor: ReturnType<typeof bdd.user>;
  readonly orgId: string;
  readonly runnerGroup: ReturnType<typeof runs.configureRunnerGroup>;
}

interface PiProviderRequest {
  readonly authorization: string | null;
  readonly body: unknown;
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
      secret: "bdd-slack-terra-api-key",
    },
  );
  await runs.updateOrgModelPolicies(actor, [
    {
      model: "claude-sonnet-5",
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: anthropicProviderId,
    },
    {
      model: selectedModel,
      isDefault: false,
      defaultProviderType: "openai-api-key",
      credentialScope: "org",
      modelProviderId: openaiProviderId,
    },
  ]);
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId },
    { [FeatureSwitchKey.PiLoop]: false },
  );
  await integrations.updateUserModelPreference(actor, "claude-sonnet-5");
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
  const ingressState = await integrations.readSlackTestState(teamId);
  const historicalRun = ingressState.recent_runs.find((run) => {
    return run.promptPreview?.includes("establish non-Pi Slack history");
  });
  if (!historicalRun) {
    throw new Error(
      `Expected historical Slack ingress to create a run: ${JSON.stringify({
        ingress: ingressState.chat_ingress,
        pending: ingressState.pending_chat_events,
        runs: ingressState.recent_runs,
      })}`,
    );
  }
  expect(historicalRun).toMatchObject({
    status: "pending",
    triggerSource: "slack",
  });
  await expect(
    readRunLaunchSnapshotFixture(context, historicalRun.id),
  ).resolves.toMatchObject({ launch_snapshot: { framework: "claude-code" } });
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

  const canonicalState = await integrations.readSlackTestState(teamId);
  const chatThreadId = canonicalState.chat_thread_routes.find((route) => {
    return route.channelId === channelId && route.threadTs === threadTs;
  })?.chatThreadId;
  if (!chatThreadId) {
    throw new Error("Expected Slack Pi ingress to own a canonical thread");
  }
  const historicalBinding = await readThreadSessionBinding(
    context,
    chatThreadId,
  );
  if (!historicalBinding.agent_session_id) {
    throw new Error("Expected the historical Slack session binding");
  }
  await chat.updateThreadModelSelection(
    args.actor,
    chatThreadId,
    args.selectedModel,
  );
  await updateFeatureSwitchesForUser(
    context,
    { ...args.actor, orgId: args.orgId },
    {
      [FeatureSwitchKey.PiLoop]: true,
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
    historicalSessionId: historicalBinding.agent_session_id,
    checkpointObjects,
  };
}

function mockCanonicalSlackPiProvider(): PiProviderRequest[] {
  const providerRequests: PiProviderRequest[] = [];
  server.use(
    http.post("https://api.openai.com/v1/responses", async ({ request }) => {
      const sequence = providerRequests.length;
      providerRequests.push({
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      const answer =
        sequence === 0
          ? "Canonical Slack Pi answer"
          : sequence === 2
            ? "Continued Slack Pi answer"
            : null;
      return new HttpResponse(
        answer === null
          ? piResponsesToolSse(sequence)
          : piResponsesTextSse(answer, sequence),
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  return providerRequests;
}

type CanonicalSlackPiScenario = Awaited<
  ReturnType<typeof establishCanonicalSlackHistory>
>;

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
  // Webhook acknowledgement precedes the tracked Pi turn and its callbacks.
  await flushWaitUntilForTest();
  const state = await integrations.readSlackTestState(scenario.teamId);
  const runId = state.recent_runs.find((run) => {
    return run.promptPreview?.includes(prompt) === true;
  })?.id;
  if (!runId) {
    throw new Error("Expected the first canonical Slack Pi run");
  }
  expect((await runs.readRun(scenario.actor, runId)).status).toBe("completed");
  return { prompt, runId };
}

async function expectFirstSlackPiExecution(args: {
  readonly scenario: CanonicalSlackPiScenario;
  readonly providerRequests: readonly PiProviderRequest[];
  readonly turn: Awaited<ReturnType<typeof runFirstCanonicalSlackPiTurn>>;
}): Promise<string> {
  expect(args.providerRequests).toHaveLength(1);
  expect(args.providerRequests[0]).toMatchObject({
    authorization: "Bearer bdd-slack-terra-api-key",
    body: {
      model: args.scenario.selectedModel,
      store: false,
      stream: true,
      reasoning: { effort: "max" },
    },
  });
  const providerInput = JSON.stringify(args.providerRequests[0]?.body);
  expect(providerInput).toContain("establish non-Pi Slack history");
  expect(providerInput).toContain("Historical Claude answer");
  expect(providerInput).toContain(args.turn.prompt);
  await expect(
    readRunLaunchSnapshotFixture(context, args.turn.runId),
  ).resolves.toMatchObject({ launch_snapshot: { framework: "pi" } });
  const binding = await readThreadSessionBinding(
    context,
    args.scenario.chatThreadId,
  );
  expect(binding.agent_session_id).not.toBe(args.scenario.historicalSessionId);
  if (!binding.agent_session_id) {
    throw new Error("Expected the first Slack Pi session binding");
  }
  return binding.agent_session_id;
}

async function expectSlackPiOwnership(args: {
  readonly scenario: CanonicalSlackPiScenario;
  readonly runId: string;
  readonly assistantText: string;
}): Promise<void> {
  await expect
    .poll(async () => {
      const callbacks = await callbackStore.set(
        readAgentRunCallbacks$,
        {
          orgId: args.scenario.orgId,
          userId: args.scenario.actor.userId,
          runId: args.runId,
        },
        context.signal,
      );
      return callbacks.find((callback) => {
        return callback.internalKind === "slack:chat";
      })?.status;
    })
    .toBe("delivered");
  const callbacks = await callbackStore.set(
    readAgentRunCallbacks$,
    {
      orgId: args.scenario.orgId,
      userId: args.scenario.actor.userId,
      runId: args.runId,
    },
    context.signal,
  );
  expect(
    callbacks.filter((callback) => {
      return callback.internalKind === "slack:chat";
    }),
  ).toStrictEqual([
    expect.objectContaining({ attempts: 1, status: "delivered" }),
  ]);
  expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
  expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: args.scenario.channelId,
      thread_ts: args.scenario.threadTs,
      text: args.assistantText,
    }),
  );
  await expect(readRunUsageEventsFixture(args.runId)).resolves.toStrictEqual(
    [],
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
  readonly providerRequests: readonly PiProviderRequest[];
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
  const binding = await readThreadSessionBinding(
    context,
    args.scenario.chatThreadId,
  );
  expect(binding.agent_session_id).toBe(args.firstSessionId);
  expect(args.providerRequests).toHaveLength(2);
  const providerInput = JSON.stringify(args.providerRequests[1]?.body);
  expect(providerInput).toContain(args.firstPrompt);
  expect(providerInput).toContain("Canonical Slack Pi answer");
  expect(providerInput).toContain(prompt);
  await expect(readRunUsageEventsFixture(runId)).resolves.toStrictEqual([]);
  return { claim, runId };
}

async function cancelContinuedSlackPiTurn(args: {
  readonly scenario: CanonicalSlackPiScenario;
  readonly providerRequests: readonly PiProviderRequest[];
  readonly turn: Awaited<ReturnType<typeof claimContinuedSlackPiTurn>>;
}): Promise<void> {
  await runs.requestCancelRun(args.scenario.actor, args.turn.runId, [200]);
  await expect
    .poll(async () => {
      return (await runs.readRun(args.scenario.actor, args.turn.runId)).status;
    })
    .toBe("cancelled");
  await webhooks.requestAgentComplete(
    { runId: args.turn.runId, exitCode: 1, error: "Run cancelled" },
    { authorization: `Bearer ${args.turn.claim.sandboxToken}` },
    [200],
  );
  await flushWaitUntilForTest();

  expect(args.providerRequests).toHaveLength(2);
  expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
  expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: args.scenario.channelId,
      thread_ts: args.scenario.threadTs,
      text: "Run cancelled",
    }),
  );
  const callbacks = await callbackStore.set(
    readAgentRunCallbacks$,
    {
      orgId: args.scenario.orgId,
      userId: args.scenario.actor.userId,
      runId: args.turn.runId,
    },
    context.signal,
  );
  expect(
    callbacks.filter((callback) => {
      return callback.internalKind === "slack:chat";
    }),
  ).toStrictEqual([
    expect.objectContaining({ attempts: 1, status: "delivered" }),
  ]);
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
  readonly providerRequests: readonly PiProviderRequest[];
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
  const state = await integrations.readSlackTestState(args.scenario.teamId);
  const completedRunId = state.recent_runs.find((run) => {
    return run.promptPreview?.includes(prompt) === true;
  })?.id;
  if (!completedRunId) {
    throw new Error("Expected the continued canonical Slack Pi run");
  }
  expect((await runs.readRun(args.scenario.actor, completedRunId)).status).toBe(
    "completed",
  );

  expect(args.providerRequests).toHaveLength(3);
  const providerInput = JSON.stringify(args.providerRequests[2]?.body);
  expect(providerInput).toContain(args.firstPrompt);
  expect(providerInput).toContain("Canonical Slack Pi answer");
  expect(providerInput).toContain(prompt);
  await expect(
    readRunLaunchSnapshotFixture(context, completedRunId),
  ).resolves.toMatchObject({ launch_snapshot: { framework: "pi" } });
  const binding = await readThreadSessionBinding(
    context,
    args.scenario.chatThreadId,
  );
  expect(binding.agent_session_id).toBe(args.firstSessionId);
  return { prompt, runId: completedRunId };
}

async function expectSlackPiMemoryCandidate(args: {
  readonly scenario: CanonicalSlackPiScenario;
  readonly runId: string;
}) {
  // Stage 1 candidates intentionally have no production read API. Observe the
  // private identity only after real Slack ingress and completion own the run.
  const conversation = await readPiConversationIdentityFixture(args.runId);
  const run = await runs.readRun(args.scenario.actor, args.runId);
  if (!run.completedAt) {
    throw new Error("Expected completed Slack Pi run timestamp");
  }
  // Explicit canonical-writer fixture: completion itself never schedules.
  const beforeAdmission = await readPiMemoryStage1CandidateFixture({
    orgId: args.scenario.orgId,
    userId: args.scenario.actor.userId,
  });
  expect(beforeAdmission?.sourceRunId).not.toBe(args.runId);
  await readmitPiMemoryStage1CandidateFixture(args.runId);
  const candidate = await readPiMemoryStage1CandidateFixture({
    orgId: args.scenario.orgId,
    userId: args.scenario.actor.userId,
  });
  if (!candidate) {
    throw new Error("Expected Slack Pi history to create a memory candidate");
  }
  expect(candidate).toMatchObject({
    orgId: args.scenario.orgId,
    userId: args.scenario.actor.userId,
    memoryStorageName: "memory",
    piSessionId: args.scenario.chatThreadId,
    sourceRunId: args.runId,
    sourceHistoryHash: conversation.sourceHistoryHash,
    sourceCompletedAt: new Date(run.completedAt),
    status: "pending",
    retryCount: 0,
    usageCount: 0,
  });
  expect(conversation.piSessionId).toBe(args.scenario.chatThreadId);
  expect(candidate.memoryStorageS3Prefix).toBe(
    `${args.scenario.orgId}/${candidate.memoryStorageId}`,
  );
  expect(
    candidate.eligibleAt.getTime() - candidate.sourceCompletedAt.getTime(),
  ).toBe(0);
  await expect(
    countPiMemoryStage1CandidatesFixture({
      memoryStorageId: candidate.memoryStorageId,
      piSessionId: candidate.piSessionId,
    }),
  ).resolves.toBe(1);
  return candidate;
}

function telegramDomainProbe() {
  return http.head("https://oauth.telegram.org/auth", () => {
    return new HttpResponse(null, {
      status: 200,
      headers: { "content-length": "2001" },
    });
  });
}

function telegramSendMessage(onBody?: (body: unknown) => void) {
  return http.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    async ({ request }) => {
      onBody?.(await request.json());
      return HttpResponse.json({
        ok: true,
        result: {
          message_id: 321,
          chat: { id: 12_345 },
        },
      });
    },
  );
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
    expect(unauthenticatedConnectStatus.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
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
        message: "Workspace not found. Please install the Slack app first.",
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
    expect(unauthenticatedChannels.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const missingChannels = await integrations.requestListSlackChannels(
      admin,
      [404],
    );
    expect(missingChannels.body).toMatchObject({
      error: { code: "NOT_FOUND" },
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
  it("keeps failed canonical inputs inert across historical reads", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    integrations.configureSlackAppMocks();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
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

    const state = await integrations.readSlackTestState(teamId);
    const chatThreadId = state.chat_thread_routes[0]?.chatThreadId;
    if (!chatThreadId) {
      throw new Error("Expected historical Slack route to own a chat thread");
    }
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
    await runs.ensureOrgModelProvider(actor);
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

  it("deduplicates canonical Slack retries", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    integrations.configureSlackAppMocks();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const slackUserId = uniqueSlackUserId();
    const mentionedSlackUserId = uniqueSlackUserId();
    const { teamId, botUserId } = await integrations.installSlackWorkspace(
      actor,
      {
        installerSlackUserId: slackUserId,
      },
    );
    const channelId = "C_BDD_CANONICAL_INGRESS";
    const threadTs = "2900.000100";
    const eventId = `EvBDD${randomUUID().replace(/-/g, "")}`;
    const fileUrl = "https://files.slack.com/F_CANONICAL_INPUT";
    const fileBody = "canonical Slack attachment";
    context.mocks.slack.fetchFile.mockResolvedValue(
      new Response(fileBody, {
        headers: { "Content-Type": "text/plain" },
      }),
    );
    const event = {
      type: "app_mention",
      user: slackUserId,
      text: `<@${botUserId}> admit this event once with <@${mentionedSlackUserId}>`,
      ts: threadTs,
      channel: channelId,
      channel_type: "channel",
      files: [
        {
          id: "F_CANONICAL_INPUT",
          name: "source-notes.txt",
          mimetype: "text/plain",
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

    const state = await integrations.readSlackTestState(teamId);
    expect(state.chat_thread_routes).toHaveLength(1);
    expect(state.chat_thread_routes[0]).toMatchObject({
      channelId,
      threadTs,
      userId: actor.userId,
      chatThreadId: expect.any(String),
    });
    expect(state.chat_ingress).toHaveLength(1);
    expect(state.chat_ingress[0]).toMatchObject({
      eventId,
      payload: eventBody,
      publicBrand: "okou",
      routeId: state.chat_thread_routes[0]?.id,
      status: "processed",
      retryCount: 3,
    });
    const canonicalChatThreadId = state.chat_thread_routes[0]?.chatThreadId;
    if (!canonicalChatThreadId) {
      throw new Error("Expected canonical Slack route to own a chat thread");
    }
    expect(state.recent_runs).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          triggerSource: "slack",
          userId: actor.userId,
          promptPreview: expect.stringContaining("admit this event once"),
        }),
      ]),
    );
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
    const slackBinding = await readThreadSessionBinding(
      context,
      canonicalChatThreadId,
    );
    expect(slackBinding.agent_session_id).toMatch(/[0-9a-f-]{36}/);
    expect(slackBinding).toMatchObject({
      agent_session_run_id: run1Id,
      run_session_id: slackBinding.agent_session_id,
    });

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
    const canonicalInputMessage = slackInputMessageByText(
      visibleMessages,
      "@Slack User admit this event once with @Slack User",
    );
    if (!canonicalInputMessage) {
      throw new Error("Expected the canonical Slack input message");
    }
    // The Slack context row is the complete launch snapshot: the bot user ID
    // the system prompt renders and the canonical asset the agent prompt
    // renders both live here.
    await expect(
      readChatEventContextFixture(canonicalInputMessage.id),
    ).resolves.toMatchObject({
      slackBotUserId: botUserId,
      slackPublicBrand: "okou",
      slackMessageText: `<@${botUserId}> admit this event once with <@${mentionedSlackUserId}>`,
      slackMessageAssets: [
        {
          assetId: canonicalInputAssetId,
          slackFileId: "F_CANONICAL_INPUT",
          filename: "source-notes.txt",
          contentType: "text/plain",
          status: "ready",
        },
      ],
      slackMentionDisplayNames: {
        [mentionedSlackUserId]: "Slack User",
      },
    });
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
                text: "@Slack User admit this event once with @Slack User",
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
    await expectClaimedSlackDisplayContext(
      visibleMessages,
      "https://vm0.slack.com/archives/C_BDD_CANONICAL_INGRESS/p2900000100",
    );
    const canonicalInputRun = await runs.readRun(actor, run1Id);
    expect(canonicalInputRun.prompt).toBe(
      `@Slack User (${botUserId}) admit this event once with @Slack User (${mentionedSlackUserId})\n\n[Web file] source-notes.txt (text/plain)\n   [ID] ${canonicalInputAssetId}`,
    );
    expect(canonicalInputRun.appendSystemPrompt).toContain(
      `# Current Integration\nYou are currently running inside: Slack\nYour bot user ID: ${botUserId}\nChannel ID: ${channelId}\nChannel type: Channel\nThread ID: ${threadTs}`,
    );
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
    const deliveryCallback = (
      await callbackStore.set(
        readAgentRunCallbacks$,
        {
          orgId: actor.orgId,
          userId: actor.userId,
          runId: run1Id,
        },
        context.signal,
      )
    ).find((callback) => {
      return callback.internalKind === "slack:chat";
    });
    expect(deliveryCallback).toMatchObject({
      payload: {},
    });
  });

  it("keeps queued Web and Slack inputs on one canonical route", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    integrations.configureSlackAppMocks();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
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

    let state = await integrations.readSlackTestState(teamId);
    const canonicalChatThreadId = state.chat_thread_routes[0]?.chatThreadId;
    if (!canonicalChatThreadId) {
      throw new Error("Expected canonical Slack route to own a chat thread");
    }
    const run1Id = await pollSlackRun(runnerGroup);
    await runs.claimRunnerJob(run1Id);
    const defaultAgentId = state.default_agent?.id;
    if (!defaultAgentId) {
      throw new Error("Expected canonical Slack thread to use a default agent");
    }
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

    state = await integrations.readSlackTestState(teamId);
    expect(state.chat_thread_routes).toHaveLength(1);
    expect(state.chat_thread_routes[0]).toMatchObject({
      channelId,
      threadTs,
    });
    expect(state.chat_ingress).toHaveLength(2);
    expect(state.chat_ingress).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventId, status: "processed" }),
        expect.objectContaining({
          eventId: stickyEventId,
          status: "processed",
        }),
      ]),
    );
    expect(
      state.chat_ingress.map((ingress) => {
        return ingress.eventId;
      }),
    ).toStrictEqual(expect.arrayContaining([eventId, stickyEventId]));
    const pendingInputEvents = state.pending_chat_events.filter((pending) => {
      return pending.eventType === "input.prompt";
    });
    expect(pendingInputEvents.length).toBeGreaterThanOrEqual(2);
    const pendingEventsWithContext = await Promise.all(
      pendingInputEvents.map(async (pending) => {
        return {
          pending,
          context: await readChatEventContextFixture(pending.id),
        };
      }),
    );
    const queuedSlackEvents = pendingEventsWithContext.filter((candidate) => {
      return (
        candidate.pending.chatThreadId === canonicalChatThreadId &&
        candidate.context?.contextType === "slack"
      );
    });
    expect(queuedSlackEvents).toHaveLength(1);
    const [queuedSlackEvent] = queuedSlackEvents;
    if (!queuedSlackEvent) {
      throw new Error("Expected the canonical thread's pending Slack event");
    }
    expect(queuedSlackEvent.context).toMatchObject({
      contextType: "slack",
      contextId: expect.any(String),
      slackChannelId: channelId,
      slackMessageTs: "2900.000200",
      slackConversationContext: "",
      slackMessageText: "stay canonical on the same route",
      slackMessageFiles: event.files,
      slackMentionDisplayNames: {},
      slackSenderDisplayName: "Slack User",
      slackSenderUserId: slackUserId,
      slackChannelType: "channel",
      slackThreadTs: threadTs,
      slackRouteThreadTs: null,
    });
    const stickyVisibleMessage = slackInputMessageByText(
      (await chat.listThreadEvents(actor, canonicalChatThreadId)).events,
      "stay canonical on the same route",
    );
    expect(
      stickyVisibleMessage?.userMessage.parts.find((part) => {
        return part.type === "source";
      }),
    ).toStrictEqual({ type: "source", kind: "slack" });
  });

  it("keeps queued Web and Slack sends on one canonical session", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    integrations.configureSlackAppMocks();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
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

    let state = await integrations.readSlackTestState(teamId);
    const canonicalChatThreadId = state.chat_thread_routes[0]?.chatThreadId;
    if (!canonicalChatThreadId) {
      throw new Error("Expected canonical Slack route to own a chat thread");
    }
    const run1Id = await pollSlackRun(runnerGroup);
    const claim1 = await runs.claimRunnerJob(run1Id);
    const defaultAgentId = state.default_agent?.id;
    if (!defaultAgentId) {
      throw new Error("Expected canonical Slack thread to use a default agent");
    }
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
    await expect
      .poll(async () => {
        const callbacks = await callbackStore.set(
          readAgentRunCallbacks$,
          {
            orgId,
            userId: actor.userId,
            runId: run1Id,
          },
          context.signal,
        );
        const delivery = callbacks.find((callback) => {
          return callback.internalKind === "slack:chat";
        });
        return delivery?.status;
      })
      .toBe("delivered");
    const run1Delivery = (
      await callbackStore.set(
        readAgentRunCallbacks$,
        {
          orgId,
          userId: actor.userId,
          runId: run1Id,
        },
        context.signal,
      )
    ).find((callback) => {
      return callback.internalKind === "slack:chat";
    });
    expect(run1Delivery).toMatchObject({
      attempts: 1,
      lastError: null,
      payload: {
        channelId,
        threadTs,
        chatEventId: expect.any(String),
      },
    });
    const run1 = await runs.readRun(actor, run1Id);
    const slackSessionId = run1.result?.agentSessionId;
    if (!slackSessionId) {
      throw new Error(
        "Expected the first canonical Slack run to save a session",
      );
    }

    const queuedRuns = await pollQueuedWebAndSlackRuns({
      runnerGroup,
      expectedSlackSessionId: `bdd-slack-cli-${run1Id}`,
      teamId,
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
    state = await integrations.readSlackTestState(teamId);
    expect(state.recent_runs).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: webRunId,
          triggerSource: "web",
        }),
        expect.objectContaining({
          id: run2Id,
          triggerSource: "slack",
          promptPreview: expect.stringContaining(
            "stay canonical on the same route",
          ),
        }),
      ]),
    );
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

  it.each(["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"] as const)(
    "admits canonical Slack %s turns into one Pi session without duplicate ownership",
    async (selectedModel) => {
      const scenario = await establishCanonicalSlackHistory(
        await configureCanonicalSlackPiActor(selectedModel),
      );
      const providerRequests = mockCanonicalSlackPiProvider();
      const firstTurn = await runFirstCanonicalSlackPiTurn(scenario);
      const firstSessionId = await expectFirstSlackPiExecution({
        scenario,
        providerRequests,
        turn: firstTurn,
      });
      await expectSlackPiOwnership({
        scenario,
        runId: firstTurn.runId,
        assistantText: "Canonical Slack Pi answer",
      });
      const firstCandidate = await expectSlackPiMemoryCandidate({
        scenario,
        runId: firstTurn.runId,
      });
      const continuedTurn = await claimContinuedSlackPiTurn({
        scenario,
        providerRequests,
        firstPrompt: firstTurn.prompt,
        firstSessionId,
      });
      await cancelContinuedSlackPiTurn({
        scenario,
        providerRequests,
        turn: continuedTurn,
      });
      await expect(
        readPiMemoryStage1CandidateFixture({
          orgId: scenario.orgId,
          userId: scenario.actor.userId,
        }),
      ).resolves.toStrictEqual(firstCandidate);

      const successfulContinuation = await runSuccessfulContinuedSlackPiTurn({
        scenario,
        providerRequests,
        firstPrompt: firstTurn.prompt,
        firstSessionId,
      });
      await expectSlackPiOwnership({
        scenario,
        runId: successfulContinuation.runId,
        assistantText: "Continued Slack Pi answer",
      });
      const replacedCandidate = await expectSlackPiMemoryCandidate({
        scenario,
        runId: successfulContinuation.runId,
      });
      expect(replacedCandidate).toMatchObject({
        memoryStorageId: firstCandidate.memoryStorageId,
        piSessionId: firstCandidate.piSessionId,
      });
      expect(replacedCandidate.sourceHistoryHash).not.toBe(
        firstCandidate.sourceHistoryHash,
      );
      await expect(
        readmitPiMemoryStage1CandidateFixture(successfulContinuation.runId),
      ).resolves.toMatchObject({ outcome: "exact_retry" });
      const afterExactRetry = await readPiMemoryStage1CandidateFixture({
        orgId: scenario.orgId,
        userId: scenario.actor.userId,
      });
      expect(afterExactRetry?.updatedAt).toStrictEqual(
        replacedCandidate.updatedAt,
      );
    },
    90_000,
  );

  it.each(["queued session", "overlapping status"] as const)(
    "preserves canonical Slack %s after failed delivery",
    async (scenario) => {
      const actor = bdd.user();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      integrations.configureSlackAppMocks();
      await runs.grantProEntitlement(actor);
      await runs.ensureOrgModelProvider(actor);
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
      const channelId = "C_BDD_CANONICAL_STATUS";
      const threadTs = "2902.000100";
      const event = {
        type: "app_mention",
        user: slackUserId,
        text: "<@" + botUserId + "> establish the canonical status route",
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

      const state = await integrations.readSlackTestState(teamId);
      const canonicalChatThreadId = state.chat_thread_routes[0]?.chatThreadId;
      if (!canonicalChatThreadId) {
        throw new Error(
          "Expected canonical Slack status route to own a thread",
        );
      }
      const run1Id = await pollSlackRun(runnerGroup);
      const claim1 = await runs.claimRunnerJob(run1Id);
      let deliveryRunId = run1Id;
      let deliveryClaim = claim1;
      let slackSessionId: string | undefined;
      if (scenario === "queued session") {
        const queuedEventBody = JSON.stringify({
          type: "event_callback",
          team_id: teamId,
          event_id: `EvBDD${randomUUID().replace(/-/g, "")}`,
          event: {
            ...event,
            text: "fail this canonical Slack delivery",
            ts: "2902.000200",
            thread_ts: threadTs,
          },
        });
        await integrations.requestSlackEvent(
          queuedEventBody,
          integrations.signedSlackIngressHeaders(queuedEventBody),
          [200],
        );
        await flushWaitUntilForTest();
        await completeSlackTriggeredRun({
          runId: run1Id,
          sandboxToken: claim1.sandboxToken,
          cliAgentType: claim1.cliAgentType,
          assistantText: "Canonical Slack seed answer",
        });
        await flushWaitUntilForTest();
        const run1 = await runs.readRun(actor, run1Id);
        slackSessionId = run1.result?.agentSessionId;
        if (!slackSessionId) {
          throw new Error(
            "Expected the canonical Slack seed run to save a session",
          );
        }

        deliveryRunId = await pollSlackRun(runnerGroup);
        deliveryClaim = await runs.claimRunnerJob(deliveryRunId);
        expect(deliveryClaim.resumeSession?.sessionId).toBe(
          `bdd-slack-cli-${run1Id}`,
        );
      }
      context.mocks.slack.chat.postMessage.mockClear();
      context.mocks.slack.chat.postMessage.mockRejectedValueOnce(
        new DOMException("Slack delivery aborted", "AbortError"),
      );
      const terminalStatusClearStarted = createDeferredPromise<void>(
        context.signal,
      );
      const releaseTerminalStatusClear = createDeferredPromise<void>(
        context.signal,
      );
      const overlappingThinkingStatusSet = createDeferredPromise<void>(
        context.signal,
      );
      if (scenario === "overlapping status") {
        context.mocks.slack.assistant.threads.setStatus
          .mockImplementationOnce(async () => {
            terminalStatusClearStarted.resolve(undefined);
            await releaseTerminalStatusClear.promise;
            return { ok: true };
          })
          .mockImplementationOnce(() => {
            overlappingThinkingStatusSet.resolve(undefined);
            return Promise.resolve({ ok: true });
          });
      }
      await completeSlackTriggeredRun({
        runId: deliveryRunId,
        sandboxToken: deliveryClaim.sandboxToken,
        cliAgentType: deliveryClaim.cliAgentType,
        assistantText: "Canonical Slack answer two",
      });
      if (scenario === "overlapping status") {
        await terminalStatusClearStarted.promise;
      } else {
        await flushWaitUntilForTest();
      }
      await expect
        .poll(async () => {
          const callbacks = await callbackStore.set(
            readAgentRunCallbacks$,
            {
              orgId,
              userId: actor.userId,
              runId: deliveryRunId,
            },
            context.signal,
          );
          const delivery = callbacks.find((callback) => {
            return callback.internalKind === "slack:chat";
          });
          return delivery?.status;
        })
        .toBe("failed");
      const failedDelivery = (
        await callbackStore.set(
          readAgentRunCallbacks$,
          {
            orgId,
            userId: actor.userId,
            runId: deliveryRunId,
          },
          context.signal,
        )
      ).find((callback) => {
        return callback.internalKind === "slack:chat";
      });
      expect(failedDelivery).toMatchObject({
        attempts: 1,
        lastError: "Slack delivery aborted",
      });
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
      if (scenario === "overlapping status") {
        const cancelledEventId = `EvBDD${randomUUID().replace(/-/g, "")}`;
        const cancelledBody = JSON.stringify({
          type: "event_callback",
          team_id: teamId,
          event_id: cancelledEventId,
          event: {
            ...event,
            text: "cancel this canonical Slack run",
            ts: "2900.000300",
            thread_ts: threadTs,
          },
        });
        await integrations.requestSlackEvent(
          cancelledBody,
          integrations.signedSlackIngressHeaders(cancelledBody),
          [200],
        );
        await overlappingThinkingStatusSet.promise;
        expect(
          context.mocks.slack.assistant.threads.setStatus.mock.calls.map(
            ([input]) => {
              if (!isRecord(input)) {
                throw new Error("Expected Slack thread status request");
              }
              return readStringField(input, "status");
            },
          ),
        ).toStrictEqual(["is thinking...", "", "is thinking..."]);
        releaseTerminalStatusClear.resolve(undefined);
        await flushWaitUntilForTest();
        expect(
          context.mocks.slack.assistant.threads.setStatus,
        ).toHaveBeenCalledTimes(4);
        expect(
          context.mocks.slack.assistant.threads.setStatus,
        ).toHaveBeenLastCalledWith({
          channel_id: channelId,
          thread_ts: threadTs,
          status: "is thinking...",
        });
        const cancelledRunId = await pollSlackRun(runnerGroup);
        await runs.requestCancelRun(actor, cancelledRunId, [200]);
        await expect
          .poll(async () => {
            return (await runs.readRun(actor, cancelledRunId)).status;
          })
          .toBe("cancelled");
        await flushWaitUntilForTest();
        expect(
          context.mocks.slack.assistant.threads.setStatus,
        ).toHaveBeenCalledTimes(5);
        expect(
          context.mocks.slack.assistant.threads.setStatus,
        ).toHaveBeenLastCalledWith({
          channel_id: channelId,
          thread_ts: threadTs,
          status: "",
        });
      }

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
      if (scenario === "queued session") {
        const deliveredRun = await runs.readRun(actor, deliveryRunId);
        expect(deliveredRun.result?.agentSessionId).toBe(slackSessionId);
      }
    },
  );

  it("keeps Slack DM sessions scoped to the selected agent", async () => {
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

    const alternateAgent = await bdd.createAgent(actor, {
      displayName: "BDD alternate Slack DM agent",
    });
    await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: alternateAgent.agentId,
        channelId,
      }),
    );
    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "use an alternate Slack DM agent",
      ts: "2950.000200",
      channel: channelId,
    });
    const alternateRunId = await pollSlackRun(runnerGroup);
    const alternateClaim = await runs.claimRunnerJob(alternateRunId);
    expect(alternateClaim.resumeSession).toBeNull();
    await completeSlackTriggeredRun({
      runId: alternateRunId,
      sandboxToken: alternateClaim.sandboxToken,
      cliAgentType: alternateClaim.cliAgentType,
    });
    await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: "__org_default__",
        channelId,
      }),
    );

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
    await runs.ensureOrgModelProvider(actor);
    await runs.grantProEntitlement(blockerActor);
    await runs.ensureOrgModelProvider(blockerActor);
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
    await runs.ensureOrgModelProvider(actor);
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

  it("titles canonical Slack threads when their run is created", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    integrations.configureSlackAppMocks();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);

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

    const state = await integrations.readSlackTestState(teamId);
    const chatThreadId = state.chat_thread_routes.find((route) => {
      return route.channelId === channelId && route.threadTs === threadTs;
    })?.chatThreadId;
    if (!chatThreadId) {
      throw new Error("Expected the Slack event to create a canonical thread");
    }
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
    const slackState = await integrations.readSlackTestState(teamId);
    expect(slackState.recent_runs).toContainEqual(
      expect.objectContaining({ id: run1Id, triggerSource: "slack" }),
    );

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

  it("pins agent choices to canonical Slack threads", async () => {
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
    const agentB = await bdd.createAgent(actor, {
      displayName: "BDD Slack Switch Agent",
    });
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    integrations.clearSlackCallHistory();

    const channelId = "C_BDD_AGENT_BINDING";
    const threadTs = "3050.000100";
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "establish the original thread agent",
      ts: threadTs,
      channel: channelId,
    });
    const seedRunId = await pollSlackRun(runnerGroup);
    const seedClaim = await runs.claimRunnerJob(seedRunId);
    await completeSlackTriggeredRun({
      runId: seedRunId,
      sandboxToken: seedClaim.sandboxToken,
      cliAgentType: seedClaim.cliAgentType,
    });
    const seedRun = await runs.readRun(actor, seedRunId);
    const seedSessionId = seedRun.result?.agentSessionId;
    if (!seedSessionId) {
      throw new Error("Expected the original Slack run to expose its session");
    }

    const switched = await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: agentB.agentId,
        channelId,
      }),
    );
    expect(switched).toBe("");
    expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: channelId,
        user: slackUserId,
        text: "Switched to *BDD Slack Switch Agent* for new Slack threads.",
      }),
    );
    context.mocks.slack.chat.postMessage.mockClear();
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "keep the existing thread agent",
      ts: "3050.000200",
      thread_ts: threadTs,
      channel: channelId,
    });
    const continuationRunId = await pollSlackRun(runnerGroup);
    const continuationClaim = await runs.claimRunnerJob(continuationRunId);
    expect(continuationClaim.resumeSession?.sessionId).toBe(
      `bdd-slack-cli-${seedRunId}`,
    );
    await completeSlackTriggeredRun({
      runId: continuationRunId,
      sandboxToken: continuationClaim.sandboxToken,
      cliAgentType: continuationClaim.cliAgentType,
    });
    const continuationRun = await runs.readRun(actor, continuationRunId);
    expect(continuationRun.result?.agentSessionId).toBe(seedSessionId);

    const overrideThreadTs = "3051.000100";
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "use my override in a new thread",
      ts: overrideThreadTs,
      channel: channelId,
    });
    const overrideRunId = await pollSlackRun(runnerGroup);
    const overrideClaim = await runs.claimRunnerJob(overrideRunId);
    expect(overrideClaim.resumeSession).toBeNull();
    const overrideState = await integrations.readSlackTestState(teamId);
    const overrideChatThreadId = overrideState.chat_thread_routes.find(
      (route) => {
        return (
          route.channelId === channelId && route.threadTs === overrideThreadTs
        );
      },
    )?.chatThreadId;
    if (!overrideChatThreadId) {
      throw new Error("Expected the override to create a canonical thread");
    }
    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    expect(threadEvents.status).toBe(200);
    if (threadEvents.status !== 200) {
      throw new Error("Expected canonical Slack thread events to load");
    }
    expect(threadEvents.body.events).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "created",
          chatThreadId: overrideChatThreadId,
          agentId: agentB.agentId,
        }),
      ]),
    );
    await completeSlackTriggeredRun({
      runId: overrideRunId,
      sandboxToken: overrideClaim.sandboxToken,
      cliAgentType: overrideClaim.cliAgentType,
    });
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
    await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: "__org_default__",
        channelId,
      }),
    );
    await integrations.updateUserModelPreference(actor, "gpt-5.6-sol");
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
      OPENAI_MODEL: "gpt-5.6-sol",
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

    await integrations.updateUserModelPreference(actor, "claude-sonnet-5");
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
      OPENAI_MODEL: "gpt-5.6-sol",
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

  it("resolves a NULL Slack thread from canonical defaults without replaying its first run", async () => {
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
      ANTHROPIC_MODEL: "claude-sonnet-5",
    });
    await completeSlackTriggeredRun({
      runId: firstRunId,
      sandboxToken: firstClaim.sandboxToken,
      cliAgentType: firstClaim.cliAgentType,
    });
    await flushWaitUntilForTest();

    const slackState = await integrations.readSlackTestState(teamId);
    const chatThreadId = slackState.chat_thread_routes.find((route) => {
      return route.channelId === channelId && route.threadTs === threadTs;
    })?.chatThreadId;
    if (!chatThreadId) {
      throw new Error("Expected Slack ingress to create a canonical thread");
    }
    const historicalMessages = await chat.listThreadEvents(actor, chatThreadId);
    expect(historicalMessages.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.prompt",
        runId: firstRunId,
      }),
    );

    await chat.updateThreadModelSelection(actor, chatThreadId, null);
    await integrations.updateUserModelPreference(actor, "gpt-5.6-sol");
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
    const resolvedRunId = await pollSlackRun(runnerGroup);
    const resolvedClaim = await runs.claimRunnerJob(resolvedRunId);
    expect(resolvedClaim.cliAgentType).toBe("codex");
    expect(resolvedClaim.environment).toMatchObject({
      OPENAI_API_KEY: expect.stringMatching(/.+/),
      OPENAI_MODEL: "gpt-5.6-sol",
    });
    expect(resolvedClaim.environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(
      (await chat.readThreadMetadata(actor, chatThreadId)).selectedModel,
    ).toBe("gpt-5.6-sol");

    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    if (threadEvents.status !== 200) {
      throw new Error("Expected canonical Slack thread events to load");
    }
    expect(threadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        chatThreadId,
        selectedModel: "gpt-5.6-sol",
      }),
    );

    await completeSlackTriggeredRun({
      runId: resolvedRunId,
      sandboxToken: resolvedClaim.sandboxToken,
      cliAgentType: resolvedClaim.cliAgentType,
    });
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

    // Beyond the legacy baseline: a connected Slack user with zero visible
    // agents gets the no-agents ephemeral from /okou switch, and the App
    // Home switch action returns silently without opening a modal.
    const emptySwitch = await integrations.postSlackCommand({
      teamId: bareInstall.teamId,
      userId: bareSlackUserId,
      channelId: "C_BDD_NOAGENT",
      text: "switch",
      triggerId: "trigger-bdd-noagent-switch",
    });
    expect(JSON.stringify(emptySwitch)).toContain(
      "No agents are available to your Slack account.",
    );
    const silentHomeSwitch = await integrations.postSlackInteractive({
      type: "block_actions",
      user: {
        id: bareSlackUserId,
        username: "bdduser",
        team_id: bareInstall.teamId,
      },
      team: { id: bareInstall.teamId, domain: "bdd" },
      trigger_id: "trigger-bdd-noagent-home",
      actions: [{ action_id: "home_switch_agent", block_id: "home" }],
    });
    expect(silentHomeSwitch).toBe("");
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
    const agentB = await bdd.createAgent(actor, {
      displayName: "BDD Slack Picker Agent",
    });
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const ownPrivate = await bdd.createAgent(actor, {
      displayName: "BDD Slack Own Private",
      visibility: "private",
    });
    const memberPublic = await bdd.createAgent(member, {
      displayName: "BDD Slack Member Public",
    });
    const memberPrivate = await bdd.createAgent(member, {
      displayName: "BDD Slack Member Private",
      visibility: "private",
    });
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
      expect(helpJson).toContain("/okou switch");
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

    const switchResponse = await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_CMD",
      text: "switch",
      triggerId: "trigger-bdd-switch",
    });
    expect(switchResponse).toBe("");
    const switchModal = latestSlackModal();
    expect(switchModal.triggerId).toBe("trigger-bdd-switch");
    expect(switchModal.callbackId).toBe("switch_agent_modal");
    expect(switchModal.privateMetadata).toBe(
      JSON.stringify({ channelId: "C_BDD_CMD" }),
    );
    expect(switchModal.optionValues).toContain("__org_default__");
    expect(switchModal.optionValues).toContain(agentB.agentId);
    expect(switchModal.optionValues).toContain(ownPrivate.agentId);
    expect(switchModal.optionValues).toContain(memberPublic.agentId);
    expect(switchModal.optionValues).not.toContain(defaultAgentId);
    expect(switchModal.optionValues).not.toContain(memberPrivate.agentId);
    expect(switchModal.optionLabels).toContainEqual(
      expect.stringContaining("Use org default"),
    );

    await integrations.updateUserModelPreference(actor, "gpt-5.6-luna");
    const modelResponse = await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_CMD",
      text: "model",
      triggerId: "trigger-bdd-model",
    });
    expect(modelResponse).toBe("");
    const modelModal = latestSlackModal();
    expect(modelModal.triggerId).toBe("trigger-bdd-model");
    expect(modelModal.callbackId).toBe("model_preference_modal");
    expect(modelModal.privateMetadata).toBe(
      JSON.stringify({ channelId: "C_BDD_CMD" }),
    );
    expect(modelModal.optionLabels).toContainEqual(
      expect.stringContaining("(workspace default)"),
    );
    expect(modelModal.initialOptionValue).toBe("gpt-5.6-luna");

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

  it("persists Slack agent and model picker selections through interactive submissions", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();

    const missingSelection = await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: "T_BDD_NONE",
        slackUserId: "U_BDD_NONE",
        selectedValue: "",
      }),
    );
    expect(missingSelection).toStrictEqual({
      response_action: "errors",
      errors: { agent_select_block: "Please choose an agent." },
    });

    await bdd.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "BDD Slack Picker Default",
    });
    const status = await bdd.readOnboardingStatus(actor);
    if (!status.defaultAgentId) {
      throw new Error("Expected onboarding to configure a default agent");
    }
    const defaultAgent = await bdd.readAgent(actor, status.defaultAgentId);
    if (!defaultAgent.displayName) {
      throw new Error("Expected onboarding default agent display name");
    }
    const agentB = await bdd.createAgent(actor, {
      displayName: "BDD Slack Picker Override",
    });
    const outsider = bdd.user();
    const outsiderAgent = await bdd.createAgent(outsider, {
      displayName: "BDD Slack Foreign Agent",
    });
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const ownPrivate = await bdd.createAgent(actor, {
      displayName: "BDD Slack Picker Own Private",
      visibility: "private",
    });
    const memberPublic = await bdd.createAgent(member, {
      displayName: "BDD Slack Picker Member Public",
    });
    const memberPrivate = await bdd.createAgent(member, {
      displayName: "BDD Slack Picker Member Private",
      visibility: "private",
    });
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    integrations.clearSlackCallHistory();

    const selectB = await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: agentB.agentId,
        channelId: "C_BDD_PICK",
      }),
    );
    expect(selectB).toBe("");
    expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_BDD_PICK",
        user: slackUserId,
        text: "Switched to *BDD Slack Picker Override* for new Slack threads.",
      }),
    );
    await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_PICK",
      text: "switch",
    });
    expect(latestSlackModal().initialOptionValue).toBe(agentB.agentId);

    const foreign = await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: outsiderAgent.agentId,
      }),
    );
    expect(foreign).toStrictEqual({
      response_action: "errors",
      errors: { agent_select_block: "You don't have access to that agent." },
    });

    const sameOrgPrivate = await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: memberPrivate.agentId,
      }),
    );
    expect(sameOrgPrivate).toStrictEqual({
      response_action: "errors",
      errors: { agent_select_block: "You don't have access to that agent." },
    });

    context.mocks.slack.chat.postEphemeral.mockRejectedValueOnce(
      new Error("ephemeral delivery failed"),
    );
    const confirmFailure = await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: agentB.agentId,
        channelId: "C_BDD_PICK",
      }),
    );
    expect(confirmFailure).toBe("");
    await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_PICK",
      text: "switch",
    });
    expect(latestSlackModal().initialOptionValue).toBe(agentB.agentId);

    const restoreDefault = await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: "__org_default__",
        channelId: "C_BDD_PICK",
      }),
    );
    expect(restoreDefault).toBe("");
    expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_BDD_PICK",
        user: slackUserId,
        text: `Switched to *${defaultAgent.displayName}* for new Slack threads.`,
      }),
    );

    const selectModel = await integrations.postSlackInteractive(
      integrations.modelPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: "deepseek-v4.1-flash",
        channelId: "C_BDD_PICK",
      }),
    );
    expect(selectModel).toBe("");
    expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_BDD_PICK",
        user: slackUserId,
        text: "Switched to *DeepSeek V4.1 Flash* for new Slack threads.",
      }),
    );
    await expect(
      integrations.readUserModelPreference(actor),
    ).resolves.toMatchObject({
      selectedModel: "deepseek-v4.1-flash",
    });

    const replaceModel = await integrations.postSlackInteractive(
      integrations.modelPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: "gpt-5.6-luna",
        channelId: "C_BDD_PICK",
      }),
    );
    expect(replaceModel).toBe("");
    await expect(
      integrations.readUserModelPreference(actor),
    ).resolves.toMatchObject({
      selectedModel: "gpt-5.6-luna",
    });

    const rejectedModel = await integrations.postSlackInteractive(
      integrations.modelPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: "model-outside-policy",
        channelId: "C_BDD_PICK",
      }),
    );
    expect(rejectedModel).toStrictEqual({
      response_action: "errors",
      errors: { model_select_block: "You don't have access to that model." },
    });
    await expect(
      integrations.readUserModelPreference(actor),
    ).resolves.toMatchObject({
      selectedModel: "gpt-5.6-luna",
    });

    context.mocks.slack.views.open.mockClear();
    const homeSwitch = await integrations.postSlackInteractive({
      type: "block_actions",
      user: { id: slackUserId, username: "bdduser", team_id: teamId },
      team: { id: teamId, domain: "bdd" },
      trigger_id: "trigger-bdd-home",
      actions: [{ action_id: "home_switch_agent", block_id: "home" }],
    });
    expect(homeSwitch).toBe("");
    const homeModal = latestSlackModal();
    expect(homeModal.callbackId).toBe("switch_agent_modal");
    expect(homeModal.privateMetadata).toBeNull();
    expect(homeModal.optionValues).toContain("__org_default__");
    expect(homeModal.optionValues).toContain(agentB.agentId);
    expect(homeModal.optionValues).toContain(ownPrivate.agentId);
    expect(homeModal.optionValues).toContain(memberPublic.agentId);
    expect(homeModal.optionValues).not.toContain(status.defaultAgentId);
    expect(homeModal.optionValues).not.toContain(memberPrivate.agentId);
  });

  it("hides an inaccessible private org default across pickers, App Home, and runs", async () => {
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();
    const actor = bdd.user();
    const formerAdmin = bdd.user({ orgId: actor.orgId });
    // Reproduce legacy data written before default-agent visibility was locked.
    // The former admin is now a member; other members must not gain private access.
    const hiddenDefaultId = await bdd.bootstrapLimitedFreeOnboarding(
      formerAdmin,
      {
        displayName: "BDD Hidden Default",
      },
    );
    const member = bdd.user({
      userId: formerAdmin.userId,
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    await seedLegacyPrivateDefaultAgentFixture(hiddenDefaultId);
    const visiblePublic = await bdd.createAgent(member, {
      displayName: "BDD Visible Public",
    });
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    await flushWaitUntilForTest();
    integrations.clearSlackCallHistory();

    const switchResponse = await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_HIDDEN",
      text: "switch",
      triggerId: "trigger-bdd-hidden-switch",
    });
    expect(switchResponse).toBe("");
    const commandModal = latestSlackModal();
    expect(commandModal.optionValues).not.toContain("__org_default__");
    expect(commandModal.optionValues).toContain(visiblePublic.agentId);
    expect(commandModal.optionValues).not.toContain(hiddenDefaultId);
    expect(commandModal.optionLabels).not.toContainEqual(
      expect.stringContaining("Use org default"),
    );

    const orgDefaultRejected = await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: "__org_default__",
      }),
    );
    expect(orgDefaultRejected).toStrictEqual({
      response_action: "errors",
      errors: { agent_select_block: "You don't have access to that agent." },
    });

    context.mocks.slack.views.open.mockClear();
    const homeSwitch = await integrations.postSlackInteractive({
      type: "block_actions",
      user: { id: slackUserId, username: "bdduser", team_id: teamId },
      team: { id: teamId, domain: "bdd" },
      trigger_id: "trigger-bdd-hidden-home",
      actions: [{ action_id: "home_switch_agent", block_id: "home" }],
    });
    expect(homeSwitch).toBe("");
    const homeModal = latestSlackModal();
    expect(homeModal.optionValues).not.toContain("__org_default__");
    expect(homeModal.optionValues).toContain(visiblePublic.agentId);
    expect(homeModal.optionValues).not.toContain(hiddenDefaultId);

    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "hello in dm",
      ts: "2200.000100",
      channel: "D_BDD_HIDDEN",
    });
    await flushWaitUntilAndAssert(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "D_BDD_HIDDEN",
          text: expect.stringContaining("not available to your Slack account"),
        }),
      );
    });
    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).not.toHaveBeenCalled();

    await integrations.postSlackEvent(teamId, {
      type: "app_home_opened",
      user: slackUserId,
      tab: "home",
      channel: "D_BDD_HIDDEN_HOME",
    });
    await flushWaitUntilForTest();
    const homeViewJson = JSON.stringify(
      context.mocks.slack.views.publish.mock.calls.at(-1),
    );
    expect(homeViewJson).toContain("home_switch_agent");
    expect(homeViewJson).toContain("_No agent configured yet._");
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
    await expect
      .poll(async () => {
        const status = await integrations.requestSlackIntegrationStatus(
          actor,
          [200],
        );
        return "isInstalled" in status.body ? status.body.isInstalled : null;
      })
      .toBe(false);
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
    await expect
      .poll(async () => {
        const state = await integrations.readSlackTestState(unbound.teamId);
        return state.installation;
      })
      .toBeNull();
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
    await expect
      .poll(async () => {
        const state = await integrations.readSlackTestState(revoked.teamId);
        return state.installation;
      })
      .toBeNull();
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
      tier: "pro-suspend",
      credits: 0,
    });
    const agentB = await bdd.createAgent(actor, {
      displayName: "BDD Slack Failing Override",
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

    await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: agentB.agentId,
        channelId: "D_BDD_FAIL",
      }),
    );
    context.mocks.slack.chat.postMessage.mockClear();
    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "run with my override",
      ts: "5000.000200",
      channel: "D_BDD_FAIL",
    });
    await flushWaitUntilAndAssert(() => {
      expect(slackPostMessageCallsJson()).toContain(
        "Sent via BDD Slack Failing Override",
      );
    });
  });

  it("keeps the Slack Fast footer bound to the originating run", async () => {
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected the Slack fast-mode actor to have an org");
    }
    const actorWithOrg = { ...actor, orgId: actor.orgId };
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
        model: "gpt-5.6-sol",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);
    await bdd.readOnboardingStatus(actor);
    await updateFeatureSwitchesForUser(context, actorWithOrg, {
      [FeatureSwitchKey.CodexFastMode]: true,
    });
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
    expect(standardFooter).toContain("GPT 5.6 Sol");
    expect(standardFooter).not.toContain("GPT 5.6 Sol Fast");

    const state = await integrations.readSlackTestState(teamId);
    const threadId = state.chat_thread_routes[0]?.chatThreadId;
    if (!threadId) {
      throw new Error("Expected the Slack fast-mode route to own a thread");
    }
    await chat.updateThreadModelSelection(actor, threadId, "gpt-5.6-sol", {
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
    expect(slackPostMessageCallsJson()).toContain("GPT 5.6 Sol Fast");

    await chat.updateThreadModelSelection(actor, threadId, "gpt-5.6-sol", {
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
      expect(slackPostMessageCallsJson()).toContain("GPT 5.6 Sol Fast");
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
    await integrations.enableAuditLinkSwitch(actor);
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
              elements: [{ type: "mrkdwn", text: "Claude Sonnet 5" }],
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
    const slackUser2 = uniqueSlackUserId();
    await integrations.connectSlackUser(actor2, {
      workspaceId: teamId,
      slackUserId: slackUser2,
    });
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
      ANTHROPIC_MODEL: "claude-sonnet-5",
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

  it("registers and manages a Telegram bot through API-visible state", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const telegramProviderBodies: unknown[] = [];
    server.use(
      telegramDomainProbe(),
      telegramSendMessage((body) => {
        telegramProviderBodies.push(body);
      }),
    );
    bdd.acceptAgentStorageWrites();

    const actor = integrations.user();
    const member = integrations.user({
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Telegram agent",
    });
    const botId = String(TELEGRAM_BOT_ID);

    const unauthenticatedList =
      await integrations.requestListTelegramIntegrations(null, [401]);
    expect(unauthenticatedList.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const initialList = await integrations.requestListTelegramIntegrations(
      actor,
      [200],
    );
    if (!("bots" in initialList.body)) {
      throw new Error("Expected Telegram integration list response");
    }
    expect(initialList.body.bots).toContainEqual(
      expect.objectContaining({
        id: OFFICIAL_TELEGRAM_BOT_ID,
        kind: "official",
        isConnected: false,
      }),
    );

    expect(initialList.body.bots).toContainEqual(
      expect.objectContaining({
        id: OFFICIAL_TELEGRAM_BOT_ID,
        kind: "official",
        tokenStatus: "unknown",
        official: expect.objectContaining({ configured: false }),
      }),
    );

    const officialUpdateWithoutAgent =
      await integrations.requestUpdateTelegramBot(
        actor,
        OFFICIAL_TELEGRAM_BOT_ID,
        {},
        [400],
      );
    expect(officialUpdateWithoutAgent.body).toStrictEqual({
      error: {
        message: "selectedAgentId is required",
        code: "BAD_REQUEST",
      },
    });

    const officialDisconnect = await integrations.requestDisconnectTelegramBot(
      actor,
      OFFICIAL_TELEGRAM_BOT_ID,
      [403],
    );
    expect(officialDisconnect.body).toMatchObject({
      error: { code: "FORBIDDEN" },
    });

    const officialLink = await integrations.requestLinkTelegram(
      actor,
      { telegramBotId: OFFICIAL_TELEGRAM_BOT_ID },
      [404],
    );
    expect(officialLink.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const authCallback = await integrations.requestTelegramAuthCallback([200]);
    expect(authCallback.body).toContain("telegram-auth");

    context.mocks.telegram.getMe.mockRejectedValueOnce(new Error("invalid"));
    const invalidSetup = await integrations.requestTelegramSetupStatus(
      actor,
      { botToken: "bad-token" },
      [400],
    );
    expect(invalidSetup.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    context.mocks.telegram.getMe.mockResolvedValue({
      id: TELEGRAM_BOT_ID,
      username: "bdd_telegram_bot",
      can_read_all_group_messages: true,
    });
    let registeredTelegramWebhookSecret: string | undefined;
    context.mocks.telegram.setWebhook.mockImplementation(
      (...args: readonly unknown[]) => {
        const webhookSecret = args[2];
        if (typeof webhookSecret === "string") {
          registeredTelegramWebhookSecret = webhookSecret;
        }
        return Promise.resolve();
      },
    );

    const unauthenticatedRegister =
      await integrations.requestRegisterTelegramBot(
        null,
        {
          botToken: TELEGRAM_BOT_TOKEN,
          defaultAgentId: agent.agentId,
        },
        [401],
      );
    expect(unauthenticatedRegister.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const setup = await integrations.requestTelegramSetupStatus(
      actor,
      {
        botToken: TELEGRAM_BOT_TOKEN,
        origin: "https://app.example.test/setup",
      },
      [200],
    );
    expect(setup.body).toStrictEqual({
      id: botId,
      username: "bdd_telegram_bot",
      domainConfigured: true,
      privacyDisabled: true,
    });

    const registered = await integrations.requestRegisterTelegramBot(
      actor,
      {
        botToken: TELEGRAM_BOT_TOKEN,
        defaultAgentId: agent.agentId,
      },
      [201],
    );
    expect(registered.body).toMatchObject({
      id: botId,
      username: "bdd_telegram_bot",
      isOwner: true,
      isConnected: false,
      tokenStatus: "valid",
      domainConfigured: true,
      agent: { id: agent.agentId },
    });
    if (!registeredTelegramWebhookSecret) {
      throw new Error("Expected Telegram registration to configure webhook");
    }

    const customWebhookUnauthorized = await integrations.requestTelegramWebhook(
      botId,
      "{}",
      { "x-telegram-bot-api-secret-token": "bad-custom-secret" },
      [401],
    );
    expect(customWebhookUnauthorized.body).toBe("Unauthorized");

    const customWebhookNoMessage = await integrations.requestTelegramWebhook(
      botId,
      JSON.stringify({ update_id: 2001 }),
      {
        "x-telegram-bot-api-secret-token": registeredTelegramWebhookSecret,
      },
      [200],
    );
    expect(customWebhookNoMessage.body).toBe("OK");

    const customWebhookNoContentMessage =
      await integrations.requestTelegramWebhook(
        botId,
        JSON.stringify({
          update_id: 2002,
          message: {
            message_id: 77,
            chat: { id: 12_345, type: "private" },
            from: { id: 54_321, first_name: "BDD" },
          },
        }),
        {
          "x-telegram-bot-api-secret-token": registeredTelegramWebhookSecret,
        },
        [200],
      );
    expect(customWebhookNoContentMessage.body).toBe("OK");

    const customConnectPrompt = await integrations.requestTelegramWebhook(
      botId,
      JSON.stringify({
        update_id: 2003,
        message: {
          message_id: 78,
          chat: { id: 12_345, type: "private" },
          from: { id: 54_321, first_name: "BDD" },
          text: "hello",
        },
      }),
      {
        "x-telegram-bot-api-secret-token": registeredTelegramWebhookSecret,
      },
      [200],
    );
    expect(customConnectPrompt.body).toBe("OK");
    await flushWaitUntilForTest();
    expect(JSON.stringify(telegramProviderBodies)).toContain(
      "https://app.okou.ai/telegram/connect?",
    );

    const listed = await integrations.requestListTelegramIntegrations(
      actor,
      [200],
    );
    if (!("bots" in listed.body)) {
      throw new Error("Expected Telegram integration list response");
    }
    expect(listed.body.bots).toContainEqual(
      expect.objectContaining({
        id: botId,
        username: "bdd_telegram_bot",
        isOwner: true,
      }),
    );

    const okouTokenList = await integrations.requestListTelegramBots(
      actor,
      [200],
    );
    if (!("bots" in okouTokenList.body)) {
      throw new Error("Expected Telegram bot list response");
    }
    expect(okouTokenList.body.bots).toContainEqual(
      expect.objectContaining({
        id: botId,
        username: "bdd_telegram_bot",
      }),
    );

    const customLinkStatus = await integrations.readTelegramLinkStatus(
      actor,
      botId,
    );
    expect(customLinkStatus).toMatchObject({
      linked: false,
      installation: {
        id: botId,
        botUsername: "bdd_telegram_bot",
        loginBotId: botId,
        domainConfigured: true,
      },
    });

    const missingLinkAuth = await integrations.requestLinkTelegram(
      actor,
      { telegramBotId: botId },
      [400],
    );
    expect(missingLinkAuth.body).toStrictEqual({
      error: {
        message: "Either telegramAuth or connectSignature is required",
        code: "BAD_REQUEST",
      },
    });

    const invalidConnectSignature = await integrations.requestLinkTelegram(
      actor,
      {
        telegramBotId: botId,
        connectSignature: {
          telegramUserId: "12345",
          telegramUsername: "bdd_telegram_user",
          timestamp: Math.floor(now() / 1000),
          signature: "bad-signature",
        },
      },
      [400],
    );
    expect(invalidConnectSignature.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    const invalidTelegramAuth = await integrations.requestLinkTelegram(
      actor,
      {
        telegramBotId: botId,
        telegramAuth: {
          id: 12_345,
          first_name: "BDD",
          username: "bdd_telegram_user",
          auth_date: Math.floor(now() / 1000),
          hash: "bad-hash",
        },
      },
      [400],
    );
    expect(invalidTelegramAuth.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    const missingUnlink = await integrations.requestUnlinkTelegram(
      actor,
      botId,
      [404],
    );
    expect(missingUnlink.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const missingDefaultAgent = await integrations.requestUpdateTelegramBot(
      actor,
      botId,
      {},
      [400],
    );
    expect(missingDefaultAgent.body).toStrictEqual({
      error: {
        message: "defaultAgentId is required",
        code: "BAD_REQUEST",
      },
    });

    const memberUpdate = await integrations.requestUpdateTelegramBot(
      member,
      botId,
      { defaultAgentId: agent.agentId },
      [403],
    );
    expect(memberUpdate.body).toMatchObject({
      error: { code: "FORBIDDEN" },
    });

    const updated = await integrations.requestUpdateTelegramBot(
      actor,
      botId,
      { defaultAgentId: agent.agentId },
      [200],
    );
    expect(updated.body).toMatchObject({
      id: botId,
      agent: { id: agent.agentId },
    });

    const uploadInit = await integrations.requestTelegramUploadInit(
      actor,
      {
        filename: "telegram-note.txt",
        contentType: "text/plain",
        length: 12,
      },
      [200],
    );
    expect(uploadInit.body).toMatchObject({
      filename: "telegram-note.txt",
      contentType: "text/plain",
      size: 12,
    });
    if (!("uploadUrl" in uploadInit.body)) {
      throw new Error("Expected Telegram upload init response");
    }
    expect(uploadInit.body.uploadUrl).toMatch(/^https?:\/\//);

    const sentMessage = await integrations.requestSendTelegramMessage(
      actor,
      {
        botId,
        chatId: "12345",
        text: "BDD Telegram message",
        replyToMessageId: 7,
        messageThreadId: 9,
      },
      [200],
    );
    expect(sentMessage.body).toStrictEqual({
      ok: true,
      messageId: 321,
      chatId: "12345",
    });

    if (!("avatarUrl" in registered.body)) {
      throw new Error("Expected Telegram register response");
    }
    const avatarUrl = registered.body.avatarUrl ?? "";
    expect(avatarUrl).not.toBe("");
    const parsedAvatarUrl = new URL(avatarUrl, "http://api.test");
    context.mocks.telegram.getUserProfilePhotos.mockResolvedValue([]);
    const avatar = await integrations.requestTelegramAvatar(
      null,
      botId,
      {
        exp: parsedAvatarUrl.searchParams.get("exp") ?? undefined,
        sig: parsedAvatarUrl.searchParams.get("sig") ?? undefined,
      },
      [200],
    );
    expect(avatar.headers.get("content-type")).toContain("image/svg+xml");

    const unauthenticatedAvatar = await integrations.requestTelegramAvatar(
      null,
      botId,
      {},
      [401],
    );
    expect(unauthenticatedAvatar.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const missingAvatar = await integrations.requestTelegramAvatar(
      actor,
      "555555555",
      {},
      [404],
    );
    expect(missingAvatar.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const memberDisconnect = await integrations.requestDisconnectTelegramBot(
      member,
      botId,
      [403],
    );
    expect(memberDisconnect.body).toMatchObject({
      error: { code: "FORBIDDEN" },
    });

    const disconnected = await integrations.requestDisconnectTelegramBot(
      actor,
      botId,
      [204],
    );
    expect(disconnected.status).toBe(204);

    const afterDisconnect = await integrations.requestListTelegramIntegrations(
      actor,
      [200],
    );
    expect(afterDisconnect.body).toMatchObject({
      bots: expect.not.arrayContaining([
        expect.objectContaining({ id: botId }),
      ]),
    });
  });

  it("keeps Telegram Fast footers bound to the originating run", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    const actor = integrations.user();
    await integrations.enableAuditLinkSwitch(actor);
    await configureFastCodexPreference(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Telegram Fast agent",
    });

    const telegramBotId = randomInt(1_000_000_000, 9_999_999_999);
    const telegramBotToken = `${telegramBotId}:bdd-fast-token`;
    const botId = String(telegramBotId);
    const sentMessages: Record<string, unknown>[] = [];
    server.use(
      telegramDomainProbe(),
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
    context.mocks.telegram.getMe.mockResolvedValue({
      id: telegramBotId,
      username: "bdd_fast_bot",
      can_read_all_group_messages: true,
    });
    let webhookSecret: string | undefined;
    context.mocks.telegram.setWebhook.mockImplementation(
      (...args: readonly unknown[]) => {
        const secret = args[2];
        if (typeof secret === "string") {
          webhookSecret = secret;
        }
        return Promise.resolve();
      },
    );
    await integrations.requestRegisterTelegramBot(
      actor,
      { botToken: telegramBotToken, defaultAgentId: agent.agentId },
      [201],
    );
    if (!webhookSecret) {
      throw new Error(
        "Expected Telegram registration to configure a webhook secret",
      );
    }

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
    expect(JSON.stringify(sentMessages)).toContain("GPT 5.6 Sol Fast");

    sentMessages.length = 0;
    await integrations.updateUserModelPreference(actor, "gpt-5.6-sol", null);
    await completeSlackTriggeredRun({
      runId,
      sandboxToken: claim.sandboxToken,
      cliAgentType: "codex",
      codexAgentMessageText: "telegram fast reply",
    });
    await flushWaitUntilAndAssert(() => {
      const providerOutput = JSON.stringify(sentMessages);
      expect(providerOutput).toContain("telegram fast reply");
      expect(providerOutput).toContain("GPT 5.6 Sol Fast");
      expect(providerOutput).toContain(
        `https://app.okou.ai/activities/${runId}`,
      );
    });
  });

  it("refreshes telegram typing for pending webhook-dispatched runs", async () => {
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    const actor = integrations.user();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Telegram typing agent",
    });

    const typingBotId = randomInt(1_000_000_000, 9_999_999_999);
    const typingBotToken = `${typingBotId}:bdd-typing-token`;
    const botId = String(typingBotId);
    const chatActions: {
      readonly chat_id: string;
      readonly action: string;
    }[] = [];
    server.use(
      telegramDomainProbe(),
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
    context.mocks.telegram.getMe.mockResolvedValue({
      id: typingBotId,
      username: "bdd_typing_bot",
      can_read_all_group_messages: true,
    });
    let webhookSecret: string | undefined;
    context.mocks.telegram.setWebhook.mockImplementation(
      (...args: readonly unknown[]) => {
        const secret = args[2];
        if (typeof secret === "string") {
          webhookSecret = secret;
        }
        return Promise.resolve();
      },
    );
    await integrations.requestRegisterTelegramBot(
      actor,
      { botToken: typingBotToken, defaultAgentId: agent.agentId },
      [201],
    );
    if (!webhookSecret) {
      throw new Error(
        "Expected Telegram registration to configure a webhook secret",
      );
    }

    // Link the actor with a valid Telegram login hash — the test knows the
    // bot token because it registered the bot through the API.
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
    await expect
      .poll(async () => {
        const run = await runs.readRun(actor, runId);
        return run.status;
      })
      .toBe("cancelled");
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

  it("preserves signed GitHub install brand across provider callbacks", async () => {
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
      publicBrand: "okou",
      publicBrandSig: expect.stringMatching(/^[0-9a-f]{64}$/u),
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
    const tamperedState = JSON.stringify({
      ...okouState,
      publicBrand: "vm0",
      publicBrandSig: "0".repeat(64),
    });
    const tamperedError = await integrations.requestGithubAppSetupCallback(
      {
        error: "access_denied",
        error_description: "Provider denied access",
        state: tamperedState,
      },
      [307],
    );
    expect(new URL(tamperedError.headers.get("location") ?? "").origin).toBe(
      "https://app.okou.ai",
    );

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
        repo: "vm0-ai/vm0",
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
      publicBrand: "okou",
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
        toNumber: "+15555551212",
        text: "BDD AgentPhone message",
      },
      [401],
    );
    expect(unauthorizedMessage.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const unlinkedSend = await integrations.requestSendPhoneMessage(
      actor,
      {
        toNumber: "+15555551212",
        text: "not linked",
      },
      [404],
    );
    expect(unlinkedSend.body).toMatchObject({
      error: { code: "NOT_FOUND" },
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
        toNumber: "+15555551212",
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
        message: "AgentPhone is not configured",
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
    expect(connectParams.get("publicBrand")).toBe("okou");
    expect(connectParams.get("brandSig")).toMatch(/^[0-9a-f]{64}$/u);
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
      publicBrand:
        connectParams.get("publicBrand") === "okou"
          ? ("okou" as const)
          : undefined,
      publicBrandSignature: connectParams.get("brandSig") ?? undefined,
    };
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
      publicBrand: "okou",
    });

    const missingAgentMessage = await integrations.requestSendPhoneMessage(
      actor,
      {
        toNumber: phoneHandle,
        text: "BDD AgentPhone missing agent",
      },
      [404],
    );
    expect(missingAgentMessage.body).toStrictEqual({
      error: {
        message: "AgentPhone agent not found",
        code: "NOT_FOUND",
      },
    });

    const sentPhoneMessage = await integrations.requestSendPhoneMessage(
      actor,
      {
        agentphoneAgentId: connectBody.agentphoneAgentId,
        toNumber: phoneHandle,
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
        toNumber: phoneHandle,
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

    const strippedNewConnect = await integrations.requestConnectAgentPhone(
      integrations.user(),
      {
        phoneHandle: connectBody.phoneHandle,
        agentphoneAgentId: connectBody.agentphoneAgentId,
        timestamp: connectBody.timestamp,
        signature: connectBody.signature,
        channel: connectBody.channel,
      },
      [400],
    );
    expect(strippedNewConnect.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
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
      publicBrand: "okou",
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
        message: "AgentPhone verification text could not be sent",
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
