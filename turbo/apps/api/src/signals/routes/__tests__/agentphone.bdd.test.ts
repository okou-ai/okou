import { state, createStore } from "ccstate";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";
import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { GET_STARTED_REWARDS_CHANGED_EVENT } from "@okouai/api-contracts/contracts/get-started";
import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { integrationsPhoneMessageRoutes } from "../integrations-phone-message";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  clearAllDetached,
  createDeferredPromise,
  joinAll,
  settle,
  settleIncludingAbort,
} from "../../utils";
import { createFixtureLifecycle } from "./helpers/fixture-lifecycle";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { findPendingInputEventByText } from "./helpers/chat-event-test-reader";
import {
  AGENTPHONE_BDD_AGENT_ID,
  AGENTPHONE_BDD_PHONE_NUMBER,
  bddGroupId,
  createAgentPhoneBddApi,
  uniqueConversationId,
  uniquePhoneHandle,
  type AgentPhoneProviderSend,
  type AgentPhoneSendCapture,
} from "./helpers/api-bdd-agentphone";
import {
  captureIntegrationInputUploads,
  expectIntegrationInputPreview,
  listIntegrationInputFileParts,
} from "./helpers/integration-input-assets";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { readGetStartedStatus } from "./helpers/get-started";
// INT-03 deep AgentPhone flows: linking through the webhook connect prompt,
// real run dispatch through runner poll/claim, and completion replies through
// typed internal callback dispatch. All state is constructed through public
// APIs; the only mocked surfaces are the AgentPhone provider, Stripe, Clerk,
// S3, and Axiom boundaries.

const context = testContext();
// The mock CLI observes the same resume intent the real Guest receives.
const claimedNativeSessions$ = state<Readonly<Record<string, string>>>({});
const nativeSessionStore = createStore();
beforeEach(() => {
  nativeSessionStore.set(claimedNativeSessions$, {});
});
interface LinkedAgentPhoneActor {
  readonly actor: ApiTestUser;
  readonly ap: ReturnType<typeof createAgentPhoneBddApi>;
  readonly phone: string;
  readonly runnerGroup: string;
  readonly sends: AgentPhoneSendCapture;
  readonly storage: {
    addArtifactObject(object: {
      readonly uploadId: string;
      readonly filename: string;
      readonly size: number;
    }): void;
  };
}

async function runFiniteAgentPhoneHistory(
  operation: () => Promise<void>,
): Promise<void> {
  const lifecycle = createFixtureLifecycle({
    async teardown() {
      const waiting = await settleIncludingAbort(flushWaitUntilForTest);
      const detached = await settleIncludingAbort(clearAllDetached);
      const errors = [waiting, detached].flatMap((result) => {
        return result.ok ? [] : [result.error];
      });
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "AgentPhone history cleanup failed");
      }
    },
  });
  const result = await settleIncludingAbort(() => {
    return lifecycle.run(operation);
  });
  const finished = await settleIncludingAbort(() => {
    return lifecycle.finish();
  });
  const errors = [result, finished].flatMap((outcome) => {
    return outcome.ok ? [] : [outcome.error];
  });
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "AgentPhone history fixture failed");
  }
}

async function entitledLinkedActor(): Promise<LinkedAgentPhoneActor> {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const integrations = createBddIntegrationApi(context);
  const ap = createAgentPhoneBddApi(context);

  const actor = bdd.user();
  const storage = ap.acceptAgentPhoneObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  const runnerGroup = runs.configureRunnerGroup();
  integrations.configureAgentPhoneProvider();
  integrations.configureAgentPhoneWebhook();
  const sends = ap.captureAgentPhoneSends();

  await runs.grantProEntitlement(actor);
  const phone = uniquePhoneHandle();
  // Linking does not select a model; both prerequisites finish before ingress.
  await joinAll([
    runs.ensurePersonalSubscriptionModel(actor),
    ap.linkViaWebhookConnectPrompt(actor, phone, sends),
  ]);
  return { actor, ap, phone, runnerGroup, sends, storage };
}

async function contactCardConversation() {
  const linked = await entitledLinkedActor();
  const conversationId = uniqueConversationId();
  server.use(
    http.get(
      `https://api.agentphone.test/v1/conversations/${conversationId}`,
      () => {
        return HttpResponse.json({
          capabilities: { canSendMessages: true, media: true },
        });
      },
    ),
  );
  return {
    ...linked,
    conversationId,
    async answer(body: string) {
      const messageId = await linked.ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: linked.phone,
        body,
        conversationId,
      });
      const run = await claimDispatchedRun(linked.runnerGroup);
      await completeSandboxRun(run.sandboxToken, run.runId, 0, {
        resultText: `Answer: ${body}`,
      });
      await flushWaitUntilForTest();
      return { ...run, messageId };
    },
  };
}

const modelSessionScenarios = [
  { channel: "sms", withConversation: false },
  { channel: "imessage", withConversation: true },
  { channel: "imessage", withConversation: false },
] as const;

async function modelSessionScenario({
  channel,
  withConversation,
}: (typeof modelSessionScenarios)[number]) {
  const ap = createAgentPhoneBddApi(context);

  const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();

  await createBddIntegrationApi(context).configureNativeSubscriptionModels(
    actor,
  );
  const conversationId = withConversation ? uniqueConversationId() : undefined;
  async function send(body: string) {
    return await ap.postAgentPhoneInboundMessage({
      channel,
      from: phone,
      body,
      conversationId,
    });
  }
  async function complete(
    body: string,
    expectedModel: "claude-fable-5-1" | "gpt-6-astra",
  ) {
    const messageId = await send(body);
    const run = await claimDispatchedRun(runnerGroup);
    expect(run.cliAgentType).toBe(
      expectedModel === "gpt-6-astra" ? "codex" : "claude-code",
    );
    expect(run.environment).toMatchObject(
      expectedModel === "gpt-6-astra"
        ? { OPENAI_MODEL: expectedModel }
        : { ANTHROPIC_MODEL: expectedModel },
    );
    await completeSandboxRun(run.sandboxToken, run.runId, 0, {
      cliAgentType: run.cliAgentType,
    });
    expect(lastSend(sends).body).toBe("Task completed successfully.");
    if (channel === "imessage") {
      expect(lastSend(sends)).toMatchObject({
        toNumber: phone,
        replyToMessageId: messageId,
      });
      expect(lastSend(sends).conversationId).toBeUndefined();
    } else {
      expect(lastSend(sends).toNumber).toBe(phone);
      expect(lastSend(sends).replyToMessageId).toBeUndefined();
    }
    const sessionId = await waitForRunSessionIdPresent(actor, run.runId);
    const chat = createChatFilesBddApi(context);
    const lifecycle = await chat.requestThreadEvents(actor, {}, [200]);
    if (lifecycle.status !== 200) {
      throw new Error("Expected AgentPhone thread lifecycle events");
    }
    const threads = lifecycle.body.events.filter((event) => {
      return event.kind === "created";
    });
    const thread = threads.at(-1);
    if (!thread) {
      throw new Error("Expected AgentPhone to expose its main DM thread");
    }
    const events = await chat.listThreadEvents(actor, thread.chatThreadId);
    expect(events.events).toContainEqual(
      expect.objectContaining({ eventType: "input.prompt", runId: run.runId }),
    );
    const metadata = await chat.readThreadMetadata(actor, thread.chatThreadId);
    return {
      sessionId,
      cliAgentSessionId: agentPhoneCliAgentSessionIdForRun(run.runId),
      resumedSessionId: run.resumedSessionId,
      selectedModel: metadata.selectedModel,
      threadId: thread.chatThreadId,
      threadCount: threads.length,
      serviceTier: run.serviceTier,
    };
  }
  return { actor, send, complete, sends, runnerGroup };
}

async function claimDispatchedRun(runnerGroup: string): Promise<{
  readonly runId: string;
  readonly sandboxToken: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly okouToken: string | undefined;
  readonly resumedSessionId: string | undefined;
  readonly cliAgentType: "claude-code" | "codex";
  readonly environment: Record<string, string> | null;
  readonly serviceTier: string | undefined;
}> {
  const runs = createRunsApi(context);
  await runs.heartbeatRunner(runnerGroup);
  let runId: string | undefined;
  await flushWaitUntilForTest();
  await expect(
    (async () => {
      const poll = await runs.pollRunner(runnerGroup);
      runId = poll.body.job?.runId;
      return runId ?? null;
    })(),
  ).resolves.not.toBeNull();
  if (!runId) {
    throw new Error("Expected an AgentPhone run to be dispatched");
  }
  const claim = await runs.claimRunnerJob(runId);
  if (claim.cliAgentType !== "claude-code" && claim.cliAgentType !== "codex") {
    throw new Error(
      `Expected a native AgentPhone claim, got ${claim.cliAgentType}`,
    );
  }
  if (claim.nativeContinuation?.sessionId) {
    nativeSessionStore.set(claimedNativeSessions$, {
      ...nativeSessionStore.get(claimedNativeSessions$),
      [runId]: claim.nativeContinuation.sessionId,
    });
  }
  return {
    runId,
    sandboxToken: claim.sandboxToken,
    prompt: claim.prompt,
    appendSystemPrompt: claim.appendSystemPrompt ?? "",
    okouToken: claim.platformEnvironment.OKOU_TOKEN,
    resumedSessionId: claim.nativeContinuation?.sessionId ?? undefined,
    cliAgentType: claim.cliAgentType,
    environment: claim.environment,
    serviceTier: claim.platformEnvironment.OKOU_CODEX_SERVICE_TIER,
  };
}

function agentPhoneCliAgentSessionIdForRun(runId: string): string {
  return (
    nativeSessionStore.get(claimedNativeSessions$)[runId] ??
    `bdd-agentphone-cli-${runId}`
  );
}

async function completeSandboxRun(
  sandboxToken: string,
  runId: string,
  exitCode: number,
  options: {
    readonly error?: string;
    readonly resultText?: string;
    readonly cliAgentType?: "claude-code" | "codex";
  } = {},
): Promise<void> {
  const webhooks = createWebhookCallbackApi(context);
  const sandboxHeaders = { authorization: `Bearer ${sandboxToken}` };
  if (options.resultText !== undefined) {
    await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "result",
            sequenceNumber: 0,
            result: options.resultText,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
  }
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode,
      ...(exitCode === 0
        ? {
            completion: {
              cliAgentType: options.cliAgentType ?? "claude-code",
              cliAgentSessionId: agentPhoneCliAgentSessionIdForRun(runId),
              cliAgentSessionHistoryDisposition: "native_only",
            },
          }
        : {}),
      ...(options.error === undefined ? {} : { error: options.error }),
      ...(options.resultText === undefined ? {} : { lastEventSequence: 0 }),
    },
    sandboxHeaders,
    [200],
  );
  await clearAllDetached();
}

function expectConnectedWelcome(
  sends: readonly AgentPhoneProviderSend[],
): void {
  expect(
    sends.map((send) => {
      return send.body;
    }),
  ).toStrictEqual([
    expect.stringContaining("Your phone number is now connected to Okou."),
    expect.stringContaining("connect the tools you already use"),
    expect.stringContaining("What would you like to start with?"),
  ]);
  expect(
    sends.map((send) => {
      return send.mediaUrls;
    }),
  ).toStrictEqual([[], [], []]);
}

function lastSend(sends: AgentPhoneSendCapture): AgentPhoneProviderSend {
  const send = sends.messages.at(-1);
  if (!send) {
    throw new Error("Expected a captured AgentPhone provider send");
  }
  return send;
}

async function connectFromReceivedLink(
  actor: ApiTestUser,
  prompt: AgentPhoneProviderSend | undefined,
): Promise<void> {
  const url = prompt?.body?.match(/https?:\/\/\S+/u)?.[0];
  if (!url) {
    throw new Error("Expected a private connection link for the group sender");
  }
  const params = new URL(url).searchParams;
  await createBddIntegrationApi(context).requestConnectAgentPhone(
    actor,
    {
      phoneHandle: params.get("handle") ?? "",
      agentphoneAgentId: params.get("agent") ?? "",
      timestamp: Number(params.get("ts")),
      signature: params.get("sig") ?? "",
      channel: params.get("channel") ?? undefined,
    },
    [200],
  );
}

// The surface delivery rules follow the integration block as their own
// section, so they are part of the caller-supplied tail this test pins.
const AGENTPHONE_INTEGRATION_NOTE = [
  "# Integration Note",
  "",
  "- Phone messaging and files: use `okou phone --help`. Only your final reply is delivered to the originating conversation, and nothing you produce while the run is in progress is sent on its own, so phone commands are for explicit extra messages or file delivery. Use `okou phone download-file -h` for `[Phone file]` blocks. `okou phone upload-file -h` can share a local file when the phone channel supports the requested file delivery. For an explicitly requested iMessage group upload, use `--to <Group ID>`; the connected user must currently belong to that group. Omitting --to sends to the user's own phone.",
  "- Private artifacts in the final reply: weigh this only while composing the final reply, never during the run. This upload guidance applies to replies in the phone channel. If the user continues the conversation in Web chat, deliver files there and do not continue uploading to the phone channel unless the user explicitly requests it. A private `/artifacts/...` address is not openable from the phone channel, so a link alone shows the user nothing. When you judge that the phone channel can display that kind of file — a hosted website or HTML page never qualifies — upload it with `okou phone upload-file` so the user has something they can open there. If you upload it, also keep the original private `/artifacts/...` address from before the upload in the final reply, not the address returned by `okou phone upload-file`, so the owner can open the original artifact after returning to the web app.",
].join("\n");

function expectIntegrationImmediatelyBeforeRestrictedContent(
  appendSystemPrompt: string,
  expectedIntegration: string,
  expectedThreadContext?: string,
): void {
  const restrictedContentIndex = appendSystemPrompt.lastIndexOf(
    "# Restricted Explicit Content",
  );
  expect(restrictedContentIndex).toBeGreaterThan(-1);
  // The API appends the built-in image model section after the caller's own
  // prompt, so the integration block is the last caller-supplied section
  // rather than the last section overall.
  const imageModelIndex = appendSystemPrompt.lastIndexOf(
    "\n\n# Built-in image model",
  );
  expect(imageModelIndex).toBeGreaterThan(-1);
  expect(imageModelIndex).toBeLessThan(restrictedContentIndex);
  const expectedTail = [
    expectedIntegration,
    AGENTPHONE_INTEGRATION_NOTE,
    ...(expectedThreadContext === undefined ? [] : [expectedThreadContext]),
  ].join("\n\n");
  expect(
    appendSystemPrompt
      .slice(0, imageModelIndex)
      .trimEnd()
      .endsWith(expectedTail),
  ).toBeTruthy();
}

async function waitForTyping(
  sends: AgentPhoneSendCapture,
  expected: readonly string[],
): Promise<void> {
  await flushWaitUntilForTest();
  expect(sends.typing).toStrictEqual(expected);
}

async function waitForSendCount(
  sends: AgentPhoneSendCapture,
  count: number,
): Promise<void> {
  await flushWaitUntilForTest();
  expect(sends.messages.length).toBeGreaterThanOrEqual(count);
}

async function waitForSendMatching(
  sends: AgentPhoneSendCapture,
  startIndex: number,
  predicate: (send: AgentPhoneProviderSend) => boolean,
): Promise<AgentPhoneProviderSend> {
  await flushWaitUntilForTest();
  const matched = sends.messages.slice(startIndex).find(predicate);
  expect(matched).toBeDefined();
  if (!matched) {
    throw new Error("Expected a matching AgentPhone provider send");
  }
  return matched;
}

async function waitForRunSessionId(
  actor: ApiTestUser,
  runId: string,
  expected: string,
): Promise<void> {
  const ap = createAgentPhoneBddApi(context);
  await flushWaitUntilForTest();
  await expect(
    (async () => {
      return await ap.readRunSessionId(actor, runId);
    })(),
  ).resolves.toBe(expected);
}

async function waitForRunSessionIdPresent(
  actor: ApiTestUser,
  runId: string,
): Promise<string> {
  const ap = createAgentPhoneBddApi(context);
  let sessionId: string | undefined;
  await flushWaitUntilForTest();
  await expect(
    (async () => {
      const result = await settle(ap.readRunSessionId(actor, runId));
      sessionId = result.ok ? result.value : undefined;
      return sessionId ?? null;
    })(),
  ).resolves.not.toBeNull();
  if (!sessionId) {
    throw new Error(`Expected run ${runId} to expose a session id`);
  }
  return sessionId;
}

const MARKDOWN_RUN_OUTPUT = [
  "# Inbox summary",
  "",
  "```",
  "code line",
  "```",
  "",
  "**Bold** _italic_ `code` ~~strike~~",
  "",
  "See [docs](https://okou.ai/docs) and ![chart](https://okou.ai/chart.png)",
  "",
  "- first",
  "* second",
  "> quoted",
].join("\n");

const EXPECTED_PLAIN_RUN_OUTPUT = [
  "Inbox summary",
  "",
  "code line",
  "",
  "Bold italic code strike",
  "",
  "See docs",
  "https://okou.ai/docs and chart",
  "https://okou.ai/chart.png",
  "",
  "- first",
  "- second",
  "quoted",
].join("\n");

describe("INT-03: AgentPhone linked-run lifecycle through public APIs", () => {
  it("sends an explicit group message with a run-scoped CLI token and archives it for current members", async () => {
    const integrations = createBddIntegrationApi(context);
    const { actor, ap, phone, runnerGroup, sends } =
      await entitledLinkedActor();
    const other = createBddApi(context).user();
    const otherPhone = uniquePhoneHandle();
    await ap.linkViaWebhookConnectPrompt(other, otherPhone, sends);
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "@Okou prepare a group update",
      conversationId,
      isGroup: true,
      participants: [{ identifier: phone }, { identifier: otherPhone }],
    });
    const run = await claimDispatchedRun(runnerGroup);
    expect(run.appendSystemPrompt).toContain(`Group ID: ${groupId}`);
    expect(run.appendSystemPrompt).toContain(
      `okou imessage message send --to ${groupId}`,
    );
    if (!run.okouToken) {
      throw new Error("Expected a claim-issued CLI token");
    }
    const client = setupApp({
      context,
      routes: integrationsPhoneMessageRoutes,
    })(integrationsAgentPhoneContract);
    const sent = await accept(
      client.groupMessage({
        headers: { authorization: `Bearer ${run.okouToken}` },
        body: { groupId, text: "The group update is ready" },
      }),
      [200],
    );
    expect(sent.body).toMatchObject({ ok: true, toNumber: groupId });
    expect(lastSend(sends)).toMatchObject({
      agentId: AGENTPHONE_BDD_AGENT_ID,
      toNumber: groupId,
      body: "The group update is ready",
    });
    for (const member of [actor, other]) {
      const history = await integrations.requestAgentPhoneGroupHistory(
        member,
        { groupId, limit: 100 },
        [200],
      );
      if (history.status !== 200) {
        throw new Error("Expected authorized group history");
      }
      expect(history.body.messages).toContainEqual(
        expect.objectContaining({
          id: sent.body.messageId,
          conversationId,
          toNumber: groupId,
          direction: "outbound",
          channel: "imessage",
          body: "The group update is ready",
        }),
      );
    }
    await completeSandboxRun(run.sandboxToken, run.runId, 0);
  });

  it.each([
    "unknown group",
    "foreign workspace",
    "unrelated user",
    "unlinked phone",
    "departed member",
    "foreign agent",
  ] as const)("rejects an explicit group send for a %s", async (scenario) => {
    const integrations = createBddIntegrationApi(context);
    const { actor, ap, phone, sends } = await entitledLinkedActor();
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "ordinary group conversation",
      conversationId,
      isGroup: true,
      participants: [{ identifier: phone }],
    });
    const sender =
      scenario === "unrelated user"
        ? createBddApi(context).user({ orgId: actor.orgId })
        : actor;
    if (scenario === "unrelated user") {
      await ap.linkViaWebhookConnectPrompt(sender, uniquePhoneHandle(), sends);
    }
    if (scenario === "unlinked phone") {
      await integrations.requestUnlinkAgentPhone(actor, [204]);
    }
    if (scenario === "departed member") {
      server.use(
        http.get(
          `https://api.agentphone.test/v1/conversations/${conversationId}`,
          () => {
            return HttpResponse.json({ participants: [uniquePhoneHandle()] });
          },
        ),
      );
    }
    const before = sends.messages.length;
    const denied = await integrations.requestSendAgentPhoneGroupMessage(
      scenario === "foreign workspace"
        ? { ...actor, orgId: `org_${randomUUID()}` }
        : sender,
      {
        groupId:
          scenario === "unknown group"
            ? bddGroupId(uniqueConversationId())
            : groupId,
        text: "This must not be sent",
        ...(scenario === "foreign agent"
          ? { agentphoneAgentId: "foreign-agent" }
          : {}),
      },
      [404],
    );
    expect(denied.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(sends.messages).toHaveLength(before);
  });

  it.each([
    { providerStatus: 404, expectedStatus: 404 },
    { providerStatus: 503, expectedStatus: 502 },
  ] as const)(
    "does not send a group message when roster lookup returns $providerStatus",
    async ({ providerStatus, expectedStatus }) => {
      const integrations = createBddIntegrationApi(context);
      const { actor, ap, phone, sends } = await entitledLinkedActor();
      const conversationId = uniqueConversationId();
      const groupId = bddGroupId(conversationId);
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "ordinary group conversation",
        conversationId,
        isGroup: true,
      });
      server.use(
        http.get(
          `https://api.agentphone.test/v1/conversations/${conversationId}`,
          () => {
            return HttpResponse.json(
              { detail: "Roster unavailable" },
              { status: providerStatus },
            );
          },
        ),
      );
      const before = sends.messages.length;
      const failed = await integrations.requestSendAgentPhoneGroupMessage(
        actor,
        { groupId, text: "This must not be sent" },
        [expectedStatus],
      );
      expect(failed.status).toBe(expectedStatus);
      expect(sends.messages).toHaveLength(before);
    },
  );

  it("does not retry an uncertain group message or fall back to a DM", async () => {
    const integrations = createBddIntegrationApi(context);
    const { actor, ap, phone, sends } = await entitledLinkedActor();
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "ordinary group conversation",
      conversationId,
      isGroup: true,
    });
    const attempts: unknown[] = [];
    server.use(
      http.post(
        "https://api.agentphone.test/v1/messages",
        async ({ request }) => {
          attempts.push(await request.json());
          return HttpResponse.json(
            { detail: "Send outcome unknown" },
            { status: 503 },
          );
        },
      ),
    );
    const before = sends.messages.length;
    await integrations.requestSendAgentPhoneGroupMessage(
      actor,
      { groupId, text: "Group update" },
      [502],
    );
    expect(attempts).toStrictEqual([
      {
        agent_id: AGENTPHONE_BDD_AGENT_ID,
        to_number: groupId,
        body: "Group update",
      },
    ]);
    expect(sends.messages).toHaveLength(before);
  });

  it("requires authentication for explicit group sends", async () => {
    const denied = await createBddIntegrationApi(
      context,
    ).requestSendAgentPhoneGroupMessage(
      null,
      { groupId: "grp_auth_required", text: "Group update" },
      [401],
    );
    expect(denied.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("sends one contact card after a successful text conversation and ignores repeated callbacks", async () => {
    const chat = await contactCardConversation();
    const before = chat.sends.messages.length;
    expect(
      chat.sends.messages.every((message) => {
        return message.mediaUrls.length === 0;
      }),
    ).toBeTruthy();

    const first = await chat.answer("hello");
    expect(chat.sends.messages.slice(before)).toMatchObject([
      { body: "Answer: hello", mediaUrls: [] },
      {
        body: "Save Okou to your contacts so you can find this chat anytime.",
        mediaUrls: [expect.stringMatching(/\/okou\.vcf$/u)],
        toNumber: chat.phone,
      },
    ]);
    await createWebhookCallbackApi(context).requestAgentComplete(
      { runId: first.runId, exitCode: 0 },
      { authorization: `Bearer ${first.sandboxToken}` },
      [200],
    );
    await chat.ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: chat.phone,
      body: "hello",
      messageId: first.messageId,
      conversationId: chat.conversationId,
    });
    await flushWaitUntilForTest();
    expect(chat.sends.messages).toHaveLength(before + 2);
    await chat.answer("another question");
    expect(chat.sends.messages).toHaveLength(before + 3);
    expect(lastSend(chat.sends).body).toBe("Answer: another question");
  });

  it.each([
    { canSendMessages: true, media: false },
    { canSendMessages: false, media: true },
    null,
  ])(
    "waits for media permission without interrupting the answer: %j",
    async (capabilities) => {
      const chat = await contactCardConversation();
      server.use(
        http.get(
          `https://api.agentphone.test/v1/conversations/${chat.conversationId}`,
          () => {
            return HttpResponse.json({ capabilities });
          },
          { once: true },
        ),
      );
      const before = chat.sends.messages.length;
      await chat.answer("first question");
      expect(chat.sends.messages.slice(before)).toMatchObject([
        { body: "Answer: first question", mediaUrls: [] },
      ]);
      await chat.answer("next question");
      expect(chat.sends.messages.slice(before)).toHaveLength(3);
      expect(lastSend(chat.sends).mediaUrls).toStrictEqual([
        expect.stringMatching(/\/okou\.vcf$/u),
      ]);
    },
  );

  it("defers a restricted contact card until a new text interaction without replaying the answer", async () => {
    const chat = await contactCardConversation();
    const attempts: unknown[] = [];
    server.use(
      http.post(
        "https://api.agentphone.test/v1/messages",
        async ({ request }) => {
          const message: unknown = await request.clone().json();
          if (
            typeof message !== "object" ||
            message === null ||
            !("media_urls" in message)
          ) {
            return;
          }
          attempts.push(message);
          if (attempts.length === 1) {
            return HttpResponse.json(
              {
                error: {
                  code: "CONVERSATION_CONTENT_RESTRICTED",
                  message: "Send plain text first",
                },
              },
              { status: 422 },
            );
          }
        },
      ),
    );
    const before = chat.sends.messages.length;
    const first = await chat.answer("hello");
    expect(chat.sends.messages.slice(before)).toMatchObject([
      { body: "Answer: hello" },
    ]);
    expect(attempts).toHaveLength(1);
    await createWebhookCallbackApi(context).requestAgentComplete(
      { runId: first.runId, exitCode: 0 },
      { authorization: `Bearer ${first.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    expect(attempts).toHaveLength(1);
    await chat.answer("please continue");
    expect(attempts).toHaveLength(2);
    expect(chat.sends.messages.slice(before)).toMatchObject([
      { body: "Answer: hello" },
      { body: "Answer: please continue" },
      { mediaUrls: [expect.stringMatching(/\/okou\.vcf$/u)] },
    ]);
  });

  it("does not retry unrelated contact-card validation failures on later messages", async () => {
    const chat = await contactCardConversation();
    const rejected: unknown[] = [];
    server.use(
      http.post(
        "https://api.agentphone.test/v1/messages",
        async ({ request }) => {
          const message: unknown = await request.clone().json();
          if (
            typeof message === "object" &&
            message !== null &&
            "media_urls" in message
          ) {
            rejected.push(message);
            return HttpResponse.json(
              { error: { code: "VALIDATION_ERROR" } },
              { status: 422 },
            );
          }
        },
      ),
    );
    const before = chat.sends.messages.length;
    await chat.answer("first question");
    await chat.answer("second question");
    expect(rejected).toHaveLength(1);
    expect(chat.sends.messages.slice(before)).toMatchObject([
      { body: "Answer: first question" },
      { body: "Answer: second question" },
    ]);
  });

  it.each([
    "accepted",
    "absent",
    "different-attachment",
    "missing-conversation",
  ] as const)(
    "reconciles an uncertain card against provider history without resending: %s",
    async (outcome) => {
      const chat = await contactCardConversation();
      const attempts: Record<string, unknown>[] = [];
      const historyReads: string[] = [];
      server.use(
        http.post(
          "https://api.agentphone.test/v1/messages",
          async ({ request }) => {
            const message: unknown = await request.clone().json();
            if (
              typeof message === "object" &&
              message !== null &&
              "media_urls" in message
            ) {
              attempts.push(message as Record<string, unknown>);
              return HttpResponse.error();
            }
          },
        ),
        http.get(
          `https://api.agentphone.test/v1/conversations/${chat.conversationId}/messages`,
          ({ request }) => {
            historyReads.push(request.url);
            if (outcome === "missing-conversation") {
              return new HttpResponse(null, { status: 404 });
            }
            const after = new URL(request.url).searchParams.get("after");
            const message = attempts[0];
            if (!after || !message) {
              throw new Error(
                "Expected a recorded contact-card attempt before reconciliation",
              );
            }
            return HttpResponse.json({
              data:
                outcome === "absent"
                  ? []
                  : [
                      {
                        id: "provider-accepted-contact-card",
                        body: message.body,
                        fromNumber: AGENTPHONE_BDD_PHONE_NUMBER,
                        toNumber: chat.phone,
                        direction: "outbound",
                        status: "sent",
                        mediaUrls:
                          outcome === "different-attachment"
                            ? ["https://example.com/other.vcf"]
                            : message.media_urls,
                        receivedAt: new Date(
                          Date.parse(after) + 1,
                        ).toISOString(),
                      },
                    ],
              hasMore: outcome === "absent",
            });
          },
        ),
      );
      const before = chat.sends.messages.length;
      await chat.answer("first question");
      await chat.answer("second question");
      expect(historyReads).toHaveLength(1);
      await chat.answer("third question");
      expect(historyReads).toHaveLength(outcome === "accepted" ? 1 : 2);
      expect(attempts).toHaveLength(1);
      expect(chat.sends.messages.slice(before)).toMatchObject([
        { body: "Answer: first question" },
        { body: "Answer: second question" },
        { body: "Answer: third question" },
      ]);
    },
  );

  it("keeps answers working when the optional media capability lookup fails", async () => {
    const chat = await contactCardConversation();
    server.use(
      http.get(
        `https://api.agentphone.test/v1/conversations/${chat.conversationId}`,
        () => {
          return HttpResponse.json({ error: "unavailable" }, { status: 503 });
        },
        { once: true },
      ),
    );
    const before = chat.sends.messages.length;
    await chat.answer("first question");
    expect(chat.sends.messages.slice(before)).toMatchObject([
      { body: "Answer: first question" },
    ]);
    await chat.answer("second question");
    expect(lastSend(chat.sends).mediaUrls).toHaveLength(1);
  });

  it.each(["12345678", "/unrecognized_command"])(
    "waits for an ordinary text interaction after %s",
    async (body) => {
      const chat = await contactCardConversation();
      const before = chat.sends.messages.length;
      await chat.answer(body);
      expect(chat.sends.messages.slice(before)).toMatchObject([
        { body: `Answer: ${body}`, mediaUrls: [] },
      ]);
      await chat.answer("hello");
      expect(lastSend(chat.sends).mediaUrls).toHaveLength(1);
    },
  );

  it.each([
    "failed-run",
    "failed-reply",
    "media-only",
    "group",
    "help",
  ] as const)(
    "keeps the contact card pending after a %s interaction",
    async (kind) => {
      const chat = await contactCardConversation();
      const before = chat.sends.messages.length;
      const mediaUrl = "https://media.agentphone.test/contact-card-photo.png";
      if (kind === "media-only") {
        server.use(
          http.get(mediaUrl, () => {
            return new HttpResponse(null, { status: 503 });
          }),
        );
      }
      await chat.ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: chat.phone,
        body:
          kind === "help"
            ? "/help"
            : kind === "media-only"
              ? ""
              : "@Okou hello",
        conversationId:
          kind === "group" ? uniqueConversationId() : chat.conversationId,
        isGroup: kind === "group",
        ...(kind === "media-only" ? { mediaUrl } : {}),
      });
      if (kind !== "help") {
        const run = await claimDispatchedRun(chat.runnerGroup);
        if (kind === "failed-reply") {
          server.use(
            http.post(
              "https://api.agentphone.test/v1/messages",
              () => {
                return HttpResponse.json(
                  { error: "provider unavailable" },
                  { status: 503 },
                );
              },
              { once: true },
            ),
          );
        }
        await completeSandboxRun(
          run.sandboxToken,
          run.runId,
          kind === "failed-run" ? 1 : 0,
        );
        await flushWaitUntilForTest();
      }
      expect(
        chat.sends.messages.slice(before).every((message) => {
          return message.mediaUrls.length === 0;
        }),
      ).toBeTruthy();
      await chat.answer("a normal private question");
      expect(lastSend(chat.sends)).toMatchObject({
        toNumber: chat.phone,
        mediaUrls: [expect.stringMatching(/\/okou\.vcf$/u)],
      });
    },
  );

  it("sends one contact card when completion callbacks arrive concurrently", async () => {
    const chat = await contactCardConversation();
    await chat.ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: chat.phone,
      body: "hello",
      conversationId: chat.conversationId,
    });
    const run = await claimDispatchedRun(chat.runnerGroup);
    const before = chat.sends.messages.length;
    await Promise.all([
      completeSandboxRun(run.sandboxToken, run.runId, 0),
      completeSandboxRun(run.sandboxToken, run.runId, 0),
    ]);
    await flushWaitUntilForTest();
    expect(chat.sends.messages.slice(before)).toMatchObject([
      { body: "Task completed successfully.", mediaUrls: [] },
      { mediaUrls: [expect.stringMatching(/\/okou\.vcf$/u)] },
    ]);
  });

  it("links a direct-message sender with a one-time connection code", async () => {
    const bdd = createBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    const conversationId = uniqueConversationId();
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();
    context.mocks.ably.publish.mockResolvedValue(undefined);

    const issued = await integrations.requestCreateAgentPhoneLinkCode(
      actor,
      [200],
    );
    expect(issued.body.code).toMatch(/^\d{8}$/u);
    expect(Date.parse(issued.body.expiresAt) - now()).toBeGreaterThan(
      9 * 60 * 1000,
    );

    const beforeCode = sends.messages.length;
    const inboundMessageId = await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: issued.body.code,
      conversationId,
      isGroup: false,
    });

    // The welcome stays text-only; only the first threads onto the code message.
    const welcome = sends.messages.slice(beforeCode);
    expectConnectedWelcome(welcome);
    expect(
      welcome.map((send) => {
        return send.replyToMessageId;
      }),
    ).toStrictEqual([inboundMessageId, undefined, undefined]);
    for (const send of welcome) {
      expect(send.toNumber).toBe(phone);
      expect(send.conversationId).toBeUndefined();
    }
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({ linked: true, phoneHandle: phone });

    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: uniquePhoneHandle(),
      body: issued.body.code,
    });
    expect(lastSend(sends).body).toContain("invalid or expired");
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({ linked: true, phoneHandle: phone });
  });

  it("binds one sender and grants one reward when a connection code is consumed concurrently", async () => {
    const bdd = createBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    const actor = bdd.user({ orgRole: "org:member" });
    const phones = [uniquePhoneHandle(), uniquePhoneHandle()];
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const issued = await integrations.requestCreateAgentPhoneLinkCode(
      actor,
      [200],
    );

    await Promise.all(
      phones.map(async (phone) => {
        await ap.postAgentPhoneInboundMessage({
          channel: "imessage",
          from: phone,
          body: issued.body.code,
          conversationId: uniqueConversationId(),
          isGroup: false,
        });
      }),
    );

    const linked = await integrations.getAgentPhoneLinkStatus(actor);
    if (!linked.linked) {
      throw new Error("Expected exactly one sender to be linked");
    }
    expect(phones).toContain(linked.phoneHandle);
    expectConnectedWelcome(
      sends.messages.filter((send) => {
        return send.toNumber === linked.phoneHandle;
      }),
    );
    const loser = phones.find((phone) => {
      return phone !== linked.phoneHandle;
    });
    expect(
      sends.messages
        .filter((send) => {
          return send.toNumber === loser;
        })
        .map((send) => {
          return send.body;
        }),
    ).toStrictEqual([expect.stringContaining("invalid or expired")]);
    const status = await readGetStartedStatus(context, actor);
    expect(
      status.quests.find((quest) => {
        return quest.key === "imessage";
      }),
    ).toMatchObject({
      claimedCount: 1,
      earnedCredits: 1000,
      pendingCount: 0,
      canEarnMore: false,
    });
    const balance = await accept(
      setupApp({ context, routes: billingUsagePackCreditsRoutes })(
        billingUsagePackCreditsContract,
      ).get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(balance.body.bonusCredits).toBe(1000);
    expect(balance.body.creditGrants).toStrictEqual([
      expect.objectContaining({
        grantType: "bonus",
        amount: 1000,
        remaining: 1000,
      }),
    ]);
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toStrictEqual(linked);
  });

  it("sends proactive messages and private files to an email-linked iMessage handle", async () => {
    const bdd = createBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    const actor = bdd.user();
    const email = `bdd-${randomUUID().slice(0, 8)}@example.com`;
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();
    const storage = ap.acceptAgentPhoneObjectStorage();
    context.mocks.ably.publish.mockResolvedValue(undefined);

    const issued = await integrations.requestCreateAgentPhoneLinkCode(
      actor,
      [200],
    );
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: email,
      body: issued.body.code,
      conversationId: uniqueConversationId(),
      isGroup: false,
    });
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({ linked: true, phoneHandle: email });

    const sent = await integrations.requestSendPhoneMessage(
      actor,
      { agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID, text: "proactive hello" },
      [200],
    );
    expect(sent.body).toMatchObject({ ok: true, toNumber: email });
    expect(lastSend(sends)).toMatchObject({
      agentId: AGENTPHONE_BDD_AGENT_ID,
      toNumber: email,
      body: "proactive hello",
    });

    const sentCount = sends.messages.length;
    const rejectedSender = await integrations.requestSendPhoneMessage(
      actor,
      { agentphoneAgentId: "another-users-phone-agent", text: "blocked" },
      [404],
    );
    expect(rejectedSender.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(sends.messages).toHaveLength(sentCount);

    const init = await integrations.requestPhoneUploadInit(
      actor,
      { filename: "note.txt", contentType: "text/plain", length: 5 },
      [200],
    );
    if (!("uploadId" in init.body)) {
      throw new Error("Expected the phone upload to initialize");
    }
    storage.addArtifactObject({
      uploadId: init.body.uploadId,
      filename: "note.txt",
      size: 5,
    });
    const completed = await integrations.requestPhoneUploadComplete(
      actor,
      {
        uploadId: init.body.uploadId,
        agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID,
        caption: "proactive file",
      },
      [200],
    );
    if (completed.status !== 200) {
      throw new Error("Expected the phone file to be delivered");
    }
    expect(completed.body).toMatchObject({ toNumber: email });
    const providerSend = lastSend(sends);
    expect(providerSend).toMatchObject({
      toNumber: email,
      body: "proactive file",
    });
    if (!providerSend.mediaUrl) {
      throw new Error("Expected a provider-fetchable phone file");
    }
    expect(completed.body.url).toBe(init.body.fileUrl);
    expect(completed.body.url).toMatch(
      /^https?:\/\/[^/]+\/artifacts\/[a-z0-9]{10}\.txt$/u,
    );
    expect(new URL(providerSend.mediaUrl).searchParams.get("object")).toBe(
      `test-private-artifacts/private-artifacts/${init.body.uploadId}/note.txt`,
    );
    const downloaded = await ap.downloadPhoneFileRaw(
      "clerk-session",
      completed.body.messageId,
    );
    expect(downloaded.status).toBe(302);
    expect(downloaded.headers.get("cache-control")).toBe("private, no-store");
    expect(downloaded.headers.get("x-file-name")).toBe("note.txt");
    expect(downloaded.headers.get("x-file-mimetype")).toBe("text/plain");
    expect(downloaded.headers.get("x-file-size")).toBe("5");
    expect(
      new URL(downloaded.headers.get("location") ?? "").searchParams.get(
        "object",
      ),
    ).toBe(new URL(providerSend.mediaUrl).searchParams.get("object"));
    const foreignActor = bdd.user();
    await integrations.requestPhoneDownloadFile(
      foreignActor,
      completed.body.messageId,
      [404],
    );
    await integrations.requestPhoneDownloadFile(
      { ...actor, orgId: `org_${randomUUID()}` },
      completed.body.messageId,
      [404],
    );
    context.mocks.s3.send.mockRejectedValue(
      Object.assign(new Error("Reference no longer exists"), {
        name: "NoSuchKey",
      }),
    );
    await integrations.requestPhoneDownloadFile(
      actor,
      completed.body.messageId,
      [404],
    );
  });

  it("uses linked inbound identity for proactive text and files without an explicit agent id", async () => {
    const bdd = createBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    const actor = bdd.user();
    const email = `bdd-${randomUUID().slice(0, 8)}@example.com`;
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();
    const storage = ap.acceptAgentPhoneObjectStorage();
    context.mocks.ably.publish.mockResolvedValue(undefined);

    const issued = await integrations.requestCreateAgentPhoneLinkCode(
      actor,
      [200],
    );
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: email,
      body: issued.body.code,
      conversationId: uniqueConversationId(),
    });
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({
      linked: true,
      phoneHandle: email,
    });
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: email,
      body: "/help",
      conversationId: uniqueConversationId(),
    });

    const sent = await integrations.requestSendPhoneMessage(
      actor,
      { text: "hello from linked identity" },
      [200],
    );
    expect(sent.body).toMatchObject({ ok: true, toNumber: email });
    expect(lastSend(sends)).toMatchObject({
      agentId: AGENTPHONE_BDD_AGENT_ID,
      toNumber: email,
      body: "hello from linked identity",
    });

    const init = await integrations.requestPhoneUploadInit(
      actor,
      { filename: "linked.txt", contentType: "text/plain", length: 5 },
      [200],
    );
    if (!("uploadId" in init.body)) {
      throw new Error("Expected the phone upload to initialize");
    }
    storage.addArtifactObject({
      uploadId: init.body.uploadId,
      filename: "linked.txt",
      size: 5,
    });
    const completed = await integrations.requestPhoneUploadComplete(
      actor,
      { uploadId: init.body.uploadId, caption: "file from linked identity" },
      [200],
    );
    expect(completed.body).toMatchObject({
      toNumber: email,
      filename: "linked.txt",
      mimetype: "text/plain",
      size: 5,
      url: init.body.fileUrl,
    });
    const providerSend = lastSend(sends);
    expect(providerSend).toMatchObject({
      agentId: AGENTPHONE_BDD_AGENT_ID,
      toNumber: email,
      body: "file from linked identity",
    });
    if (!providerSend.mediaUrl) {
      throw new Error("Expected a provider-fetchable phone file");
    }
    expect(new URL(providerSend.mediaUrl).searchParams.get("object")).toBe(
      `test-private-artifacts/private-artifacts/${init.body.uploadId}/linked.txt`,
    );
    expect(providerSend.mediaUrl).not.toBe(init.body.fileUrl);
  });

  it("invalidates a previous connection code when a new one is issued", async () => {
    const bdd = createBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();
    context.mocks.ably.publish.mockResolvedValue(undefined);

    const first = await integrations.requestCreateAgentPhoneLinkCode(
      actor,
      [200],
    );
    const second = await integrations.requestCreateAgentPhoneLinkCode(
      actor,
      [200],
    );

    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: first.body.code,
    });
    expect(lastSend(sends).body).toContain("invalid or expired");
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({ linked: false });

    const beforeSecond = sends.messages.length;
    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: second.body.code,
    });
    expectConnectedWelcome(sends.messages.slice(beforeSecond));
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({ linked: true, phoneHandle: phone });
  });

  it("rewards the Get started iMessage quest once per user", async () => {
    const bdd = createBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    // The quest is personal, so a member who is not an admin is offered it.
    const actor = bdd.user({ orgRole: "org:member" });
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();
    context.mocks.ably.publish.mockResolvedValue(undefined);

    async function linkWithCode(user: ApiTestUser): Promise<void> {
      const issued = await integrations.requestCreateAgentPhoneLinkCode(
        user,
        [200],
      );
      const beforeLink = sends.messages.length;
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: uniquePhoneHandle(),
        body: issued.body.code,
        isGroup: false,
      });
      expectConnectedWelcome(sends.messages.slice(beforeLink));
    }
    async function imessageQuest(user: ApiTestUser) {
      const status = await readGetStartedStatus(context, user);
      return status.quests.find((quest) => {
        return quest.key === "imessage";
      });
    }

    await expect(imessageQuest(actor)).resolves.toStrictEqual({
      key: "imessage",
      rewardAmount: 1000,
      rewardTarget: "user",
      claimedCount: 0,
      limit: 1,
      earnedCredits: 0,
      canEarnMore: true,
      pendingCount: 0,
    });

    await linkWithCode(actor);
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      GET_STARTED_REWARDS_CHANGED_EVENT,
      null,
    );
    const earned = {
      claimedCount: 1,
      earnedCredits: 1000,
      canEarnMore: false,
      pendingCount: 0,
    };
    await expect(imessageQuest(actor)).resolves.toMatchObject(earned);

    // Unlinking and linking another phone is a new link, not a new reward.
    await integrations.requestUnlinkAgentPhone(actor, [204]);
    await linkWithCode(actor);
    await expect(imessageQuest(actor)).resolves.toMatchObject(earned);
  });

  it("rejects an expired connection code", async () => {
    const bdd = createBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    const actor = bdd.user();
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();

    const issued = await integrations.requestCreateAgentPhoneLinkCode(
      actor,
      [200],
    );
    mockNow(Date.parse(issued.body.expiresAt) + 1);

    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: uniquePhoneHandle(),
      body: issued.body.code,
    });

    expect(lastSend(sends).body).toContain("invalid or expired");
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({ linked: false });
  });

  it("runs an all-digit prompt from an already linked sender", async () => {
    const ap = createAgentPhoneBddApi(context);
    const { phone, runnerGroup, sends } = await entitledLinkedActor();

    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "20260920",
    });

    const run = await claimDispatchedRun(runnerGroup);
    expect(run.prompt).toContain("20260920");
    await completeSandboxRun(run.sandboxToken, run.runId, 0);
    expect(lastSend(sends).body).toBe("Task completed successfully.");
  });

  it("runs a prompt from an already linked mixed-case iMessage email sender", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    const actor = bdd.user();
    const email = `bdd-${randomUUID().slice(0, 8)}@example.com`;
    ap.acceptAgentPhoneObjectStorage();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const runnerGroup = runs.configureRunnerGroup();
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();

    await runs.grantProEntitlement(actor);
    await runs.ensurePersonalSubscriptionModel(actor);
    const issued = await integrations.requestCreateAgentPhoneLinkCode(
      actor,
      [200],
    );
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: email,
      body: issued.body.code,
      conversationId: uniqueConversationId(),
    });
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({
      linked: true,
      phoneHandle: email,
    });

    const sender = ` ${email.toUpperCase()} `;
    const messageId = await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: sender,
      body: "Summarize my meeting notes",
      conversationId: uniqueConversationId(),
    });
    const run = await claimDispatchedRun(runnerGroup);
    expect(run.prompt).toBe("Summarize my meeting notes");
    const beforeCompletion = sends.messages.length;
    await createWebhookCallbackApi(context).requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        completion: {
          cliAgentType: run.cliAgentType,
          cliAgentSessionId: agentPhoneCliAgentSessionIdForRun(run.runId),
          cliAgentSessionHistoryDisposition: "native_only",
        },
      },
      { authorization: `Bearer ${run.sandboxToken}` },
      [200],
    );
    await expect
      .poll(() => {
        return sends.messages.slice(beforeCompletion).find((send) => {
          return send.replyToMessageId === messageId;
        });
      })
      .toMatchObject({
        toNumber: sender,
        body: "Task completed successfully.",
      });
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({
      linked: true,
      phoneHandle: email,
    });
  });

  it("links an AgentPhone user through the provider connect prompt", async () => {
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    const owner = createPublicConnectorActor(context, {
      optionalEnvironmentNames: [
        "AGENTPHONE_AGENT_ID",
        "AGENTPHONE_API_BASE_URL",
        "AGENTPHONE_API_KEY",
        "AGENTPHONE_PHONE_NUMBER",
        "AGENTPHONE_WEBHOOK_SECRET",
      ],
    });
    const actor = owner.actor;
    await owner.run(async () => {
      integrations.configureAgentPhoneProvider();
      integrations.configureAgentPhoneWebhook();
      const sends = ap.captureAgentPhoneSends();

      const phone = uniquePhoneHandle();
      await ap.linkViaWebhookConnectPrompt(actor, phone, sends);
      await expect(
        integrations.getAgentPhoneLinkStatus(actor),
      ).resolves.toMatchObject({ linked: true, phoneHandle: phone });
    });
  });

  it.each([
    { body: "@Okou hello", sender: "phone" },
    { body: "/connect @Okou", sender: "email" },
  ] as const)(
    "connects an unlinked group $sender sender through a private link after $body",
    async ({ body, sender }) => {
      const integrations = createBddIntegrationApi(context);
      const { actor, phone, runnerGroup, sends, ap } =
        await entitledLinkedActor();
      await integrations.requestUnlinkAgentPhone(actor, [204]);
      const handle =
        sender === "phone" ? phone : `member-${randomUUID()}@example.com`;
      const conversationId = uniqueConversationId();
      const groupId = bddGroupId(conversationId);
      const before = sends.messages.length;
      const messageId = await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: groupId,
        senderIdentifier: handle,
        body,
        conversationId,
        isGroup: true,
        participants: [{ identifier: handle }],
      });

      const prompt = sends.messages[before];
      expect(prompt).toMatchObject({
        toNumber: handle,
        agentId: AGENTPHONE_BDD_AGENT_ID,
        body: expect.stringContaining("/settings/agentphone?"),
      });
      expect(prompt?.replyToMessageId).toBeUndefined();
      expect(sends.messages[before + 1]).toMatchObject({
        toNumber: groupId,
        replyToMessageId: messageId,
        body: expect.stringContaining(
          "I've sent you a private connection link",
        ),
      });
      expect(sends.messages[before + 1]?.body).not.toContain(
        "/settings/agentphone?",
      );

      await connectFromReceivedLink(actor, prompt);
      await expect(
        integrations.getAgentPhoneLinkStatus(actor),
      ).resolves.toMatchObject({
        linked: true,
        phoneHandle: handle,
      });

      // The next group mention works without first sending a private message.
      const followUpId = await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: groupId,
        senderIdentifier: handle,
        body: "@Okou help me now",
        conversationId,
        isGroup: true,
        participants: [{ identifier: handle }],
      });
      const run = await claimDispatchedRun(runnerGroup);
      expect(run.prompt).toBe("@Okou help me now");
      await completeSandboxRun(run.sandboxToken, run.runId, 0);
      expect(lastSend(sends)).toMatchObject({
        toNumber: groupId,
        replyToMessageId: followUpId,
        body: "Task completed successfully.",
      });
    },
  );

  it.each(["accepted", "rejected"] as const)(
    "handles a first-contact link restriction when the plain-text greeting is %s",
    async (greetingDelivery) => {
      const integrations = createBddIntegrationApi(context);
      const { actor, sends, ap, runnerGroup } = await entitledLinkedActor();
      await integrations.requestUnlinkAgentPhone(actor, [204]);
      const phone = uniquePhoneHandle();
      const conversationId = uniqueConversationId();
      const groupId = bddGroupId(conversationId);
      const before = sends.messages.length;
      const privateAttempts: unknown[] = [];
      let hasPrivateReply = false;
      server.use(
        http.post(
          "https://api.agentphone.test/v1/messages",
          async ({ request }) => {
            const message: unknown = await request.clone().json();
            if (
              typeof message !== "object" ||
              message === null ||
              !("to_number" in message) ||
              message.to_number !== phone ||
              !("body" in message) ||
              typeof message.body !== "string"
            ) {
              return;
            }
            privateAttempts.push(message);
            if (
              !hasPrivateReply &&
              message.body.includes("/settings/agentphone?")
            ) {
              return HttpResponse.json(
                {
                  error: {
                    code: "CONVERSATION_CONTENT_RESTRICTED",
                    message: "Wait for a written reply before sending links",
                  },
                },
                { status: 422 },
              );
            }
            if (!hasPrivateReply && greetingDelivery === "rejected") {
              return HttpResponse.json(
                {
                  error: {
                    code: "INBOUND_ONLY",
                    message: "The recipient must message first",
                  },
                },
                { status: 422 },
              );
            }
          },
        ),
      );

      const groupMessageId = await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "@Okou hello",
        conversationId,
        isGroup: true,
        participants: [{ identifier: phone }],
      });
      expect(privateAttempts).toMatchObject([
        {
          to_number: phone,
          body: expect.stringContaining("/settings/agentphone?"),
        },
        {
          to_number: phone,
          body: expect.stringMatching(
            /^Hi, I'm Okou\.\n\nYou can text me like a teammate/u,
          ),
        },
      ]);
      expect(privateAttempts[1]).toMatchObject({
        body: expect.stringContaining(
          "Reply here and I'll send you the link to connect your Okou account.",
        ),
      });
      expect(privateAttempts[1]).not.toHaveProperty("reply_to_message_id");
      expect(lastSend(sends)).toMatchObject({
        toNumber: groupId,
        replyToMessageId: groupMessageId,
        body:
          greetingDelivery === "accepted"
            ? "I've sent you a private message. Please reply there so I can send you your connection link."
            : "Please message this number directly to get your connection link.",
      });
      expect(lastSend(sends).body).not.toContain("/settings/agentphone?");
      await expect(
        integrations.getAgentPhoneLinkStatus(actor),
      ).resolves.toMatchObject({ linked: false });
      if (greetingDelivery === "rejected") {
        expect(sends.messages.slice(before)).toHaveLength(1);
        return;
      }
      expect(sends.messages[before]).toMatchObject({
        toNumber: phone,
        body: expect.stringContaining("Reply here"),
      });

      hasPrivateReply = true;
      const privateMessageId = await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "hi",
        conversationId: uniqueConversationId(),
      });
      const prompt = lastSend(sends);
      expect(prompt).toMatchObject({
        toNumber: phone,
        replyToMessageId: privateMessageId,
        body: expect.stringContaining("/settings/agentphone?"),
      });
      await connectFromReceivedLink(actor, prompt);
      await expect(
        integrations.getAgentPhoneLinkStatus(actor),
      ).resolves.toMatchObject({
        linked: true,
        phoneHandle: phone,
      });

      const followUpId = await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "@Okou help me now",
        conversationId,
        isGroup: true,
        participants: [{ identifier: phone }],
      });
      const run = await claimDispatchedRun(runnerGroup);
      await completeSandboxRun(run.sandboxToken, run.runId, 0);
      expect(lastSend(sends)).toMatchObject({
        toNumber: groupId,
        replyToMessageId: followUpId,
        body: "Task completed successfully.",
      });
    },
  );

  it.each(["quota", "unknown delivery"] as const)(
    "offers direct-message recovery without retrying a private send after %s failure",
    async (failure) => {
      const { phone, sends, ap, actor } = await entitledLinkedActor();
      await createBddIntegrationApi(context).requestUnlinkAgentPhone(
        actor,
        [204],
      );
      const conversationId = uniqueConversationId();
      const groupId = bddGroupId(conversationId);
      const before = sends.messages.length;
      const attempts: unknown[] = [];
      server.use(
        http.post(
          "https://api.agentphone.test/v1/messages",
          async ({ request }) => {
            const body: unknown = await request.clone().json();
            if (
              typeof body === "object" &&
              body !== null &&
              "to_number" in body &&
              body.to_number === phone
            ) {
              attempts.push(body);
              return HttpResponse.json(
                {
                  error: {
                    code:
                      failure === "quota"
                        ? "OUTBOUND_LIMIT_REACHED"
                        : "INTERNAL_ERROR",
                  },
                },
                { status: failure === "quota" ? 429 : 503 },
              );
            }
            return undefined;
          },
        ),
      );

      const messageId = await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "@Okou hello",
        conversationId,
        isGroup: true,
        participants: [{ identifier: phone }],
      });
      expect(sends.messages.slice(before)).toMatchObject([
        {
          toNumber: groupId,
          replyToMessageId: messageId,
          body: "Please message this number directly to get your connection link.",
        },
      ]);
      expect(attempts).toHaveLength(1);
    },
  );

  it.each(["dispatch context", "typing and plain-text completion"] as const)(
    "linked iMessage DMs preserve %s",
    async (scenario) => {
      mockEnv("APP_URL", "https://app.okou.ai");
      const webhooks = createWebhookCallbackApi(context);
      const ap = createAgentPhoneBddApi(context);
      const chat = createChatFilesBddApi(context);
      const integrations = createBddIntegrationApi(context);
      const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();
      await integrations.enableOkouDebug(actor);
      const conversationId = uniqueConversationId();

      // Linked DM creates a run and sends a typing indicator.
      const messageId1 = await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "summarize my inbox",
        conversationId,
        isGroup: false,
      });
      await waitForTyping(sends, [conversationId]);

      if (scenario === "dispatch context") {
        const lifecycle = await chat.requestThreadEvents(actor, {}, [200]);
        if (lifecycle.status !== 200) {
          throw new Error("Expected AgentPhone thread lifecycle events");
        }
        const created = lifecycle.body.events.filter((event) => {
          return event.kind === "created";
        });
        expect(created).toHaveLength(1);
        const launchThreadId = created[0]?.chatThreadId;
        if (!launchThreadId) {
          throw new Error("Expected AgentPhone ingress to own a thread");
        }
        const admittedEvents = await chat.listThreadEvents(
          actor,
          launchThreadId,
        );
        const admittedInput = admittedEvents.events.find((event) => {
          return (
            event.eventType === "input.prompt" &&
            event.userMessage.parts.some((part) => {
              return part.type === "text" && part.text === "summarize my inbox";
            })
          );
        });
        expect(
          admittedInput?.eventType === "input.prompt"
            ? admittedInput.userMessage.parts.find((part) => {
                return part.type === "source";
              })
            : undefined,
        ).toStrictEqual({
          type: "source",
          kind: "agentphone",
          href: `sms:${AGENTPHONE_BDD_PHONE_NUMBER}`,
        });
      }

      const run1 = await claimDispatchedRun(runnerGroup);
      expect(run1.prompt).toBe("summarize my inbox");
      if (scenario === "dispatch context") {
        expectIntegrationImmediatelyBeforeRestrictedContent(
          run1.appendSystemPrompt,
          [
            "# Current Integration",
            "You are currently running inside: Phone text messaging (iMessage/SMS)",
            `Shared phone number: ${AGENTPHONE_BDD_PHONE_NUMBER}`,
            `User phone handle: ${phone}`,
            `Phone agent ID: ${AGENTPHONE_BDD_AGENT_ID}`,
            "Channel: imessage",
            "Conversation type: dm",
            `Conversation ID: ${conversationId}`,
            `Message ID: ${messageId1}`,
          ].join("\n"),
        );

        await completeSandboxRun(run1.sandboxToken, run1.runId, 0);
        return;
      }

      // Agent event dispatch refreshes the iMessage indicator while the run's
      // AgentPhone callback is still pending.
      const typingBody = {
        runId: run1.runId,
        events: [{ type: "assistant", sequenceNumber: 1 }],
      };
      mockNow(now() + 4000);
      const typingScheduled = await webhooks.requestAgentEvents(
        typingBody,
        { authorization: `Bearer ${run1.sandboxToken}` },
        [200],
      );
      expect(typingScheduled.body).toStrictEqual({
        received: 1,
        firstSequence: 1,
        lastSequence: 1,
      });
      await waitForTyping(sends, [conversationId, conversationId]);

      // Sandbox progress refreshes the typing indicator through the callback.
      mockNow(now() + 4000);
      const heartbeat = await webhooks.requestAgentHeartbeat(
        { runId: run1.runId },
        { authorization: `Bearer ${run1.sandboxToken}` },
        [200],
      );
      expect(heartbeat.body).toStrictEqual({
        ok: true,
        typingRefreshIntervalSeconds: 4,
      });
      await waitForTyping(sends, [
        conversationId,
        conversationId,
        conversationId,
      ]);

      // Completion converts markdown output to iMessage plain text.
      const beforeCompletion = sends.messages.length;
      await completeSandboxRun(run1.sandboxToken, run1.runId, 0, {
        resultText: MARKDOWN_RUN_OUTPUT,
      });
      await waitForSendCount(sends, beforeCompletion + 1);
      const completionReply = lastSend(sends);
      expect(completionReply.toNumber).toBe(phone);
      expect(completionReply.conversationId).toBeUndefined();
      expect(completionReply.replyToMessageId).toBe(messageId1);
      expect(completionReply.body).toBe(EXPECTED_PLAIN_RUN_OUTPUT);
    },
  );

  it("admits the Phone input while the first typing request is still pending", async () => {
    const { actor, ap, phone, runnerGroup, sends } =
      await entitledLinkedActor();
    const chat = createChatFilesBddApi(context);
    const conversationId = uniqueConversationId();
    const typingStarted = createDeferredPromise<void>(context.signal);
    const releaseTyping = createDeferredPromise<void>(context.signal);
    server.use(
      http.post(
        `https://api.agentphone.test/v1/conversations/${conversationId}/typing`,
        async () => {
          typingStarted.resolve();
          await releaseTyping.promise;
          return HttpResponse.json({ status: "typing indicator sent" });
        },
      ),
    );
    const inbound = settle(
      ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "Process this while typing is pending",
        conversationId,
      }),
    );
    onTestFinished(async () => {
      if (!releaseTyping.settled()) {
        releaseTyping.resolve();
      }
      await inbound;
    });
    await typingStarted.promise;
    await expect
      .poll(async () => {
        const lifecycle = await chat.requestThreadEvents(actor, {}, [200]);
        if (lifecycle.status !== 200) {
          throw new Error("Expected Phone thread lifecycle events");
        }
        const created = lifecycle.body.events.find((event) => {
          return event.kind === "created";
        });
        if (!created) {
          return [];
        }
        const events = await chat.listThreadEvents(actor, created.chatThreadId);
        return events.events.flatMap((event) => {
          return event.eventType === "input.prompt"
            ? event.userMessage.parts.flatMap((part) => {
                return part.type === "text" ? [part.text] : [];
              })
            : [];
        });
      })
      .toContain("Process this while typing is pending");

    releaseTyping.resolve();
    expect((await inbound).ok).toBeTruthy();
    const run = await claimDispatchedRun(runnerGroup);
    const beforeCompletion = sends.messages.length;
    await completeSandboxRun(run.sandboxToken, run.runId, 0);
    await waitForSendCount(sends, beforeCompletion + 1);
    expect(lastSend(sends).toNumber).toBe(phone);
  });

  it("coalesces Phone typing bursts and refreshes at the next four-second heartbeat", async () => {
    const { ap, phone, runnerGroup, sends } = await entitledLinkedActor();
    const webhooks = createWebhookCallbackApi(context);
    const conversationId = uniqueConversationId();
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "Keep typing through progress updates",
      conversationId,
    });
    const run = await claimDispatchedRun(runnerGroup);
    await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [{ type: "assistant", sequenceNumber: 1 }],
      },
      { authorization: `Bearer ${run.sandboxToken}` },
      [200],
    );
    const earlyHeartbeat = await webhooks.requestAgentHeartbeat(
      { runId: run.runId },
      { authorization: `Bearer ${run.sandboxToken}` },
      [200],
    );
    expect(earlyHeartbeat.body).toStrictEqual({
      ok: true,
      typingRefreshIntervalSeconds: 4,
    });
    await waitForTyping(sends, [conversationId]);

    mockNow(now() + 4000);
    await webhooks.requestAgentHeartbeat(
      { runId: run.runId },
      { authorization: `Bearer ${run.sandboxToken}` },
      [200],
    );
    await waitForTyping(sends, [conversationId, conversationId]);
    await completeSandboxRun(run.sandboxToken, run.runId, 0);
    expect(lastSend(sends).toNumber).toBe(phone);
  });

  it.each(["server", "network", "timeout"] as const)(
    "recovers a Phone typing %s failure on the next progress update",
    async (failure) => {
      const { ap, phone, runnerGroup, sends } = await entitledLinkedActor();
      const webhooks = createWebhookCallbackApi(context);
      const conversationId = uniqueConversationId();
      let failTyping = true;
      const acceptedTyping: string[] = [];
      server.use(
        http.post(
          `https://api.agentphone.test/v1/conversations/${conversationId}/typing`,
          async ({ request }) => {
            if (failTyping) {
              if (failure === "timeout") {
                const aborted = createDeferredPromise<void>(context.signal);
                if (request.signal.aborted) {
                  aborted.resolve();
                } else {
                  request.signal.addEventListener(
                    "abort",
                    () => {
                      if (!aborted.settled()) {
                        aborted.resolve();
                      }
                    },
                    { once: true },
                  );
                }
                await aborted.promise;
              }
              return failure === "network" || failure === "timeout"
                ? HttpResponse.error()
                : HttpResponse.json(
                    { detail: "temporary failure" },
                    { status: 503 },
                  );
            }
            acceptedTyping.push(conversationId);
            return HttpResponse.json({ status: "typing indicator sent" });
          },
        ),
      );
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "Recover typing without delaying my reply",
        conversationId,
      });
      const run = await claimDispatchedRun(runnerGroup);
      failTyping = false;
      await webhooks.requestAgentHeartbeat(
        { runId: run.runId },
        { authorization: `Bearer ${run.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
      expect(acceptedTyping).toStrictEqual([conversationId]);
      await completeSandboxRun(run.sandboxToken, run.runId, 0);
      expect(lastSend(sends).toNumber).toBe(phone);
    },
  );

  it("keeps run progress alive when the typing provider fails", async () => {
    const webhooks = createWebhookCallbackApi(context);
    const ap = createAgentPhoneBddApi(context);
    const { phone, runnerGroup, sends } = await entitledLinkedActor();
    const conversationId = uniqueConversationId();
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "check my inbox",
      conversationId,
      isGroup: false,
    });
    await waitForTyping(sends, [conversationId]);
    const run = await claimDispatchedRun(runnerGroup);

    server.use(
      http.post(
        "https://api.agentphone.test/v1/conversations/:id/typing",
        () => {
          return HttpResponse.json(
            { detail: "temporary failure" },
            { status: 503 },
          );
        },
      ),
    );
    mockNow(now() + 4000);
    const heartbeat = await webhooks.requestAgentHeartbeat(
      { runId: run.runId },
      { authorization: `Bearer ${run.sandboxToken}` },
      [200],
    );
    expect(heartbeat.body).toStrictEqual({
      ok: true,
      typingRefreshIntervalSeconds: 4,
    });
    await flushWaitUntilForTest();

    const beforeCompletion = sends.messages.length;
    await completeSandboxRun(run.sandboxToken, run.runId, 0);
    await waitForSendCount(sends, beforeCompletion + 1);
    expect(lastSend(sends).toNumber).toBe(phone);
  });

  it("reuses the linked iMessage session for follow-up messages", async () => {
    const ap = createAgentPhoneBddApi(context);
    const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();
    const chatCallbacks = createChatCallbacksApi(context);
    await chatCallbacks.registerPushSubscription(actor);
    chatCallbacks.enableVapid();
    const conversationId = uniqueConversationId();

    const beforeFirstCompletion = sends.messages.length;
    const messageId1 = await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "start session",
      conversationId,
      isGroup: false,
    });
    const run1 = await claimDispatchedRun(runnerGroup);
    await completeSandboxRun(run1.sandboxToken, run1.runId, 0);
    await waitForSendCount(sends, beforeFirstCompletion + 1);
    expect(lastSend(sends).body).toBe("Task completed successfully.");
    // Session persistence happens in background callback processing, so
    // wait for the session id to be saved before reading it.
    const session1 = await waitForRunSessionIdPresent(actor, run1.runId);

    // The follow-up DM reuses the saved session and carries stored context.
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "follow up",
      conversationId,
      isGroup: false,
    });
    const run2 = await claimDispatchedRun(runnerGroup);
    expect(run2.appendSystemPrompt).toContain("# Phone Message Context");
    expect(run2.appendSystemPrompt).toContain("RELATIVE_INDEX");
    expect(run2.appendSystemPrompt).toContain(`MSG_ID: ${messageId1}`);
    expect(run2.appendSystemPrompt).toContain("SENDER: {id: BOT}");

    const beforeRun2Completion = sends.messages.length;
    await completeSandboxRun(run2.sandboxToken, run2.runId, 0);
    await waitForSendCount(sends, beforeRun2Completion + 1);
    expect(lastSend(sends).body).toBe("Task completed successfully.");
    await waitForRunSessionId(actor, run2.runId, session1);
    await flushWaitUntilForTest();
    expect(context.mocks.webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("keeps one DM thread as its provider conversation changes or disappears", async () => {
    const { actor, ap, phone, runnerGroup } = await entitledLinkedActor();
    const chat = createChatFilesBddApi(context);
    const conversations = [
      uniqueConversationId(),
      uniqueConversationId(),
      undefined,
    ];
    let sessionId: string | undefined;
    for (const [index, conversationId] of conversations.entries()) {
      const prompt = `continue the same phone thread ${index}`;
      await ap.postAgentPhoneInboundMessage({
        channel: conversationId === undefined ? "sms" : "imessage",
        from: phone,
        body: prompt,
        conversationId,
      });
      const run = await claimDispatchedRun(runnerGroup);
      expect(run.prompt).toBe(prompt);
      if (conversationId === undefined) {
        expect(run.appendSystemPrompt).not.toContain("Conversation ID:");
      } else {
        expect(run.appendSystemPrompt).toContain(
          `Conversation ID: ${conversationId}`,
        );
      }
      await completeSandboxRun(run.sandboxToken, run.runId, 0);
      const currentSessionId = await waitForRunSessionIdPresent(
        actor,
        run.runId,
      );
      if (sessionId === undefined) {
        sessionId = currentSessionId;
      } else {
        expect(currentSessionId).toBe(sessionId);
      }
    }
    const lifecycle = await chat.requestThreadEvents(actor, {}, [200]);
    if (lifecycle.status !== 200) {
      throw new Error("Expected the phone thread lifecycle");
    }
    expect(
      lifecycle.body.events.filter((event) => {
        return event.kind === "created";
      }),
    ).toHaveLength(1);
  });

  it("publishes one thread for distinct concurrent messages to the same phone root", async () => {
    const { actor, ap, phone, runnerGroup, sends } =
      await entitledLinkedActor();
    const chat = createChatFilesBddApi(context);
    const runs = createRunsApi(context);
    const prompts = [
      "first concurrent phone task",
      "second concurrent phone task",
    ];
    const messageIds = await Promise.all(
      prompts.map((body) => {
        return ap.postAgentPhoneInboundMessage({
          channel: "imessage",
          from: phone,
          body,
          conversationId: uniqueConversationId(),
        });
      }),
    );
    const lifecycle = await chat.requestThreadEvents(actor, {}, [200]);
    if (lifecycle.status !== 200) {
      throw new Error("Expected the concurrent phone thread lifecycle");
    }
    const created = lifecycle.body.events.filter((event) => {
      return event.kind === "created";
    });
    expect(created).toHaveLength(1);
    const thread = created[0];
    if (!thread) {
      throw new Error("Expected one published phone thread");
    }
    expect(thread).toMatchObject({
      seqId: 1,
      selectedModel: "claude-fable-5-1",
      cloudBrowserEnabled: true,
    });
    const inputs = await chat.listThreadEvents(actor, thread.chatThreadId);
    for (const prompt of prompts) {
      expect(inputs.events).toContainEqual(
        expect.objectContaining({
          eventType: "input.prompt",
          userMessage: {
            version: 1,
            parts: expect.arrayContaining([{ type: "text", text: prompt }]),
          },
        }),
      );
    }
    const completedPrompts: string[] = [];
    const sendsBeforeCompletion = sends.messages.length;
    for (const index of prompts.keys()) {
      const run = await claimDispatchedRun(runnerGroup);
      completedPrompts[index] = run.prompt;
      await completeSandboxRun(run.sandboxToken, run.runId, 0);
    }
    expect(completedPrompts.sort()).toStrictEqual([...prompts].sort());
    expect(
      sends.messages
        .slice(sendsBeforeCompletion)
        .map((send) => {
          return send.replyToMessageId;
        })
        .sort(),
    ).toStrictEqual([...messageIds].sort());
    await runs.heartbeatRunner(runnerGroup);
    expect((await runs.pollRunner(runnerGroup)).body.job).toBeNull();
    const finalLifecycle = await chat.requestThreadEvents(actor, {}, [200]);
    if (finalLifecycle.status !== 200) {
      throw new Error("Expected the completed phone thread lifecycle");
    }
    expect(
      finalLifecycle.body.events.filter((event) => {
        return event.kind === "created";
      }),
    ).toStrictEqual(created);
  });

  it("forwards unrecognized slash commands as agent prompts", async () => {
    const ap = createAgentPhoneBddApi(context);
    const { phone, runnerGroup } = await entitledLinkedActor();

    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "/unrecognized_command",
      conversationId: uniqueConversationId(),
      isGroup: false,
    });

    const run = await claimDispatchedRun(runnerGroup);
    expect(run.prompt).toBe("/unrecognized_command");
  });

  it("replies to failed linked iMessage runs", async () => {
    const ap = createAgentPhoneBddApi(context);
    const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();
    const chatCallbacks = createChatCallbacksApi(context);
    await chatCallbacks.registerPushSubscription(actor);
    chatCallbacks.enableVapid();
    const conversationId = uniqueConversationId();

    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "now fail",
      conversationId,
      isGroup: false,
    });
    const run = await claimDispatchedRun(runnerGroup);
    const beforeCompletion = sends.messages.length;
    await completeSandboxRun(run.sandboxToken, run.runId, 1, {
      error: "AgentPhone bdd route failure",
    });
    await waitForSendCount(sends, beforeCompletion + 1);
    expect(lastSend(sends).body).toBe(
      "Oops, something went wrong. Please try again later.",
    );
    await flushWaitUntilForTest();
    expect(context.mocks.webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("identifies the workspace and offers account recovery after a run runs out of credits", async () => {
    const { actor, ap, phone, runnerGroup, sends } =
      await entitledLinkedActor();
    const workspaceName = "Finance * Operations";
    context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
      id: actor.orgId,
      name: workspaceName,
    });

    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "finish my report",
      conversationId: uniqueConversationId(),
    });
    const run = await claimDispatchedRun(runnerGroup);
    const beforeCompletion = sends.messages.length;
    await completeSandboxRun(run.sandboxToken, run.runId, 1, {
      error: "insufficient_credits",
    });
    await waitForSendCount(sends, beforeCompletion + 1);
    const reply = lastSend(sends).body;
    expect(reply).toContain(`workspace "${workspaceName}"`);
    expect(reply).toContain("which has insufficient credits to continue");
    expect(reply).toContain(
      "Add credits or connect a personal Codex or Claude",
    );
    expect(reply).toContain("?settings=billing&billingView=credits");
    expect(reply).toContain(
      "Or switch to a different Okou account or workspace: send /switch.",
    );

    const chat = createChatFilesBddApi(context);
    const lifecycle = await chat.requestThreadEvents(actor, {}, [200]);
    if (lifecycle.status !== 200) {
      throw new Error("Expected AgentPhone thread lifecycle events");
    }
    const thread = lifecycle.body.events.find((event) => {
      return event.kind === "created";
    });
    if (!thread) {
      throw new Error("Expected the Phone chat thread");
    }
    const events = await chat.listThreadEvents(actor, thread.chatThreadId);
    expect(events.events).toContainEqual(
      expect.objectContaining({
        eventType: "run.failed",
        content: "insufficient_credits",
      }),
    );
  });

  it.each([
    { role: "org:admin", isGroup: false },
    { role: "org:member", isGroup: false },
    { role: "org:admin", isGroup: true },
  ] as const)(
    "offers role-aware recovery for a depleted workspace ($role, group=$isGroup)",
    async ({ role, isGroup }) => {
      const bdd = createBddApi(context);
      const integrations = createBddIntegrationApi(context);
      const ap = createAgentPhoneBddApi(context);
      const owner = bdd.user();
      bdd.acceptAgentStorageWrites();
      context.mocks.ably.publish.mockResolvedValue(undefined);
      integrations.configureAgentPhoneProvider();
      integrations.configureAgentPhoneWebhook();
      const sends = ap.captureAgentPhoneSends();
      await bdd.bootstrapLimitedFreeOnboarding(owner, {
        displayName: "Workspace recovery agent",
      });
      const actor =
        role === "org:admin"
          ? owner
          : bdd.user({ orgId: owner.orgId, orgRole: role });
      const phone = uniquePhoneHandle();
      await ap.linkViaWebhookConnectPrompt(actor, phone, sends);
      // Let the public onboarding and connection rewards expire naturally.
      mockNow(now() + 90 * 24 * 60 * 60 * 1000);
      const workspaceName = "Original Phone Workspace";
      context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
        id: actor.orgId,
        name: workspaceName,
      });
      const conversationId = uniqueConversationId();
      const beforeSend = sends.messages.length;
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "@Okou help me with this report",
        conversationId,
        isGroup,
      });
      await waitForSendCount(sends, beforeSend + 1);
      const reply = lastSend(sends).body;
      if (isGroup) {
        expect(reply).toContain("Insufficient credits");
        expect(reply).not.toContain(workspaceName);
        expect(reply).not.toContain("/switch");
        await ap.postAgentPhoneInboundMessage({
          channel: "imessage",
          from: phone,
          body: "/switch @Okou",
          conversationId,
          isGroup: true,
        });
        expect(lastSend(sends).body).toContain("message this number directly");
        expect(lastSend(sends).body).not.toContain("/settings/agentphone?");
        const status = await integrations.getAgentPhoneLinkStatus(actor);
        expect(status.linked).toBeTruthy();
        return;
      }
      expect(reply).toContain(`workspace "${workspaceName}"`);
      expect(reply).toContain("send /switch");
      if (role === "org:admin") {
        expect(reply).toContain("?settings=billing&billingView=plans");
      } else {
        expect(reply).toContain("Ask a workspace admin");
        expect(reply).not.toContain("?settings=billing");
      }

      const beforeSwitch = sends.messages.length;
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "/switch",
      });
      expect(sends.messages).toHaveLength(beforeSwitch + 1);
      expect(lastSend(sends).body).toContain(
        "Your phone has been disconnected",
      );
      const connectUrl = lastSend(sends).body?.match(/https?:\/\/\S+/u)?.[0];
      if (!connectUrl) {
        throw new Error("Expected /switch to return a new connection URL");
      }
      const status = await integrations.getAgentPhoneLinkStatus(actor);
      expect(status.linked).toBeFalsy();
      const destination = bdd.user();
      const params = new URL(connectUrl).searchParams;
      await integrations.requestConnectAgentPhone(
        destination,
        {
          phoneHandle: params.get("handle") ?? "",
          agentphoneAgentId: params.get("agent") ?? "",
          timestamp: Number(params.get("ts")),
          signature: params.get("sig") ?? "",
          channel: params.get("channel") ?? undefined,
        },
        [200],
      );
      const destinationStatus =
        await integrations.getAgentPhoneLinkStatus(destination);
      expect(destinationStatus).toMatchObject({
        linked: true,
        phoneHandle: phone,
      });
      const originalStatus = await integrations.getAgentPhoneLinkStatus(actor);
      expect(originalStatus.linked).toBeFalsy();
    },
  );

  it("keeps the phone conversation usable after the provider rejects a completion reply", async () => {
    const { ap, phone, runnerGroup, sends } = await entitledLinkedActor();
    const webhooks = createWebhookCallbackApi(context);
    async function complete(runId: string, sandboxToken: string) {
      await webhooks.requestAgentComplete(
        {
          runId,
          exitCode: 0,
          completion: {
            cliAgentType: "claude-code",
            cliAgentSessionId: agentPhoneCliAgentSessionIdForRun(runId),
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
        { authorization: `Bearer ${sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
    }
    const conversationId = uniqueConversationId();
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "first phone request",
      conversationId,
    });
    const firstRun = await claimDispatchedRun(runnerGroup);
    const beforeCompletion = sends.messages.length;
    server.use(
      http.post(
        "https://api.agentphone.test/v1/messages",
        () => {
          return HttpResponse.json(
            { detail: "Recipient is temporarily unavailable" },
            { status: 422 },
          );
        },
        { once: true },
      ),
    );

    await complete(firstRun.runId, firstRun.sandboxToken);
    expect(sends.messages).toHaveLength(beforeCompletion);
    await webhooks.requestAgentComplete(
      { runId: firstRun.runId, exitCode: 0 },
      { authorization: `Bearer ${firstRun.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    expect(sends.messages).toHaveLength(beforeCompletion);

    const nextMessageId = await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "try the next phone request",
      conversationId,
    });
    const nextRun = await claimDispatchedRun(runnerGroup);
    expect(nextRun.prompt).toBe("try the next phone request");
    await complete(nextRun.runId, nextRun.sandboxToken);
    expect(sends.messages).toHaveLength(beforeCompletion + 1);
    expect(lastSend(sends)).toMatchObject({
      toNumber: phone,
      replyToMessageId: nextMessageId,
      body: "Task completed successfully.",
    });
  });

  it("does not send a phone reply after the user deletes the running thread", async () => {
    const { actor, ap, phone, runnerGroup, sends } =
      await entitledLinkedActor();
    const chat = createChatFilesBddApi(context);
    const webhooks = createWebhookCallbackApi(context);
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "delete this phone conversation",
      conversationId: uniqueConversationId(),
    });
    const run = await claimDispatchedRun(runnerGroup);
    const lifecycle = await chat.requestThreadEvents(actor, {}, [200]);
    if (lifecycle.status !== 200) {
      throw new Error("Expected AgentPhone thread lifecycle events");
    }
    const thread = lifecycle.body.events.find((event) => {
      return event.kind === "created";
    });
    if (!thread) {
      throw new Error("Expected the phone conversation's thread");
    }
    const beforeDeletion = sends.messages.length;

    await chat.deleteThread(actor, thread.chatThreadId);
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 1,
        error: "Run ended after its thread was deleted",
      },
      { authorization: `Bearer ${run.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    expect(sends.messages).toHaveLength(beforeDeletion);
    await chat.requestListThreadEvents(actor, thread.chatThreadId, {}, [404]);
  });

  it("rejects unavailable personal DM input without silently billing Auto", async () => {
    const integrations = createBddIntegrationApi(context);
    const runs = createRunsApi(context);
    const { actor, complete, send, runnerGroup } = await modelSessionScenario({
      channel: "sms",
      withConversation: false,
    });
    await integrations.updateUserModelPreference(actor, "gpt-6-astra");
    const preferred = await complete("use my web default", "gpt-6-astra");

    await createMiscRoutesApi(context).deletePersonalModelProvider(
      actor,
      "codex-oauth-token",
      [204],
    );
    await expect(
      integrations.readUserModelPreference(actor),
    ).resolves.toMatchObject({
      selectedModel: "auto",
    });

    await send("use the system default");
    await runs.heartbeatRunner(runnerGroup);
    await flushWaitUntilForTest();
    expect((await runs.pollRunner(runnerGroup)).body.job).toBeNull();
    const events = await createChatFilesBddApi(context).listThreadEventRows(
      actor,
      preferred.threadId,
    );
    expect(events).toContainEqual(
      expect.objectContaining({ eventType: "input.rejected", runId: null }),
    );
    const metadata = await createChatFilesBddApi(context).readThreadMetadata(
      actor,
      preferred.threadId,
    );
    expect(metadata.selectedModel).toBe("gpt-6-astra");
  });

  it("keeps the DM service tier captured when its thread was created", async () => {
    const integrations = createBddIntegrationApi(context);
    const { actor, complete } = await modelSessionScenario({
      channel: "sms",
      withConversation: false,
    });
    await integrations.updateUserModelPreference(
      actor,
      "gpt-6-astra",
      "priority",
    );
    const fast = await complete("use my web fast preference", "gpt-6-astra");
    expect(fast.serviceTier).toBe("fast");

    await integrations.updateUserModelPreference(actor, "gpt-6-astra", null);
    const standard = await complete(
      "retain this thread's fast service",
      "gpt-6-astra",
    );
    expect(standard.serviceTier).toBe("fast");
    expect(standard.threadId).toBe(fast.threadId);
    expect(standard.threadCount).toBe(1);
    const continued = await complete(
      "continue with fast service",
      "gpt-6-astra",
    );
    expect(continued.serviceTier).toBe("fast");
    expect(continued.threadId).toBe(fast.threadId);
    expect(continued.threadCount).toBe(1);
  });

  it("shares one canonical session across AgentPhone and web messages on the same thread", async () => {
    const ap = createAgentPhoneBddApi(context);
    const chat = createChatFilesBddApi(context);
    const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();
    // Ingress-created threads take the same creation-time media pin as web
    // threads, so this thread is the representative coverage for the ingress
    // wiring of that pin.
    const smsMessageId = await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "start on my phone",
    });
    const phoneRun1 = await claimDispatchedRun(runnerGroup);
    expect(phoneRun1.prompt).toBe("start on my phone");
    expectIntegrationImmediatelyBeforeRestrictedContent(
      phoneRun1.appendSystemPrompt,
      [
        "# Current Integration",
        "You are currently running inside: Phone text messaging (iMessage/SMS)",
        `Shared phone number: ${AGENTPHONE_BDD_PHONE_NUMBER}`,
        `User phone handle: ${phone}`,
        `Phone agent ID: ${AGENTPHONE_BDD_AGENT_ID}`,
        "Channel: sms",
        "Conversation type: dm",
        `Message ID: ${smsMessageId}`,
      ].join("\n"),
    );
    const beforePhoneCompletion = sends.messages.length;
    await completeSandboxRun(phoneRun1.sandboxToken, phoneRun1.runId, 0);
    await waitForSendCount(sends, beforePhoneCompletion + 1);
    const smsReply = lastSend(sends);
    expect(smsReply.toNumber).toBe(phone);
    expect(smsReply.body).toBe("Task completed successfully.");
    const sharedSession = await waitForRunSessionIdPresent(
      actor,
      phoneRun1.runId,
    );

    const lifecycle = await chat.requestThreadEvents(actor, {}, [200]);
    if (lifecycle.status !== 200) {
      throw new Error("Expected AgentPhone thread lifecycle events");
    }
    const created = lifecycle.body.events.filter((event) => {
      return event.kind === "created";
    });
    expect(created).toHaveLength(1);
    const thread = created[0];
    if (!thread) {
      throw new Error("Expected AgentPhone ingress to create a chat thread");
    }
    const phoneEvents = await chat.listThreadEvents(actor, thread.chatThreadId);
    expect(
      phoneEvents.events.some((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.userMessage.parts.some((part) => {
            return (
              part.type === "source" &&
              part.kind === "agentphone" &&
              part.href === `sms:${AGENTPHONE_BDD_PHONE_NUMBER}`
            );
          })
        );
      }),
    ).toBeTruthy();

    const webSend = await chat.sendAndLaunch(actor, {
      agentId: thread.agentId,
      threadId: thread.chatThreadId,
      prompt: "continue from the web",
    });
    const webRun = await claimDispatchedRun(runnerGroup);
    expect(webRun.runId).toBe(webSend.runId);
    const sendsBeforeWebCompletion = sends.messages.length;
    await completeSandboxRun(webRun.sandboxToken, webRun.runId, 0);
    expect(sends.messages).toHaveLength(sendsBeforeWebCompletion);
    await waitForRunSessionId(actor, webRun.runId, sharedSession);

    // Provider history changes prompt context without rotating the canonical
    // session shared by the phone and web surfaces.
    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "finish back on my phone",
      recentHistory: [
        {
          messageId: "rh-shared-session",
          content: "provider history before returning to the phone",
          direction: "inbound",
          channel: "sms",
          from: phone,
          at: "2026-06-01T08:00:00.000Z",
        },
      ],
    });
    const phoneRun2 = await claimDispatchedRun(runnerGroup);
    await completeSandboxRun(phoneRun2.sandboxToken, phoneRun2.runId, 0);
    await waitForRunSessionId(actor, phoneRun2.runId, sharedSession);

    const finalLifecycle = await chat.requestThreadEvents(actor, {}, [200]);
    if (finalLifecycle.status !== 200) {
      throw new Error("Expected final AgentPhone thread lifecycle events");
    }
    expect(
      finalLifecycle.body.events
        .filter((event) => {
          return event.kind === "created";
        })
        .map((event) => {
          return event.chatThreadId;
        }),
    ).toStrictEqual([thread.chatThreadId]);
  });

  it("queues AgentPhone messages in FIFO order without loss or duplication", async () => {
    const runs = createRunsApi(context);
    const ap = createAgentPhoneBddApi(context);
    const { actor, phone, runnerGroup } = await entitledLinkedActor();

    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "first queued prompt",
    });
    const run1 = await claimDispatchedRun(runnerGroup);

    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "second queued prompt",
    });
    const secondEvent = await findPendingInputEventByText(context, {
      actor,
      text: "second queued prompt",
    });
    if (!secondEvent) {
      throw new Error("Expected pending AgentPhone queue item");
    }
    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "third queued prompt",
    });
    await runs.heartbeatRunner(runnerGroup);
    const whileBusy = await runs.pollRunner(runnerGroup);
    expect(whileBusy.body.job).toBeNull();

    await completeSandboxRun(run1.sandboxToken, run1.runId, 0);
    const sharedSession = await waitForRunSessionIdPresent(actor, run1.runId);
    const run2 = await claimDispatchedRun(runnerGroup);
    expect(run2.prompt).toBe("second queued prompt");
    await completeSandboxRun(run2.sandboxToken, run2.runId, 0);
    await waitForRunSessionId(actor, run2.runId, sharedSession);

    const run3 = await claimDispatchedRun(runnerGroup);
    expect(run3.prompt).toBe("third queued prompt");
    await completeSandboxRun(run3.sandboxToken, run3.runId, 0);
    await waitForRunSessionId(actor, run3.runId, sharedSession);

    await runs.heartbeatRunner(runnerGroup);
    const drained = await runs.pollRunner(runnerGroup);
    expect(drained.body.job).toBeNull();
  });

  it("rejects a queued AgentPhone input and replies with the failure when launch preparation fails with debug enabled", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const ap = createAgentPhoneBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const reads = createRunReadsApi(context);
    const chat = createChatFilesBddApi(context);
    const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();
    await integrations.enableOkouDebug(actor);

    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "finish before the queued launch",
    });
    const activeRun = await claimDispatchedRun(runnerGroup);

    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "fail this queued Okou launch",
    });

    mockEnv("SECRETS_KMS_KEY_ID", undefined);
    const beforeCompletion = sends.messages.length;
    await expect(
      completeSandboxRun(activeRun.sandboxToken, activeRun.runId, 0),
    ).rejects.toThrow(
      "SECRETS_KMS_KEY_ID is required for KMS secret encryption",
    );

    const completionBodies = sends.messages
      .slice(beforeCompletion)
      .map((send) => {
        return send.body;
      });
    expect(completionBodies).toHaveLength(2);
    expect(completionBodies).toStrictEqual(
      expect.arrayContaining([
        "Task completed successfully.",
        "Oops, something went wrong. Please try again later.",
      ]),
    );
    const runList = await reads.requestListLogs(actor, { limit: 100 }, [200]);
    expect(runList.body.data).toStrictEqual([
      expect.objectContaining({ id: activeRun.runId, status: "completed" }),
    ]);
    const lifecycle = await chat.requestThreadEvents(actor, {}, [200]);
    if (lifecycle.status !== 200) {
      throw new Error("Expected AgentPhone thread lifecycle events");
    }
    const thread = lifecycle.body.events.find((event) => {
      return event.kind === "created";
    });
    if (!thread) {
      throw new Error("Expected an AgentPhone chat thread");
    }
    const messages = await chat.listThreadEvents(actor, thread.chatThreadId);
    const pending = messages.events.find((event) => {
      return (
        event.eventType === "input.prompt" &&
        event.userMessage.parts.some((part) => {
          return (
            part.type === "text" && part.text === "fail this queued Okou launch"
          );
        })
      );
    });
    if (!pending) {
      throw new Error("Expected the original queued input after the failure");
    }
    expect(pending.runId).toBeUndefined();
    // The picked input ends rejected rather than waiting at the queue head.
    expect(messages.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: pending.id,
        error: "internal_error",
      }),
    );
  });

  it("archives group admission-failure replies with the iMessage channel", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const integrations = createBddIntegrationApi(context);
    const { actor, phone, runnerGroup, sends, ap } =
      await entitledLinkedActor();

    const conversationId = uniqueConversationId();
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "@Okou finish before the queued group launch",
      conversationId,
      isGroup: true,
      participants: [{ identifier: phone }],
    });
    const activeRun = await claimDispatchedRun(runnerGroup);
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "@Okou fail this queued group launch",
      conversationId,
      isGroup: true,
      participants: [{ identifier: phone }],
    });

    mockEnv("SECRETS_KMS_KEY_ID", undefined);
    const beforeCompletion = sends.messages.length;
    await expect(
      completeSandboxRun(activeRun.sandboxToken, activeRun.runId, 0),
    ).rejects.toThrow(
      "SECRETS_KMS_KEY_ID is required for KMS secret encryption",
    );
    expect(
      sends.messages.slice(beforeCompletion).map((send) => {
        return send.body;
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        "Task completed successfully.",
        "Oops, something went wrong. Please try again later.",
      ]),
    );

    const history = await integrations.requestAgentPhoneGroupHistory(
      actor,
      { groupId: bddGroupId(conversationId), limit: 100 },
      [200],
    );
    if (history.status !== 200) {
      throw new Error(
        "Expected iMessage group history after admission failure",
      );
    }
    expect(history.body.messages).toContainEqual(
      expect.objectContaining({
        direction: "outbound",
        channel: "imessage",
        body: expect.stringContaining("Oops, something went wrong"),
      }),
    );
  });

  it("rejects a queued input whose phone link was removed before admission", async () => {
    const runs = createRunsApi(context);
    const ap = createAgentPhoneBddApi(context);
    const chat = createChatFilesBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();

    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "finish before the phone link is removed",
    });
    const activeRun = await claimDispatchedRun(runnerGroup);
    const queuedPrompt = "reject this input after unlinking";
    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: queuedPrompt,
    });
    await flushWaitUntilForTest();

    const lifecycle = await chat.requestThreadEvents(actor, {}, [200]);
    if (lifecycle.status !== 200) {
      throw new Error("Expected AgentPhone thread lifecycle events");
    }
    const thread = lifecycle.body.events.find((event) => {
      return event.kind === "created";
    });
    if (!thread) {
      throw new Error("Expected an AgentPhone chat thread");
    }
    const queued = await chat.listThreadEvents(actor, thread.chatThreadId);
    const pending = queued.events.find((event) => {
      return (
        event.eventType === "input.prompt" &&
        event.userMessage.parts.some((part) => {
          return part.type === "text" && part.text === queuedPrompt;
        })
      );
    });
    if (!pending) {
      throw new Error("Expected the busy thread to retain the queued input");
    }
    expect(pending.runId).toBeUndefined();
    await integrations.requestUnlinkAgentPhone(actor, [204]);
    const beforeCompletion = sends.messages.length;

    await completeSandboxRun(activeRun.sandboxToken, activeRun.runId, 0);

    const settled = await chat.listThreadEvents(actor, thread.chatThreadId);
    expect(settled.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: pending.id,
        error: "conflict",
      }),
    );
    expect(settled.events).toContainEqual(
      expect.objectContaining({
        eventType: "output.error",
        error: "conflict",
      }),
    );
    expect(sends.messages).toHaveLength(beforeCompletion);
    await runs.heartbeatRunner(runnerGroup);
    expect((await runs.pollRunner(runnerGroup)).body.job).toBeNull();
  });

  it("deduplicates repeated provider messages and completion callbacks", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const ap = createAgentPhoneBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();
    await integrations.enableOkouDebug(actor);
    const messageId = `ap-msg-dedup-${randomUUID()}`;
    const message = {
      channel: "sms" as const,
      from: phone,
      body: "process exactly once",
      messageId,
    };

    await ap.postAgentPhoneInboundMessage({
      ...message,
    });
    await ap.postAgentPhoneInboundMessage({
      ...message,
    });
    const run = await claimDispatchedRun(runnerGroup);
    expect(run.prompt).toBe("process exactly once");
    await runs.heartbeatRunner(runnerGroup);
    const duplicateJob = await runs.pollRunner(runnerGroup);
    expect(duplicateJob.body.job).toBeNull();

    const sendsBeforeCompletion = sends.messages.length;
    await completeSandboxRun(run.sandboxToken, run.runId, 0);
    await waitForSendCount(sends, sendsBeforeCompletion + 1);
    expect(lastSend(sends).body).toBe("Task completed successfully.");
    const sendsAfterCompletion = sends.messages.length;

    await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 0 },
      { authorization: `Bearer ${run.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    expect(sends.messages).toHaveLength(sendsAfterCompletion);

    await ap.postAgentPhoneInboundMessage({
      ...message,
    });
    await runs.heartbeatRunner(runnerGroup);
    const lateDuplicate = await runs.pollRunner(runnerGroup);
    expect(lateDuplicate.body.job).toBeNull();
    expect(sends.messages).toHaveLength(sendsAfterCompletion);
  });

  it.each(["sms", "imessage"] as const)(
    "deduplicates concurrent %s ingress by provider message and webhook identities",
    async (channel) => {
      const { actor, ap, phone, runnerGroup, sends } =
        await entitledLinkedActor();
      const runs = createRunsApi(context);
      const integrations = createBddIntegrationApi(context);
      const isGroup = channel === "imessage";
      const conversationId = uniqueConversationId();
      const groupId = bddGroupId(conversationId);
      const messageId = `ap-concurrent-${randomUUID()}`;
      const webhookId = `evt-concurrent-${randomUUID()}`;
      const message = {
        channel,
        from: phone,
        body: isGroup
          ? "@Okou accept this event once"
          : "accept this event once",
        messageId,
        webhookId,
        conversationId,
        ...(isGroup
          ? { isGroup, groupId, participants: [{ identifier: phone }] }
          : {}),
      };
      await Promise.all([
        ap.postAgentPhoneInboundMessage(message),
        ap.postAgentPhoneInboundMessage(message),
      ]);
      await ap.postAgentPhoneInboundMessage({
        ...message,
        webhookId: `${webhookId}-replay`,
      });
      await ap.postAgentPhoneInboundMessage({
        ...message,
        messageId: `${messageId}-replay`,
      });
      const run = await claimDispatchedRun(runnerGroup);
      expect(run.prompt).toBe(message.body);
      await runs.heartbeatRunner(runnerGroup);
      expect((await runs.pollRunner(runnerGroup)).body.job).toBeNull();
      if (isGroup) {
        const history = await integrations.requestAgentPhoneGroupHistory(
          actor,
          { groupId, limit: 100 },
          [200],
        );
        expect(
          history.status === 200 ? history.body.messages : [],
        ).toMatchObject([{ id: messageId, body: message.body }]);
        expect(
          history.status === 200 ? history.body.messages : [],
        ).toHaveLength(1);
      }
      const sendCount = sends.messages.length;
      await completeSandboxRun(run.sandboxToken, run.runId, 0);
      await waitForSendCount(sends, sendCount + 1);
      await ap.postAgentPhoneInboundMessage(message);
      await runs.heartbeatRunner(runnerGroup);
      expect((await runs.pollRunner(runnerGroup)).body.job).toBeNull();
      expect(sends.messages).toHaveLength(sendCount + 1);
    },
  );

  it("retains an unarchived group receipt across replay and later linking", async () => {
    const bdd = createBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);
    const message = {
      channel: "imessage" as const,
      from: phone,
      body: "@Okou please connect",
      messageId: `ap-no-recipients-${randomUUID()}`,
      webhookId: `evt-no-recipients-${randomUUID()}`,
      conversationId,
      groupId,
      isGroup: true,
      participants: [{ identifier: phone }],
      receivedAt: new Date(now()).toISOString(),
    };
    await Promise.all([
      ap.postAgentPhoneInboundMessage(message),
      ap.postAgentPhoneInboundMessage(message),
    ]);
    expect(sends.messages).toHaveLength(2);
    expect(sends.messages[0]).toMatchObject({
      toNumber: phone,
      body: expect.stringContaining("/settings/agentphone?"),
    });
    expect(sends.messages[0]?.replyToMessageId).toBeUndefined();
    expect(sends.messages[1]).toMatchObject({
      toNumber: groupId,
      replyToMessageId: message.messageId,
    });
    await ap.linkViaWebhookConnectPrompt(actor, phone, sends);
    const sendCount = sends.messages.length;
    await ap.postAgentPhoneInboundMessage(message);
    await ap.postAgentPhoneInboundMessage({
      ...message,
      messageId: `${message.messageId}-replay`,
    });
    expect(sends.messages).toHaveLength(sendCount);
    const history = await integrations.requestAgentPhoneGroupHistory(
      actor,
      { groupId, limit: 100 },
      [200],
    );
    expect(history.status === 200 ? history.body.messages : []).toHaveLength(0);
  });

  it("imports phone media into canonical storage and preserves its message text", async () => {
    const ap = createAgentPhoneBddApi(context);
    const { actor, phone, runnerGroup } = await entitledLinkedActor();
    const uploads = captureIntegrationInputUploads(context);
    const bytes = Buffer.from("phone image bytes");
    const mediaUrl = "https://media.agentphone.test/canonical-photo.png";
    let downloads = 0;
    server.use(
      http.get(mediaUrl, () => {
        downloads += 1;
        return new HttpResponse(bytes, {
          headers: { "content-type": "image/png" },
        });
      }),
    );
    const messageId = await ap.postAgentPhoneInboundMessage({
      channel: "mms",
      from: phone,
      body: "inspect imported photo",
      mediaUrl,
    });
    const run = await claimDispatchedRun(runnerGroup);
    expect(run.prompt).toContain(
      "inspect imported photo\n\n[Web file] canonical-photo.png (image/png)",
    );
    expect(run.prompt).not.toContain(mediaUrl);
    const fileId = run.prompt.match(/ {3}\[ID\] ([^\n]+)/u)?.[1];
    if (!fileId) {
      throw new Error("Expected canonical phone file id");
    }
    expect(fileId).not.toBe(messageId);
    await expectIntegrationInputPreview(context, {
      actor,
      fileId,
      bytes,
      contentType: "image/png",
      uploads,
      okouToken: run.okouToken,
    });
    expect(downloads).toBe(1);
    await completeSandboxRun(run.sandboxToken, run.runId, 0);
    await ap.postAgentPhoneInboundMessage({
      channel: "mms",
      from: phone,
      body: "inspect the same photo again",
      mediaUrl,
    });
    const nextRun = await claimDispatchedRun(runnerGroup);
    expect(nextRun.prompt).toContain(`[ID] ${fileId}`);
    expect(downloads).toBe(1);
    expect(uploads).toHaveLength(1);
    await expect(
      listIntegrationInputFileParts(context, actor),
    ).resolves.toStrictEqual([
      expect.objectContaining({ fileId }),
      expect.objectContaining({ fileId }),
    ]);
    await completeSandboxRun(nextRun.sandboxToken, nextRun.runId, 0);
  });

  it.each([
    "https://media.agentphone.test/media-only.png",
    "https://api.agentphone.ai/v1/messages/apmsg_inbound/media",
  ])("downloads inbound media from %s", async (mediaUrl) => {
    const ap = createAgentPhoneBddApi(context);
    const { phone, runnerGroup } = await entitledLinkedActor();
    let available = false;
    server.use(
      http.get(mediaUrl, () => {
        return available
          ? new HttpResponse("incoming bytes", {
              headers: { "content-type": "image/png" },
            })
          : new HttpResponse(null, { status: 503 });
      }),
    );
    const messageId = await ap.postAgentPhoneInboundMessage({
      channel: "mms",
      from: phone,
      body: "",
      mediaUrl,
    });
    const run = await claimDispatchedRun(runnerGroup);
    expect(run.prompt).toContain("[Phone file]");
    if (!run.okouToken) {
      throw new Error("Expected a claim-issued Okou token");
    }
    available = true;
    const downloaded = await ap.downloadPhoneFileRaw(run.okouToken, messageId);
    expect(downloaded.status).toBe(200);
    expect(downloaded.text).toBe("incoming bytes");
    await completeSandboxRun(run.sandboxToken, run.runId, 0);
  });

  it("renders media prompts", async () => {
    const ap = createAgentPhoneBddApi(context);
    const { actor, phone, runnerGroup } = await entitledLinkedActor();

    server.use(
      http.get(
        "https://media.agentphone.test/photo%20one%2Bfinal%2zraw.png",
        () => {
          return new HttpResponse(null, { status: 503 });
        },
      ),
    );
    // A failed import retains the provider reference and its original filename.
    const mediaMessageId = await ap.postAgentPhoneInboundMessage({
      channel: "mms",
      from: phone,
      body: "what is in this photo",
      mediaUrl: "https://media.agentphone.test/photo%20one%2Bfinal%2zraw.png",
    });
    const run1 = await claimDispatchedRun(runnerGroup);
    expect(run1.prompt).toBe(
      [
        "what is in this photo",
        `[Phone file] photo one+final%2zraw.png (image/png)\n   [ID] ${mediaMessageId}`,
      ].join("\n\n"),
    );
    await expect(
      listIntegrationInputFileParts(context, actor),
    ).resolves.toStrictEqual([
      expect.objectContaining({
        fileId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        filenameSnapshot: "photo one+final%2zraw.png",
      }),
    ]);
    await completeSandboxRun(run1.sandboxToken, run1.runId, 0);
  });

  it("renders provider recent history", async () => {
    const ap = createAgentPhoneBddApi(context);
    const { phone, runnerGroup } = await entitledLinkedActor();

    // Provider-sent recent history wins over stored context: full entries
    // keep channel and timestamp lines, media-only entries become file
    // placeholders, junk entries are dropped.
    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "compare with history",
      recentHistory: [
        {
          messageId: "rh-full",
          content: "prior context from provider",
          direction: "inbound",
          channel: "sms",
          from: phone,
          at: "2026-06-01T08:00:00.000Z",
        },
        { media_url: "https://media.agentphone.test/history-photo.png" },
        { direction: "inbound" },
      ],
    });
    const run = await claimDispatchedRun(runnerGroup);
    expect(run.appendSystemPrompt).toContain("# Phone Message Context");
    expect(run.appendSystemPrompt).toContain("MSG_ID: rh-full");
    expect(run.appendSystemPrompt).toContain("prior context from provider");
    expect(run.appendSystemPrompt).toContain("CHANNEL: sms");
    expect(run.appendSystemPrompt).toContain("AT: 2026-06-01T08:00:00.000Z");
    expect(run.appendSystemPrompt).toContain(
      "[Phone file] https://media.agentphone.test/history-photo.png",
    );
    expect(
      run.appendSystemPrompt.match(/- RELATIVE_INDEX:/gu) ?? [],
    ).toHaveLength(2);
    await completeSandboxRun(run.sandboxToken, run.runId, 0);
  });

  it("answers help, connect, disconnect, and switch commands over SMS", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);

    const actor = bdd.user();
    context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
      id: actor.orgId,
      name: "Operations workspace",
    });
    bdd.acceptAgentStorageWrites();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();
    await runs.grantProEntitlement(actor);
    await runs.ensurePersonalSubscriptionModel(actor);
    const phone = uniquePhoneHandle();
    await ap.linkViaWebhookConnectPrompt(actor, phone, sends);
    const welcome = sends.messages.slice(-3);
    expectConnectedWelcome(welcome);

    const SMS_RISK_WARNING =
      "Note: SMS and MMS replies may not be delivered reliably.";

    async function commandReply(body: string): Promise<string> {
      const before = sends.messages.length;
      await ap.postAgentPhoneInboundMessage({
        channel: "sms",
        from: phone,
        body,
      });
      await waitForSendCount(sends, before + 1);
      const reply = lastSend(sends).body ?? "";
      return reply;
    }

    const help = await commandReply("/help");
    expect(help).toContain("Okou text message commands");
    expect(help).toContain("/connect - Connect this phone number to Okou");
    expect(help).toContain("/help - Show these commands");
    expect(help).toContain(
      "/disconnect - Disconnect this phone number from Okou",
    );
    expect(help).toContain(
      "/switch - Switch to a different Okou account or workspace",
    );
    expect(help).toContain(SMS_RISK_WARNING);

    const alreadyConnected = await commandReply("/connect");
    expect(alreadyConnected).toContain("You are already connected");
    expect(alreadyConnected).toContain('workspace "Operations workspace"');
    expect(alreadyConnected).toContain("/switch");
    expect(alreadyConnected).toContain("start using Okou");
    expect(alreadyConnected).toContain(SMS_RISK_WARNING);

    const disconnected = await commandReply("/disconnect");
    expect(disconnected).toContain(
      "This phone number has been disconnected from Okou.",
    );
    const unlinkedStatus = await integrations.getAgentPhoneLinkStatus(actor);
    expect(unlinkedStatus.linked).toBeFalsy();

    const disconnectAgain = await commandReply("/disconnect");
    expect(disconnectAgain).toContain(
      "Error: This phone number is not connected.",
    );

    const switchPrompt = await commandReply("/switch");
    expect(switchPrompt).toContain("Open this link to connect");
    expect(switchPrompt).toContain("/settings/agentphone?");
    expect(switchPrompt).toContain(SMS_RISK_WARNING);

    const plainPromptUnlinked = await commandReply("hello again");
    expect(plainPromptUnlinked).toContain(
      "Click the link below to start using Okou.",
    );
    expect(plainPromptUnlinked).not.toContain("AgentPhone");
    expect(plainPromptUnlinked).toContain("/settings/agentphone?");
    expect(plainPromptUnlinked).not.toContain(SMS_RISK_WARNING);
  });

  it("archives an outbound group reply once with the original recipients across concurrent provider-id replays", async () => {
    const bdd = createBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();
    const sender = bdd.user();
    const recipient = bdd.user();
    const laterRecipient = bdd.user();
    const senderPhone = uniquePhoneHandle();
    const recipientPhone = uniquePhoneHandle();
    const laterPhone = uniquePhoneHandle();
    await ap.linkViaWebhookConnectPrompt(sender, senderPhone, sends);
    await ap.linkViaWebhookConnectPrompt(recipient, recipientPhone, sends);
    await ap.linkViaWebhookConnectPrompt(laterRecipient, laterPhone, sends);

    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);
    let providerId = `ap-outbound-${randomUUID()}`;
    let roster = [
      senderPhone,
      recipientPhone,
      recipientPhone,
      "invalid-handle",
    ];
    const requests: unknown[] = [];
    server.use(
      http.get("https://api.agentphone.test/v1/conversations/:id", () => {
        return HttpResponse.json({ participants: roster });
      }),
      http.post(
        "https://api.agentphone.test/v1/messages",
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer agentphone-bdd-key",
          );
          const body: unknown = await request.json();
          requests.push(body);
          return HttpResponse.json({
            id: providerId,
            channel: "imessage",
            to_number: groupId,
          });
        },
      ),
    );
    mockNow(now());
    const sentAt = new Date(now()).toISOString();
    async function sendHelp() {
      return await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: senderPhone,
        body: "/help @Okou",
        conversationId,
        isGroup: true,
        participants: [{ identifier: senderPhone }],
      });
    }
    await sendHelp();
    await flushWaitUntilForTest();

    async function outbound(actor: ApiTestUser) {
      const history = await integrations.requestAgentPhoneGroupHistory(
        actor,
        { groupId, limit: 100 },
        [200],
      );
      if (history.status !== 200) {
        throw new Error("Expected the member's phone group history");
      }
      return history.body.messages.filter((message) => {
        return message.direction === "outbound";
      });
    }
    const archived = await outbound(sender);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({
      id: providerId,
      conversationId,
      fromNumber: AGENTPHONE_BDD_PHONE_NUMBER,
      toNumber: groupId,
      channel: "imessage",
      mediaUrl: null,
      receivedAt: sentAt,
    });
    await expect(outbound(recipient)).resolves.toStrictEqual(archived);
    await expect(outbound(laterRecipient)).resolves.toStrictEqual([]);
    await expect(
      outbound({ ...recipient, orgId: `org_${randomUUID()}` }),
    ).resolves.toStrictEqual([]);

    roster = [senderPhone, laterPhone];
    await Promise.all([sendHelp(), sendHelp()]);
    await flushWaitUntilForTest();
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request).toMatchObject({
        agent_id: AGENTPHONE_BDD_AGENT_ID,
        to_number: groupId,
        reply_to_message_id: expect.any(String),
        body: expect.stringContaining("/help"),
      });
    }
    await expect(outbound(sender)).resolves.toStrictEqual(archived);
    await expect(outbound(recipient)).resolves.toStrictEqual(archived);
    await expect(outbound(laterRecipient)).resolves.toStrictEqual([]);

    mockNow(now() + 1000);
    providerId = `ap-outbound-fresh-${randomUUID()}`;
    await Promise.all([sendHelp(), sendHelp()]);
    await flushWaitUntilForTest();
    const newlyArchived = await outbound(laterRecipient);
    expect(newlyArchived).toHaveLength(1);
    expect(newlyArchived[0]).toMatchObject({
      id: providerId,
      toNumber: groupId,
      channel: "imessage",
    });
    await expect(outbound(sender)).resolves.toStrictEqual([
      ...archived,
      ...newlyArchived,
    ]);
    await expect(outbound(recipient)).resolves.toStrictEqual(archived);
    expect(requests).toHaveLength(5);
  });

  it("limits archived group history to linked participants captured for each message", async () => {
    await runFiniteAgentPhoneHistory(async () => {
      const bdd = createBddApi(context);
      const integrations = createBddIntegrationApi(context);
      const ap = createAgentPhoneBddApi(context);
      integrations.configureAgentPhoneProvider();
      integrations.configureAgentPhoneWebhook();
      const sends = ap.captureAgentPhoneSends();

      const first = bdd.user();
      const second = bdd.user();
      const linkedLater = bdd.user();
      await bdd.readMe(first);
      const firstPhone = uniquePhoneHandle();
      const secondPhone = uniquePhoneHandle();
      const laterPhone = uniquePhoneHandle();
      await ap.linkViaWebhookConnectPrompt(first, firstPhone, sends);
      await ap.linkViaWebhookConnectPrompt(second, secondPhone, sends);

      const conversationId = uniqueConversationId();
      const stableGroupId = bddGroupId(conversationId);

      const senderOnlyConversationId = uniqueConversationId();
      const senderOnlyMessageId = `ap-group-history-sender-only-${randomUUID()}`;
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: firstPhone,
        body: "sender is present even when the provider omits the roster",
        messageId: senderOnlyMessageId,
        conversationId: senderOnlyConversationId,
        isGroup: true,
      });
      const senderOnlyHistory =
        await integrations.requestAgentPhoneGroupHistory(
          first,
          { groupId: bddGroupId(senderOnlyConversationId), limit: 100 },
          [200],
        );
      expect(
        senderOnlyHistory.status === 200 ? senderOnlyHistory.body.messages : [],
      ).toMatchObject([{ id: senderOnlyMessageId }]);

      const missingTimestampConversationId = uniqueConversationId();
      const missingTimestampMessageId = `ap-group-history-missing-time-${randomUUID()}`;
      await ap.postAgentPhoneInboundMessage(
        {
          channel: "imessage",
          from: firstPhone,
          body: "group event without provider message time",
          messageId: missingTimestampMessageId,
          conversationId: missingTimestampConversationId,
          isGroup: true,
          participants: [{ identifier: firstPhone }],
          receivedAt: null,
        },
        [500],
      );
      const missingTimestampHistory =
        await integrations.requestAgentPhoneGroupHistory(
          first,
          {
            groupId: bddGroupId(missingTimestampConversationId),
            limit: 100,
          },
          [200],
        );
      expect(
        missingTimestampHistory.status === 200
          ? missingTimestampHistory.body.messages
          : [],
      ).toHaveLength(0);

      const noMatchConversationId = uniqueConversationId();
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: laterPhone,
        body: "not archived before linking",
        conversationId: noMatchConversationId,
        isGroup: true,
        participants: [{ identifier: laterPhone }],
      });

      const firstMessageId = `ap-group-history-first-${randomUUID()}`;
      const groupMediaUrl = "https://files.agentphone.test/group-photo.png";
      const participants = [
        { identifier: firstPhone },
        { identifier: secondPhone },
        { identifier: laterPhone },
      ];
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: firstPhone,
        body: "first group note",
        messageId: firstMessageId,
        conversationId,
        isGroup: true,
        participants,
        mediaUrl: groupMediaUrl,
      });

      const beforeLaterLink = new Date(now()).toISOString();
      mockNow(now() + 1000);
      await ap.linkViaWebhookConnectPrompt(linkedLater, laterPhone, sends);
      const delayedMessageId = `ap-group-history-delayed-${randomUUID()}`;
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: firstPhone,
        body: "delivered after linking but sent before it",
        messageId: delayedMessageId,
        webhookId: null,
        conversationId,
        isGroup: true,
        participants,
        receivedAt: beforeLaterLink,
      });
      const noMatchHistory = await integrations.requestAgentPhoneGroupHistory(
        linkedLater,
        { groupId: bddGroupId(noMatchConversationId), limit: 100 },
        [200],
      );
      expect(
        noMatchHistory.status === 200 ? noMatchHistory.body.messages : [],
      ).toHaveLength(0);
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: firstPhone,
        body: "first group note",
        messageId: firstMessageId,
        conversationId,
        isGroup: true,
        participants,
      });
      const secondMessageId = `ap-group-history-second-${randomUUID()}`;
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: firstPhone,
        body: "second group note",
        messageId: secondMessageId,
        conversationId,
        isGroup: true,
        participants: [{ identifier: firstPhone }, { identifier: laterPhone }],
      });

      async function visibleIds(actor: ApiTestUser) {
        const result = await integrations.requestAgentPhoneGroupHistory(
          actor,
          { groupId: stableGroupId, limit: 100 },
          [200],
        );
        if (result.status !== 200) {
          throw new Error("Expected visible iMessage group history");
        }
        return result.body.messages.map((message) => {
          return message.id;
        });
      }

      await expect(visibleIds(first)).resolves.toStrictEqual([
        firstMessageId,
        delayedMessageId,
        secondMessageId,
      ]);
      await expect(visibleIds(second)).resolves.toStrictEqual([
        firstMessageId,
        delayedMessageId,
      ]);
      await expect(visibleIds(linkedLater)).resolves.toStrictEqual([
        secondMessageId,
      ]);

      server.use(
        http.get(groupMediaUrl, () => {
          return new HttpResponse("group-photo-bytes", {
            headers: { "content-type": "image/png" },
          });
        }),
      );
      const visibleGroupFile = await integrations.requestPhoneDownloadFile(
        second,
        firstMessageId,
        [200],
      );
      expect(visibleGroupFile.status).toBe(200);
      const invisibleGroupFile = await integrations.requestPhoneDownloadFile(
        linkedLater,
        firstMessageId,
        [404],
      );
      expect(invisibleGroupFile.status).toBe(404);

      const filtered = await integrations.requestAgentPhoneGroupHistory(
        first,
        { groupId: stableGroupId, query: "second", limit: 100 },
        [200],
      );
      expect(
        filtered.status === 200 ? filtered.body.messages : [],
      ).toMatchObject([{ id: secondMessageId }]);

      const firstPage = await integrations.requestAgentPhoneGroupHistory(
        first,
        { groupId: stableGroupId, limit: 1 },
        [200],
      );
      if (firstPage.status !== 200) {
        throw new Error("Expected first group history page");
      }
      expect(firstPage.body.hasMore).toBeTruthy();
      expect(firstPage.body.nextCursor).toBeTruthy();
      const secondPage = await integrations.requestAgentPhoneGroupHistory(
        first,
        {
          groupId: stableGroupId,
          limit: 1,
          cursor: firstPage.body.nextCursor ?? undefined,
        },
        [200],
      );
      expect(
        secondPage.status === 200 ? secondPage.body.messages : [],
      ).toMatchObject([{ id: delayedMessageId }]);
    });
  });

  it("returns 500 and does not dispatch group webhooks without a timestamp", async () => {
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();
    const message = {
      channel: "imessage" as const,
      from: uniquePhoneHandle(),
      body: "@Okou please help me connect",
      messageId: `ap-group-no-timestamp-${randomUUID()}`,
      conversationId: uniqueConversationId(),
      isGroup: true,
      receivedAt: null,
    };

    await ap.postAgentPhoneInboundMessage(message, [500]);
    await ap.postAgentPhoneInboundMessage(message, [500]);
    await ap.postAgentPhoneInboundMessage(
      {
        ...message,
        messageId: `ap-group-invalid-time-${randomUUID()}`,
        receivedAt: "October 1, 2026",
      },
      [500],
    );

    const aliasConversationId = uniqueConversationId();
    const aliasSender = uniquePhoneHandle();
    const alternateTimestampEvent = JSON.stringify({
      event: "agent.message",
      channel: "imessage",
      agentId: AGENTPHONE_BDD_AGENT_ID,
      data: {
        messageId: `ap-group-alias-time-${randomUUID()}`,
        from: aliasSender,
        senderIdentifier: aliasSender,
        to: AGENTPHONE_BDD_PHONE_NUMBER,
        message: "unsupported timestamp alias",
        conversationId: aliasConversationId,
        group: {
          isGroup: true,
          groupId: bddGroupId(aliasConversationId),
          participants: [{ identifier: aliasSender }],
        },
        received_at: new Date(now()).toISOString(),
      },
    });
    const alternateTimestamp = await ap.postRawAgentPhoneInboundWebhook(
      alternateTimestampEvent,
      [500],
    );
    expect(alternateTimestamp.body).toBe(
      "iMessage group webhook is missing receivedAt",
    );
    expect(sends.messages).toHaveLength(0);
  });

  it("acks AgentPhone's documented idless test webhook without processing it", async () => {
    const runs = createRunsApi(context);
    const { ap, phone, runnerGroup, sends } = await entitledLinkedActor();
    const sendsBefore = sends.messages.length;
    const timestamp = new Date(now()).toISOString();
    const testWebhook = JSON.stringify({
      event: "agent.message",
      channel: "sms",
      timestamp,
      agentId: AGENTPHONE_BDD_AGENT_ID,
      data: {
        conversationId: uniqueConversationId(),
        numberId: "num_bdd_test",
        from: phone,
        to: AGENTPHONE_BDD_PHONE_NUMBER,
        message: "Test message",
        direction: "inbound",
        receivedAt: timestamp,
      },
      conversationState: { testMode: true },
      recentHistory: [
        {
          content: "Earlier test message",
          direction: "inbound",
          channel: "sms",
          at: timestamp,
        },
      ],
    });

    const response = await ap.postRawAgentPhoneInboundWebhook(
      testWebhook,
      [200],
    );
    expect(response.body).toBe("OK");
    await runs.heartbeatRunner(runnerGroup);
    expect((await runs.pollRunner(runnerGroup)).body.job).toBeNull();
    expect(sends.messages).toHaveLength(sendsBefore);
  });

  it("processes iMessage webhooks with messageId even when testMode is set", async () => {
    const { ap, phone, runnerGroup, sends } = await entitledLinkedActor();
    const messageId = `ap-msg-test-mode-${randomUUID()}`;
    const response = await ap.postRawAgentPhoneInboundWebhook(
      JSON.stringify({
        event: "agent.message",
        channel: "imessage",
        agentId: AGENTPHONE_BDD_AGENT_ID,
        timestamp: new Date(now()).toISOString(),
        data: {
          messageId,
          conversationId: uniqueConversationId(),
          from: phone,
          to: AGENTPHONE_BDD_PHONE_NUMBER,
          message: "process this identified message",
          direction: "inbound",
          receivedAt: new Date(now()).toISOString(),
        },
        conversationState: { testMode: true },
      }),
      [200],
    );
    expect(response.body).toBe("OK");
    const run = await claimDispatchedRun(runnerGroup);
    expect(run.prompt).toBe("process this identified message");
    const sendsBeforeCompletion = sends.messages.length;
    await completeSandboxRun(run.sandboxToken, run.runId, 0);
    await waitForSendCount(sends, sendsBeforeCompletion + 1);
    expect(lastSend(sends)).toMatchObject({
      toNumber: phone,
      replyToMessageId: messageId,
      body: "Task completed successfully.",
    });
  });

  it("returns 500 for direct message webhooks without provider message ids", async () => {
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();

    for (const channel of ["imessage", "sms"] as const) {
      await ap.postAgentPhoneInboundMessage(
        {
          channel,
          from: uniquePhoneHandle(),
          body: "@Okou please help me connect",
          messageId: null,
          conversationId: uniqueConversationId(),
        },
        [500],
      );
    }
    expect(sends.messages).toHaveLength(0);
  });

  it("returns 500 for direct messages with an invalid sender", async () => {
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    integrations.configureAgentPhoneWebhook();
    const invalidSenderEvent = JSON.stringify({
      event: "agent.message",
      channel: "sms",
      agentId: AGENTPHONE_BDD_AGENT_ID,
      data: {
        messageId: `ap-invalid-sender-${randomUUID()}`,
        from: "not-a-phone-number",
        to: AGENTPHONE_BDD_PHONE_NUMBER,
        message: "this sender cannot be routed safely",
      },
    });

    const response = await ap.postRawAgentPhoneInboundWebhook(
      invalidSenderEvent,
      [500],
    );
    expect(response.body).toBe(
      "AgentPhone message webhook has an invalid sender",
    );
  });

  it("returns 500 for group webhooks without stable provider identities", async () => {
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();
    const baseMessage = {
      channel: "imessage" as const,
      from: uniquePhoneHandle(),
      body: "@Okou please help me connect",
      conversationId: uniqueConversationId(),
      isGroup: true,
    };

    await ap.postAgentPhoneInboundMessage(
      { ...baseMessage, messageId: null },
      [500],
    );
    await ap.postAgentPhoneInboundMessage(
      {
        ...baseMessage,
        messageId: `ap-group-no-id-${randomUUID()}`,
        groupId: null,
      },
      [500],
    );
    await ap.postAgentPhoneInboundMessage(
      {
        channel: baseMessage.channel,
        from: baseMessage.from,
        body: baseMessage.body,
        messageId: `ap-group-no-conversation-${randomUUID()}`,
        isGroup: true,
      },
      [500],
    );
    await ap.postAgentPhoneInboundMessage(
      {
        ...baseMessage,
        messageId: `ap-group-no-sender-${randomUUID()}`,
        senderIdentifier: null,
      },
      [500],
    );
    await ap.postAgentPhoneInboundMessage(
      {
        ...baseMessage,
        messageId: `ap-group-invalid-id-${randomUUID()}`,
        groupId: "not-a-provider-group-id",
      },
      [500],
    );

    expect(sends.messages).toHaveLength(0);
  });

  it("delivers a group run reply when the provider roster lookup fails", async () => {
    const integrations = createBddIntegrationApi(context);
    const { actor, phone, runnerGroup, sends, ap } =
      await entitledLinkedActor();

    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "@Okou summarize this group",
      conversationId,
      isGroup: true,
      participants: [{ identifier: phone }],
    });
    await waitForTyping(sends, [conversationId]);
    const run = await claimDispatchedRun(runnerGroup);
    expect(run.appendSystemPrompt).toContain(`Group ID: ${groupId}`);

    server.use(
      http.get("https://api.agentphone.test/v1/conversations/:id", () => {
        return HttpResponse.json(
          { detail: "temporary failure" },
          {
            status: 503,
          },
        );
      }),
    );
    const beforeCompletion = sends.messages.length;
    await completeSandboxRun(run.sandboxToken, run.runId, 0);
    await waitForSendCount(sends, beforeCompletion + 1);
    expect(lastSend(sends).toNumber).toBe(groupId);

    const history = await integrations.requestAgentPhoneGroupHistory(
      actor,
      { groupId, limit: 100 },
      [200],
    );
    if (history.status !== 200) {
      throw new Error("Expected visible group history after the run reply");
    }
    expect(
      history.body.messages.map((message) => {
        return message.direction;
      }),
    ).toStrictEqual(["inbound"]);
  });

  it("sends group connect replies when roster lookup fails and never archives them", async () => {
    const integrations = createBddIntegrationApi(context);
    const { actor, phone, sends, ap } = await entitledLinkedActor();

    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);
    const unlinkedPhone = uniquePhoneHandle();
    const participants = [{ identifier: phone }, { identifier: unlinkedPhone }];
    const before = sends.messages.length;
    server.use(
      http.get("https://api.agentphone.test/v1/conversations/:id", () => {
        return HttpResponse.json(
          { detail: "temporary failure" },
          {
            status: 503,
          },
        );
      }),
    );
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: unlinkedPhone,
      body: "@Okou please connect this group",
      conversationId,
      isGroup: true,
      participants,
    });
    await waitForSendCount(sends, before + 2);

    server.use(
      http.get("https://api.agentphone.test/v1/conversations/:id", () => {
        return HttpResponse.json(null);
      }),
    );
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: unlinkedPhone,
      body: "@Okou retry the malformed roster response",
      conversationId,
      isGroup: true,
      participants,
    });
    await waitForSendCount(sends, before + 4);

    const history = await integrations.requestAgentPhoneGroupHistory(
      actor,
      { groupId, limit: 100 },
      [200],
    );
    if (history.status !== 200) {
      throw new Error("Expected visible group history after roster failures");
    }
    expect(
      history.body.messages.map((message) => {
        return message.direction;
      }),
    ).toStrictEqual(["inbound", "inbound"]);
  });

  it("rejects group webhooks without a conversation identity before creating a run", async () => {
    const runs = createRunsApi(context);
    const integrations = createBddIntegrationApi(context);
    const { actor, phone, runnerGroup, sends, ap } =
      await entitledLinkedActor();

    const groupIds = [
      bddGroupId(uniqueConversationId()),
      bddGroupId(uniqueConversationId()),
    ];
    const sendsBefore = sends.messages.length;
    for (const [index, groupId] of groupIds.entries()) {
      await ap.postAgentPhoneInboundMessage(
        {
          channel: "imessage",
          from: phone,
          body: `@Okou keep group ${index} isolated`,
          messageId: `missing-conversation-${index}-${randomUUID()}`,
          groupId,
          isGroup: true,
          participants: [{ identifier: phone }],
        },
        [500],
      );
    }

    await runs.heartbeatRunner(runnerGroup);
    expect((await runs.pollRunner(runnerGroup)).body.job).toBeNull();
    expect(sends.messages).toHaveLength(sendsBefore);
    for (const groupId of groupIds) {
      const history = await integrations.requestAgentPhoneGroupHistory(
        actor,
        { groupId, limit: 100 },
        [200],
      );
      if (history.status !== 200) {
        throw new Error("Expected empty history for an unrouteable group");
      }
      expect(history.body.messages).toHaveLength(0);
    }
  });

  it("shares a main thread per iMessage group and forks persistent reply threads", async () => {
    const { actor, phone, runnerGroup, sends, ap } =
      await entitledLinkedActor();
    const chat = createChatFilesBddApi(context);
    const conversationId = uniqueConversationId();
    const rootPrompt = "@Okou plan the launch";
    const rootMessageId = await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: rootPrompt,
      conversationId,
      isGroup: true,
    });
    const first = await claimDispatchedRun(runnerGroup);
    await completeSandboxRun(first.sandboxToken, first.runId, 0);
    await flushWaitUntilForTest();
    const mainAnswerMessageId = lastSend(sends).messageId;
    const mainSession = await waitForRunSessionIdPresent(actor, first.runId);

    const followUpPrompt = "@Okou review the budget too";
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: followUpPrompt,
      conversationId,
      isGroup: true,
    });
    const followUp = await claimDispatchedRun(runnerGroup);
    expect(followUp.resumedSessionId).toBe(mainSession);
    await completeSandboxRun(followUp.sandboxToken, followUp.runId, 0);
    await waitForRunSessionId(actor, followUp.runId, mainSession);

    const branchPrompt = "@Okou add a launch date";
    const branchMessageId = await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: branchPrompt,
      conversationId,
      isGroup: true,
      replyToMessageId: rootMessageId,
    });
    const branch = await claimDispatchedRun(runnerGroup);
    expect(branch.resumedSessionId).toBeUndefined();
    await completeSandboxRun(branch.sandboxToken, branch.runId, 0);
    await flushWaitUntilForTest();
    const branchAnswerMessageId = lastSend(sends).messageId;
    const branchSession = await waitForRunSessionIdPresent(actor, branch.runId);
    expect(branchSession).not.toBe(mainSession);

    const replyPrompts = [
      { body: "@Okou move that date one week later", parent: branchMessageId },
      { body: "@Okou expand your answer", parent: branchAnswerMessageId },
      { body: "@Okou list launch risks", parent: rootMessageId },
    ];
    for (const { body, parent } of replyPrompts) {
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body,
        conversationId,
        isGroup: true,
        replyToMessageId: parent,
      });
      const reply = await claimDispatchedRun(runnerGroup);
      expect(reply.resumedSessionId).toBe(branchSession);
      await completeSandboxRun(reply.sandboxToken, reply.runId, 0);
      await waitForRunSessionId(actor, reply.runId, branchSession);
    }

    const returnPrompt = "@Okou back to the group discussion";
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: returnPrompt,
      conversationId,
      isGroup: true,
    });
    const returned = await claimDispatchedRun(runnerGroup);
    expect(returned.resumedSessionId).toBe(mainSession);
    await completeSandboxRun(returned.sandboxToken, returned.runId, 0);
    await waitForRunSessionId(actor, returned.runId, mainSession);

    const botReplyPrompt = "@Okou discuss your first answer separately";
    const otherGroupPrompt = "@Okou discuss another group's plan";
    for (const message of [
      {
        body: botReplyPrompt,
        conversationId,
        replyToMessageId: mainAnswerMessageId,
      },
      { body: otherGroupPrompt, conversationId: uniqueConversationId() },
    ]) {
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        isGroup: true,
        ...message,
      });
      const run = await claimDispatchedRun(runnerGroup);
      expect(run.resumedSessionId).toBeUndefined();
      await completeSandboxRun(run.sandboxToken, run.runId, 0);
      const session = await waitForRunSessionIdPresent(actor, run.runId);
      expect(session).not.toBe(mainSession);
      expect(session).not.toBe(branchSession);
    }

    const lifecycle = await chat.requestThreadEvents(actor, {}, [200]);
    if (lifecycle.status !== 200) {
      throw new Error("Expected iMessage group threads to be listed");
    }
    const threads = lifecycle.body.events.filter((event) => {
      return event.kind === "created";
    });
    expect(threads).toHaveLength(4);
    const threadPrompts = await Promise.all(
      threads.map(async (thread) => {
        const history = await chat.listThreadEvents(actor, thread.chatThreadId);
        return history.events
          .filter((event) => {
            return event.eventType === "input.prompt";
          })
          .filter((event) => {
            return event.runId !== undefined;
          })
          .flatMap((event) => {
            return event.userMessage.parts;
          })
          .flatMap((part) => {
            return part.type === "text" ? [part.text] : [];
          });
      }),
    );
    expect(threadPrompts).toStrictEqual(
      expect.arrayContaining([
        [rootPrompt, followUpPrompt, returnPrompt],
        [
          branchPrompt,
          ...replyPrompts.map((reply) => {
            return reply.body;
          }),
        ],
        [botReplyPrompt],
        [otherGroupPrompt],
      ]),
    );
  });

  it("anchors iMessage group replies to an ambient message without an existing web thread", async () => {
    const { actor, phone, runnerGroup, ap } = await entitledLinkedActor();
    const chat = createChatFilesBddApi(context);
    const conversationId = uniqueConversationId();
    const ambientMessageId = await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "The launch is scheduled for Friday",
      conversationId,
      isGroup: true,
    });
    let sessionId: string | undefined;
    for (const body of ["@Okou summarize this plan", "@Okou list the risks"]) {
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body,
        conversationId,
        isGroup: true,
        replyToMessageId: ambientMessageId,
      });
      const run = await claimDispatchedRun(runnerGroup);
      expect(run.resumedSessionId).toBe(sessionId);
      await completeSandboxRun(run.sandboxToken, run.runId, 0);
      sessionId = await waitForRunSessionIdPresent(actor, run.runId);
    }
    const lifecycle = await chat.requestThreadEvents(actor, {}, [200]);
    if (lifecycle.status !== 200) {
      throw new Error(
        "Expected the ambient message's reply thread to be listed",
      );
    }
    expect(
      lifecycle.body.events.filter((event) => {
        return event.kind === "created";
      }),
    ).toHaveLength(1);
  });

  it("scopes iMessage reply routing to the linked sender and group conversation", async () => {
    const owner = await entitledLinkedActor();
    const conversationId = uniqueConversationId();
    const rootMessageId = await owner.ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: owner.phone,
      body: "@Okou keep this owner's thread",
      conversationId,
      isGroup: true,
    });
    const ownerRun = await claimDispatchedRun(owner.runnerGroup);
    await completeSandboxRun(ownerRun.sandboxToken, ownerRun.runId, 0);
    const ownerSession = await waitForRunSessionIdPresent(
      owner.actor,
      ownerRun.runId,
    );

    const member = await entitledLinkedActor();
    for (const { linked, conversation } of [
      { linked: member, conversation: conversationId },
      { linked: owner, conversation: uniqueConversationId() },
    ]) {
      await linked.ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: linked.phone,
        body: "@Okou start my own discussion",
        conversationId: conversation,
        isGroup: true,
        replyToMessageId: rootMessageId,
      });
      const run = await claimDispatchedRun(member.runnerGroup);
      expect(run.resumedSessionId).toBeUndefined();
      await completeSandboxRun(run.sandboxToken, run.runId, 0);
      const session = await waitForRunSessionIdPresent(linked.actor, run.runId);
      expect(session).not.toBe(ownerSession);
    }
    const chat = createChatFilesBddApi(context);
    for (const { linked, count } of [
      { linked: owner, count: 2 },
      { linked: member, count: 1 },
    ]) {
      const lifecycle = await chat.requestThreadEvents(linked.actor, {}, [200]);
      if (lifecycle.status !== 200) {
        throw new Error(
          "Expected the linked sender's own threads to be listed",
        );
      }
      expect(
        lifecycle.body.events.filter((event) => {
          return event.kind === "created";
        }),
      ).toHaveLength(count);
    }
  });

  it("handles the iMessage group lifecycle: mentions, stored context, ambient silence, and account-command guards", async () => {
    const runs = createRunsApi(context);
    const integrations = createBddIntegrationApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, phone, runnerGroup, sends, ap } =
      await entitledLinkedActor();
    const conversationId = `${uniqueConversationId()}-${"g".repeat(230)}`;
    expect(conversationId.length).toBeLessThanOrEqual(255);
    expect(`group:${conversationId}`.length).toBeGreaterThan(255);

    // A mentioned group message preserves the mention; group context is read
    // only from locally archived messages with an explicit visibility grant.
    const groupMessageId = await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "@Okou summarize this thread",
      conversationId,
      isGroup: true,
      recentHistory: [
        {
          messageId: "rh-group-prior",
          content: "Earlier group context",
          direction: "inbound",
          channel: "imessage",
          from: "+15559990000",
          at: "2026-05-18T00:00:00.000Z",
        },
      ],
    });
    await waitForTyping(sends, [conversationId]);
    const groupLifecycle = await createChatFilesBddApi(
      context,
    ).requestThreadEvents(actor, {}, [200]);
    if (groupLifecycle.status !== 200) {
      throw new Error("Expected AgentPhone thread lifecycle events");
    }
    const createdGroupThreads = groupLifecycle.body.events.filter((event) => {
      return event.kind === "created";
    });
    expect(createdGroupThreads).toHaveLength(1);
    const groupThreadId = createdGroupThreads[0]?.chatThreadId;
    if (!groupThreadId) {
      throw new Error("Expected an AgentPhone group chat thread");
    }
    const groupEvents = await createChatFilesBddApi(context).listThreadEvents(
      actor,
      groupThreadId,
    );
    expect(groupEvents.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.prompt",
        userMessage: {
          version: 1,
          parts: expect.arrayContaining([
            { type: "text", text: "@Okou summarize this thread" },
            { type: "source", kind: "agentphone" },
          ]),
        },
      }),
    );
    const run1 = await claimDispatchedRun(runnerGroup);
    expect(run1.prompt).toBe("@Okou summarize this thread");

    // Typing uses the conversation id on ingress and subsequent refreshes,
    // while the final message below still uses the group id as its address.
    mockNow(now() + 4000);
    await webhooks.requestAgentEvents(
      {
        runId: run1.runId,
        events: [{ type: "assistant", sequenceNumber: 1 }],
      },
      { authorization: `Bearer ${run1.sandboxToken}` },
      [200],
    );
    await waitForTyping(sends, [conversationId, conversationId]);
    mockNow(now() + 4000);
    const heartbeat = await webhooks.requestAgentHeartbeat(
      { runId: run1.runId },
      { authorization: `Bearer ${run1.sandboxToken}` },
      [200],
    );
    expect(heartbeat.body).toStrictEqual({
      ok: true,
      typingRefreshIntervalSeconds: 4,
    });
    await waitForTyping(sends, [
      conversationId,
      conversationId,
      conversationId,
    ]);

    // The provider's unfiltered group history is not trusted as local context.
    expect(run1.appendSystemPrompt).not.toContain("Earlier group context");

    // The provider requires the group id as to_number for a group reply.
    const beforeGroupCompletion = sends.messages.length;
    await completeSandboxRun(run1.sandboxToken, run1.runId, 0);
    await waitForSendCount(sends, beforeGroupCompletion + 1);
    const groupReply = lastSend(sends);
    expect(groupReply.conversationId).toBeUndefined();
    expect(groupReply.replyToMessageId).toBe(groupMessageId);
    expect(groupReply.toNumber).toBe(bddGroupId(conversationId));
    expect(groupReply.body).toBe("Task completed successfully.");
    const groupSession = await waitForRunSessionIdPresent(actor, run1.runId);

    // A reply without provider history renders the stored group
    // context with sender handles and the bot reply.
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "@Okou what changed since then",
      replyToMessageId: groupMessageId,
      conversationId,
      isGroup: true,
    });
    const run2 = await claimDispatchedRun(runnerGroup);
    expect(run2.appendSystemPrompt).toContain("# Phone Message Context");
    expect(run2.appendSystemPrompt).toContain(`SENDER: {id: ${phone}}`);
    expect(run2.appendSystemPrompt).toContain("SENDER: {id: BOT}");
    expect(run2.resumedSessionId).toBeUndefined();
    await completeSandboxRun(run2.sandboxToken, run2.runId, 0);
    await expect(
      waitForRunSessionIdPresent(actor, run2.runId),
    ).resolves.not.toBe(groupSession);

    // Ambient group chatter is stored but never dispatched as a run.
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "ambient chatter without a mention",
      conversationId,
      isGroup: true,
    });
    await runs.heartbeatRunner(runnerGroup);
    const idle = await runs.pollRunner(runnerGroup);
    expect(idle.body.job).toBeNull();

    // A later direct message must not inherit content from a group chat.
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "@Okou respond privately",
      conversationId: uniqueConversationId(),
      isGroup: false,
    });
    const privateRun = await claimDispatchedRun(runnerGroup);
    expect(privateRun.prompt).toBe("@Okou respond privately");
    expect(privateRun.appendSystemPrompt).not.toContain(
      "ambient chatter without a mention",
    );
    await completeSandboxRun(privateRun.sandboxToken, privateRun.runId, 0);

    // Conversation-only participants cannot run account commands.
    const intruder = uniquePhoneHandle();
    const beforeBlockedCommand = sends.messages.length;
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: intruder,
      body: "/disconnect @Okou",
      conversationId,
      isGroup: true,
    });
    await waitForSendCount(sends, beforeBlockedCommand + 1);
    const blockedReply = lastSend(sends);
    expect(blockedReply.toNumber).toBe(bddGroupId(conversationId));
    expect(blockedReply.body).toContain("Only the linked sender");
    expect(blockedReply.body).not.toContain("/settings/agentphone?");
    const stillLinked = await integrations.getAgentPhoneLinkStatus(actor);
    expect(stillLinked).toMatchObject({ linked: true, phoneHandle: phone });

    // Unlinked senders receive their signed link privately, with a notice
    // in the originating group conversation.
    const stranger = uniquePhoneHandle();
    const strangerConversationId = uniqueConversationId();
    const beforeStrangerPrompt = sends.messages.length;
    const strangerMessageId = await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: stranger,
      body: "@Okou hello",
      conversationId: strangerConversationId,
      isGroup: true,
    });
    const dmPrompt = await waitForSendMatching(
      sends,
      beforeStrangerPrompt,
      (send) => {
        return (
          send.toNumber === bddGroupId(strangerConversationId) &&
          (send.body?.includes("I've sent you a private connection link") ??
            false)
        );
      },
    );
    expect(dmPrompt.toNumber).toBe(bddGroupId(strangerConversationId));
    expect(dmPrompt.replyToMessageId).toBe(strangerMessageId);
    expect(sends.messages[beforeStrangerPrompt]).toMatchObject({
      toNumber: stranger,
      body: expect.stringContaining("/settings/agentphone?"),
    });
    expect(
      sends.messages[beforeStrangerPrompt]?.replyToMessageId,
    ).toBeUndefined();
    expect(dmPrompt.body).not.toContain("/settings/agentphone?");

    // /connect also delivers a private link rather than borrowing the
    // linked participant's account.
    const beforeStrangerCommand = sends.messages.length;
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: stranger,
      body: "/connect @Okou",
      conversationId,
      isGroup: true,
    });
    await waitForSendMatching(sends, beforeStrangerCommand, (send) => {
      return (
        send.toNumber === bddGroupId(conversationId) &&
        (send.body?.includes("I've sent you a private connection link") ??
          false)
      );
    });

    // A mention from an unlinked sender in a conversation the linked user
    // already started never borrows the linked user's account.
    const beforeBorrowAttempt = sends.messages.length;
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: stranger,
      body: "@Okou run this on the owner's account",
      conversationId,
      isGroup: true,
    });
    const borrowPrompt = await waitForSendMatching(
      sends,
      beforeBorrowAttempt,
      (send) => {
        return (
          send.toNumber === bddGroupId(conversationId) &&
          (send.body?.includes("I've sent you a private connection link") ??
            false)
        );
      },
    );
    expect(borrowPrompt.body).not.toContain("/settings/agentphone?");
    await runs.heartbeatRunner(runnerGroup);
    const borrowIdle = await runs.pollRunner(runnerGroup);
    expect(borrowIdle.body.job).toBeNull();
    const ownerGroupEvents = await createChatFilesBddApi(
      context,
    ).listThreadEvents(actor, groupThreadId);
    expect(
      ownerGroupEvents.events.some((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.userMessage.parts.some((part) => {
            return (
              part.type === "text" &&
              part.text === "@Okou run this on the owner's account"
            );
          })
        );
      }),
    ).toBeFalsy();
  });

  it("preserves a mention-only iMessage prompt with the preceding task", async () => {
    const runs = createRunsApi(context);
    const { phone, runnerGroup, sends, ap } = await entitledLinkedActor();
    const conversationId = uniqueConversationId();
    const archivedArticleUrl = "https://example.com/article";
    const providerOnlyArticleUrl = "https://provider-only.example/article";

    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: `Check the broken article at ${archivedArticleUrl}`,
      conversationId,
      isGroup: true,
    });

    // A standalone mention carries locally archived task context, not the
    // provider's unfiltered recentHistory.
    const beforeMention = sends.messages.length;
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "@okou",
      recentHistory: [
        {
          messageId: "provider-only-article-report",
          content: `Provider-only task at ${providerOnlyArticleUrl}`,
          direction: "inbound",
          channel: "imessage",
          from: phone,
          at: "2026-09-07T09:00:00.000Z",
        },
      ],
      conversationId,
      isGroup: true,
    });
    const mentionRun = await claimDispatchedRun(runnerGroup);
    expect(mentionRun.prompt).toBe("@okou");
    expect(mentionRun.appendSystemPrompt).toContain(archivedArticleUrl);
    expect(mentionRun.appendSystemPrompt).not.toContain(providerOnlyArticleUrl);
    await completeSandboxRun(mentionRun.sandboxToken, mentionRun.runId, 0);
    await waitForSendCount(sends, beforeMention + 1);

    // A provider mention object naming the canonical handle wakes the agent
    // even when the body carries no handle text.
    const beforeMentionObject = sends.messages.length;
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "and schedule it for Monday",
      conversationId,
      isGroup: true,
      mentions: [{ username: "okou" }],
    });
    const mentionObjectRun = await claimDispatchedRun(runnerGroup);
    expect(mentionObjectRun.prompt).toBe("and schedule it for Monday");
    await completeSandboxRun(
      mentionObjectRun.sandboxToken,
      mentionObjectRun.runId,
      0,
    );
    await waitForSendCount(sends, beforeMentionObject + 1);

    // Mentioning the name inside ordinary group chatter does not address it.
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "I think okou would probably know",
      conversationId,
      isGroup: true,
    });
    await runs.heartbeatRunner(runnerGroup);
    const idle = await runs.pollRunner(runnerGroup);
    expect(idle.body.job).toBeNull();
  });

  it.each(["Okou hi", "  OKOU，帮我总结", "Okou", "okou would probably know"])(
    "replies in the group when iMessage drops the at-sign from an opening mention: %s",
    async (body) => {
      const ap = createAgentPhoneBddApi(context);
      const { phone, runnerGroup, sends } = await entitledLinkedActor();
      const conversationId = uniqueConversationId();
      // The provider delivers native iMessage mentions as plain display names.
      const beforeReply = sends.messages.length;
      const messageId = await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body,
        conversationId,
        isGroup: true,
      });
      const run = await claimDispatchedRun(runnerGroup);
      expect(run.prompt).toBe(body.trim());
      await completeSandboxRun(run.sandboxToken, run.runId, 0);
      await waitForSendCount(sends, beforeReply + 1);
      expect(lastSend(sends)).toMatchObject({
        toNumber: bddGroupId(conversationId),
        replyToMessageId: messageId,
        body: "Task completed successfully.",
      });
    },
  );

  it("ignores iMessage group text without an opening address", async () => {
    const runs = createRunsApi(context);
    const ap = createAgentPhoneBddApi(context);
    const { phone, runnerGroup, sends } = await entitledLinkedActor();
    const conversationId = uniqueConversationId();
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "Okou establish the group thread",
      conversationId,
      isGroup: true,
    });
    const initialRun = await claimDispatchedRun(runnerGroup);
    await completeSandboxRun(initialRun.sandboxToken, initialRun.runId, 0);
    // A URL, a longer name, or an embedded name is not an opening address.
    const beforeChatter = sends.messages.length;
    for (const body of [
      "okou.ai has the answer",
      "OkouHelper hi",
      "I think Okou would probably know",
    ]) {
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body,
        conversationId,
        isGroup: true,
      });
      await runs.heartbeatRunner(runnerGroup);
      const idle = await runs.pollRunner(runnerGroup);
      expect(idle.body.job).toBeNull();
    }
    expect(sends.messages).toHaveLength(beforeChatter);
  });

  it("does not send a group reply to one member when the provider group id is missing", async () => {
    const runs = createRunsApi(context);
    const ap = createAgentPhoneBddApi(context);
    const { phone, runnerGroup, sends } = await entitledLinkedActor();
    const before = sends.messages.length;

    await ap.postAgentPhoneInboundMessage(
      {
        channel: "imessage",
        from: phone,
        body: "@Okou check this group",
        conversationId: uniqueConversationId(),
        isGroup: true,
        groupId: null,
      },
      [500],
    );

    expect(sends.messages).toHaveLength(before);
    await runs.heartbeatRunner(runnerGroup);
    const idle = await runs.pollRunner(runnerGroup);
    expect(idle.body.job).toBeNull();
  });

  it("tells a group when the org is at its concurrent run limit and starts it once a slot frees up", async () => {
    // One active run fills the org, independent of the plan's own limit.
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const runs = createRunsApi(context);
    const ap = createAgentPhoneBddApi(context);
    const chat = createChatFilesBddApi(context);
    const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();
    const orgFullNotice =
      "The workspace has reached its concurrent run limit; this will start automatically when a slot frees up.";

    // With capacity, the direct message starts a run without a wait notice.
    const beforeActive = sends.messages.length;
    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "occupy the only org run slot",
    });
    const activeRun = await claimDispatchedRun(runnerGroup);
    expect(sends.messages.slice(beforeActive)).toHaveLength(0);
    const beforeGroup = await chat.requestThreadEvents(actor, {}, [200]);
    if (beforeGroup.status !== 200) {
      throw new Error("Expected AgentPhone thread lifecycle events");
    }
    const lastEvent = beforeGroup.body.events.at(-1);
    if (!lastEvent) {
      throw new Error("Expected the direct message thread to be listed");
    }

    // The group mention is a separate thread, so only the org limit holds it.
    const conversationId = uniqueConversationId();
    const waitingPrompt = "Okou wait for an org run slot";
    const waitingMessageId = await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: waitingPrompt,
      conversationId,
      isGroup: true,
    });
    await flushWaitUntilForTest();

    expect(sends.messages.slice(beforeActive)).toStrictEqual([
      expect.objectContaining({
        toNumber: bddGroupId(conversationId),
        replyToMessageId: waitingMessageId,
        body: orgFullNotice,
      }),
    ]);
    const groupLifecycle = await chat.requestThreadEvents(
      actor,
      { sinceSeqId: lastEvent.seqId },
      [200],
    );
    if (groupLifecycle.status !== 200) {
      throw new Error("Expected the group thread to be listed");
    }
    const groupThreads = groupLifecycle.body.events.filter((event) => {
      return event.kind === "created";
    });
    expect(groupThreads).toHaveLength(1);
    const groupThread = groupThreads[0];
    if (!groupThread) {
      throw new Error("Expected the group mention to create a thread");
    }
    const groupEvents = await chat.listThreadEvents(
      actor,
      groupThread.chatThreadId,
    );
    const pending = groupEvents.events.find((event) => {
      return (
        event.eventType === "input.prompt" &&
        event.userMessage.parts.some((part) => {
          return part.type === "text" && part.text === waitingPrompt;
        })
      );
    });
    if (!pending) {
      throw new Error("Expected the group prompt to remain queued");
    }
    expect(
      groupEvents.events.some((event) => {
        return event.revokesEventId === pending.id;
      }),
    ).toBeFalsy();
    expect(
      groupEvents.events.some((event) => {
        return "runId" in event && event.runId !== undefined;
      }),
    ).toBeFalsy();
    await runs.heartbeatRunner(runnerGroup);
    expect((await runs.pollRunner(runnerGroup)).body.job).toBeNull();

    // Completing the active run frees the slot and launches the waiting input.
    await completeSandboxRun(activeRun.sandboxToken, activeRun.runId, 0);
    const waitingRun = await claimDispatchedRun(runnerGroup);
    expect(waitingRun.prompt).toBe(waitingPrompt);
    await completeSandboxRun(waitingRun.sandboxToken, waitingRun.runId, 0);
    expect(
      sends.messages.filter((send) => {
        return send.body === orgFullNotice;
      }),
    ).toHaveLength(1);
  });

  it("sends no wait notice when the input joins its thread's running run at the org limit", async () => {
    // The only org slot is taken by this thread's own run.
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const ap = createAgentPhoneBddApi(context);
    const { phone, runnerGroup, sends } = await entitledLinkedActor();
    const before = sends.messages.length;
    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "occupy the only org run slot",
    });
    const activeRun = await claimDispatchedRun(runnerGroup);

    // The follow-up steers into the running run, so it is not waiting on the
    // organization limit.
    await ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "follow up while the run is working",
    });
    await flushWaitUntilForTest();
    expect(sends.messages.slice(before)).toStrictEqual([]);

    await completeSandboxRun(activeRun.sandboxToken, activeRun.runId, 0);
  });

  it.each(["unlink", "switch", "replace"] as const)(
    "skips completion delivery after the phone link changes through %s",
    async (method) => {
      const integrations = createBddIntegrationApi(context);
      const ap = createAgentPhoneBddApi(context);
      const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();
      const dmConversationId = uniqueConversationId();
      const groupConversationId = uniqueConversationId();

      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "dm before unlink",
        conversationId: dmConversationId,
        isGroup: false,
      });
      const dmRun = await claimDispatchedRun(runnerGroup);

      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "@Okou group before unlink",
        conversationId: groupConversationId,
        isGroup: true,
      });
      const groupRun = await claimDispatchedRun(runnerGroup);

      if (method === "switch") {
        await ap.postAgentPhoneInboundMessage({
          channel: "imessage",
          from: phone,
          body: "/switch",
          conversationId: dmConversationId,
        });
        expect(lastSend(sends).body).toContain("/settings/agentphone?");
      } else if (method === "replace") {
        const proof = await ap.requestConnectLink(uniquePhoneHandle(), sends);
        await integrations.requestConnectAgentPhone(
          actor,
          { ...proof, replacePhoneHandle: phone },
          [200],
        );
      } else {
        await integrations.requestUnlinkAgentPhone(actor, [204]);
      }
      const sendsBeforeCompletion = sends.messages.length;

      // DM stale variant: the handle no longer resolves to the payload link.
      await completeSandboxRun(dmRun.sandboxToken, dmRun.runId, 0);
      expect(sends.messages).toHaveLength(sendsBeforeCompletion);

      // Group stale variant: the link row itself is gone.
      await completeSandboxRun(groupRun.sandboxToken, groupRun.runId, 0);
      expect(sends.messages).toHaveLength(sendsBeforeCompletion);
    },
  );

  it.each([false, true])(
    "uploads phone media with a real run-scoped agent token (group: %s)",
    async (isGroup) => {
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      const integrations = createBddIntegrationApi(context);
      const { actor, phone, runnerGroup, sends, storage, ap } =
        await entitledLinkedActor();
      const conversationId = uniqueConversationId();
      const groupId = isGroup ? bddGroupId(conversationId) : undefined;
      if (groupId) {
        await ap.postAgentPhoneInboundMessage({
          channel: "imessage",
          from: phone,
          body: "shared group attachment context",
          conversationId,
          isGroup: true,
          groupId,
          participants: [{ identifier: phone }],
        });
      }

      const agent = await bdd.createAgent(actor, {
        displayName: "BDD agentphone upload agent",
        visibility: "private",
      });
      const run = await runs.createThreadRun(actor, {
        agentId: agent.agentId,
        prompt: "deliver a phone attachment",
      });
      await runs.heartbeatRunner(runnerGroup);
      const claim = await runs.claimRunnerJob(run.runId);
      const okouToken = claim.platformEnvironment.OKOU_TOKEN;
      if (!okouToken) {
        throw new Error("Expected the claimed run to expose OKOU_TOKEN");
      }

      const init = await ap.requestPhoneUploadInitWithToken(
        okouToken,
        { filename: "screen shot.png", contentType: "image/png", length: 123 },
        [200],
      );
      expect(init.body).toMatchObject({
        filename: "screen_shot.png",
        contentType: "image/png",
        size: 123,
      });
      expect(init.body.uploadUrl).toMatch(/^https?:\/\//u);
      expect(init.body.fileUrl).toMatch(
        /^https?:\/\/[^/]+\/artifacts\/[a-z0-9]{10}\.png$/u,
      );

      storage.addArtifactObject({
        uploadId: init.body.uploadId,
        filename: "screen_shot.png",
        size: 456,
      });
      const completed = await ap.requestPhoneUploadCompleteWithToken(
        okouToken,
        {
          uploadId: init.body.uploadId,
          groupId,
          agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID,
          caption: "see attached",
          contentType: "image/png",
        },
        [200],
      );
      expect(completed.body).toMatchObject({
        filename: "screen shot.png",
        mimetype: "image/png",
        size: 456,
        toNumber: groupId ?? phone,
      });
      const mediaSend = lastSend(sends);
      expect(mediaSend.body).toBe("see attached");
      expect(completed.body.url).toBe(init.body.fileUrl);
      expect(mediaSend.toNumber).toBe(groupId ?? phone);
      if (!mediaSend.mediaUrl) {
        throw new Error("Expected a provider-fetchable phone file");
      }
      expect(new URL(mediaSend.mediaUrl).searchParams.get("object")).toBe(
        `test-private-artifacts/private-artifacts/${init.body.uploadId}/screen_shot.png`,
      );

      if (groupId) {
        const history = await integrations.requestAgentPhoneGroupHistory(
          actor,
          { groupId, limit: 100 },
          [200],
        );
        expect(
          history.status === 200 ? history.body.messages : [],
        ).toContainEqual(
          expect.objectContaining({
            id: completed.body.messageId,
            conversationId,
            toNumber: groupId,
            channel: "imessage",
            mediaUrl: init.body.fileUrl,
            body: "see attached",
          }),
        );
      }

      const downloaded = await ap.downloadPhoneFileRaw(
        okouToken,
        completed.body.messageId,
      );
      expect(downloaded.status).toBe(302);
      expect(downloaded.headers.get("content-type")).toBe("image/png");
      expect(downloaded.headers.get("x-file-name")).toBe("screen%20shot.png");
      expect(downloaded.headers.get("x-file-size")).toBe("456");
      expect(
        new URL(downloaded.headers.get("location") ?? "").searchParams.get(
          "object",
        ),
      ).toBe(new URL(mediaSend.mediaUrl).searchParams.get("object"));

      const unauthorized = await integrations.requestPhoneDownloadFile(
        null,
        completed.body.messageId,
        [401],
      );
      expectApiError(unauthorized.body);

      await completeSandboxRun(claim.sandboxToken, run.runId, 0);
    },
  );

  it("requires current group membership and keeps group uploads scoped to the user, organization, agent, and file owner", async () => {
    const bdd = createBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const { actor, phone, sends, storage, ap } = await entitledLinkedActor();
    const member = bdd.user();
    const outsider = bdd.user();
    const memberPhone = uniquePhoneHandle();
    const outsiderPhone = uniquePhoneHandle();
    await ap.linkViaWebhookConnectPrompt(member, memberPhone, sends);
    await ap.linkViaWebhookConnectPrompt(outsider, outsiderPhone, sends);
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "file sharing group",
      conversationId,
      isGroup: true,
      participants: [{ identifier: phone }, { identifier: memberPhone }],
    });

    async function uploadFor(owner: ApiTestUser) {
      const init = await integrations.requestPhoneUploadInit(
        owner,
        {
          filename: "photo.png",
          contentType: "image/png",
          length: 11,
        },
        [200],
      );
      if (init.status !== 200) {
        throw new Error("Expected an owned upload URL");
      }
      storage.addArtifactObject({
        uploadId: init.body.uploadId,
        filename: "photo.png",
        size: 11,
      });
      return { uploadId: init.body.uploadId, groupId, caption: "Group photo" };
    }
    const body = await uploadFor(actor);
    const outsiderBody = await uploadFor(outsider);
    const sendsBeforeDenials = sends.messages.length;
    await integrations.requestPhoneUploadComplete(null, body, [401]);
    await integrations.requestPhoneUploadComplete(member, body, [404]);
    await integrations.requestPhoneUploadComplete(
      outsider,
      outsiderBody,
      [404],
    );
    await integrations.requestPhoneUploadComplete(
      { ...actor, orgId: `org_${randomUUID()}` },
      body,
      [404],
    );
    await integrations.requestPhoneUploadComplete(
      actor,
      { ...body, agentphoneAgentId: "agt_unrelated" },
      [404],
    );
    expect(sends.messages).toHaveLength(sendsBeforeDenials);

    const conversationUrl = `https://api.agentphone.test/v1/conversations/${conversationId}`;
    // History visibility survives leaving, but it must not authorize a new send.
    server.use(
      http.get(conversationUrl, () => {
        return HttpResponse.json({ participants: [memberPhone] });
      }),
    );
    const removed = await integrations.requestPhoneUploadComplete(
      actor,
      body,
      [403],
    );
    expectApiError(removed.body);
    expect(sends.messages).toHaveLength(sendsBeforeDenials);

    for (const status of [404, 503]) {
      server.use(
        http.get(conversationUrl, () => {
          return new HttpResponse(null, { status });
        }),
      );
      await integrations.requestPhoneUploadComplete(actor, body, [
        status === 404 ? 404 : 502,
      ]);
      expect(sends.messages).toHaveLength(sendsBeforeDenials);
    }
    server.use(
      http.get(conversationUrl, () => {
        return HttpResponse.error();
      }),
    );
    await integrations.requestPhoneUploadComplete(actor, body, [502]);
    expect(sends.messages).toHaveLength(sendsBeforeDenials);

    server.use(
      http.get(conversationUrl, () => {
        return HttpResponse.json({ participants: [phone, memberPhone] });
      }),
    );
    const completed = await integrations.requestPhoneUploadComplete(
      actor,
      body,
      [200],
    );
    if (completed.status !== 200) {
      throw new Error("Expected an authorized group upload");
    }
    expect(completed.body.toNumber).toBe(groupId);
    expect(lastSend(sends)).toMatchObject({
      toNumber: groupId,
      agentId: AGENTPHONE_BDD_AGENT_ID,
      body: "Group photo",
      mediaUrl: expect.stringMatching(/^https?:\/\//u),
    });
    const memberHistory = await integrations.requestAgentPhoneGroupHistory(
      member,
      { groupId, limit: 100 },
      [200],
    );
    expect(
      memberHistory.status === 200 ? memberHistory.body.messages : [],
    ).toContainEqual(
      expect.objectContaining({
        id: completed.body.messageId,
        mediaUrl: completed.body.url,
        toNumber: groupId,
      }),
    );
    const outsiderHistory = await integrations.requestAgentPhoneGroupHistory(
      outsider,
      { groupId, limit: 100 },
      [200],
    );
    expect(
      outsiderHistory.status === 200 ? outsiderHistory.body.messages : [],
    ).toStrictEqual([]);
  });

  it("guards startLink against foreign-owner handles and provider network failures", async () => {
    const bdd = createBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);

    const owner = bdd.user();
    bdd.acceptAgentStorageWrites();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();
    const ownedPhone = uniquePhoneHandle();
    await ap.linkViaWebhookConnectPrompt(owner, ownedPhone, sends);

    const rival = bdd.user();
    const conflict = await integrations.requestStartAgentPhoneLink(
      rival,
      { phoneHandle: ownedPhone },
      [409],
    );
    expectApiError(conflict.body);
    expect(conflict.body.error).toStrictEqual({
      code: "CONFLICT",
      message:
        "This phone number is already connected to another Okou account or organization. Disconnect it first.",
    });

    server.use(
      http.post("https://api.agentphone.test/v1/messages", () => {
        return HttpResponse.error();
      }),
    );
    const unavailable = await integrations.requestStartAgentPhoneLink(
      rival,
      { phoneHandle: uniquePhoneHandle() },
      [503],
    );
    expectApiError(unavailable.body);
    expect(unavailable.body.error.code).toBe("PROVIDER_UNAVAILABLE");
  });
});
