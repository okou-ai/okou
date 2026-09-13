// INT-03 deep AgentPhone flows: linking through the webhook connect prompt,
// real run dispatch through runner poll/claim, and completion replies through
// typed internal callback dispatch. All state is constructed through public
// APIs; the only mocked surfaces are the AgentPhone provider, Stripe, Clerk,
// S3, and Axiom boundaries.

import { createHash, randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { DEFAULT_VIDEO_MODEL } from "@okouai/core/video-model-catalog";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  findAgentphoneChatEventByPromptFixture,
  readChatEventContextFixture,
} from "../../../test-fixtures/chat-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settle } from "../../utils";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import {
  AGENTPHONE_BDD_AGENT_ID,
  AGENTPHONE_BDD_PHONE_NUMBER,
  createAgentPhoneBddApi,
  uniqueConversationId,
  uniquePhoneHandle,
  type AgentPhoneProviderSend,
  type AgentPhoneSendCapture,
} from "./helpers/api-bdd-agentphone";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
interface LinkedAgentPhoneActor {
  readonly actor: ApiTestUser;
  readonly phone: string;
  readonly runnerGroup: string;
  readonly sends: AgentPhoneSendCapture;
  readonly storage: {
    addArtifactObject(object: {
      readonly userId: string;
      readonly uploadId: string;
      readonly filename: string;
      readonly size: number;
    }): void;
  };
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
  await runs.ensureOrgModelProvider(actor);
  const phone = uniquePhoneHandle();
  await ap.linkViaWebhookConnectPrompt(actor, phone, sends);
  return { actor, phone, runnerGroup, sends, storage };
}

async function claimDispatchedRun(runnerGroup: string): Promise<{
  readonly runId: string;
  readonly sandboxToken: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly okouToken: string | undefined;
}> {
  const runs = createRunsApi(context);
  await runs.heartbeatRunner(runnerGroup);
  let runId: string | undefined;
  await expect
    .poll(async () => {
      const poll = await runs.pollRunner(runnerGroup);
      runId = poll.body.job?.runId;
      return runId ?? null;
    })
    .not.toBeNull();
  if (!runId) {
    throw new Error("Expected an AgentPhone run to be dispatched");
  }
  const claim = await runs.claimRunnerJob(runId);
  return {
    runId,
    sandboxToken: claim.sandboxToken,
    prompt: claim.prompt,
    appendSystemPrompt: claim.appendSystemPrompt ?? "",
    okouToken: claim.platformEnvironment.OKOU_TOKEN,
  };
}

function agentPhoneCliAgentSessionIdForRun(runId: string): string {
  return `bdd-agentphone-cli-${runId}`;
}

async function completeSandboxRun(
  sandboxToken: string,
  runId: string,
  exitCode: number,
  options: {
    readonly error?: string;
    readonly resultText?: string;
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
            checkpoint: {
              cliAgentType: "claude-code" as const,
              cliAgentSessionId: agentPhoneCliAgentSessionIdForRun(runId),
              cliAgentSessionHistoryHash: createHash("sha256")
                .update(`bdd agentphone history ${runId}`)
                .digest("hex"),
            },
          }
        : {}),
      ...(options.error === undefined ? {} : { error: options.error }),
      ...(options.resultText === undefined ? {} : { lastEventSequence: 0 }),
    },
    sandboxHeaders,
    [200],
  );
  await flushWaitUntilForTest();
}

function lastSend(sends: AgentPhoneSendCapture): AgentPhoneProviderSend {
  const send = sends.messages.at(-1);
  if (!send) {
    throw new Error("Expected a captured AgentPhone provider send");
  }
  return send;
}

function expectIntegrationImmediatelyBeforeRestrictedContent(
  appendSystemPrompt: string,
  expectedIntegration: string,
): void {
  const restrictedContentIndex = appendSystemPrompt.lastIndexOf(
    "# Restricted Explicit Content",
  );
  expect(restrictedContentIndex).toBeGreaterThan(-1);
  // The API appends the default image model section after the caller's own
  // prompt, so the integration block is the last caller-supplied section
  // rather than the last section overall.
  const defaultImageModelIndex = appendSystemPrompt.lastIndexOf(
    "\n\n# Default built-in image model",
  );
  expect(defaultImageModelIndex).toBeGreaterThan(-1);
  expect(defaultImageModelIndex).toBeLessThan(restrictedContentIndex);
  expect(
    appendSystemPrompt
      .slice(0, defaultImageModelIndex)
      .trimEnd()
      .endsWith(expectedIntegration),
  ).toBeTruthy();
}

async function waitForTyping(
  sends: AgentPhoneSendCapture,
  expected: readonly string[],
): Promise<void> {
  await expect
    .poll(() => {
      return sends.typing;
    })
    .toStrictEqual(expected);
}

async function waitForSendCount(
  sends: AgentPhoneSendCapture,
  count: number,
): Promise<void> {
  await expect
    .poll(() => {
      return sends.messages.length;
    })
    .toBeGreaterThanOrEqual(count);
}

async function waitForSendMatching(
  sends: AgentPhoneSendCapture,
  startIndex: number,
  predicate: (send: AgentPhoneProviderSend) => boolean,
): Promise<AgentPhoneProviderSend> {
  let matched: AgentPhoneProviderSend | undefined;
  await expect
    .poll(() => {
      matched = sends.messages.slice(startIndex).find(predicate);
      return matched !== undefined;
    })
    .toBe(true);
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
  await expect
    .poll(async () => {
      return await ap.readRunSessionId(actor, runId);
    })
    .toBe(expected);
}

async function waitForRunSessionIdPresent(
  actor: ApiTestUser,
  runId: string,
): Promise<string> {
  const ap = createAgentPhoneBddApi(context);
  let sessionId: string | undefined;
  await expect
    .poll(async () => {
      const result = await settle(ap.readRunSessionId(actor, runId));
      sessionId = result.ok ? result.value : undefined;
      return sessionId ?? null;
    })
    .not.toBeNull();
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
  it("links an AgentPhone user without provisioning artifact storage", async () => {
    const bdd = createBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    const storages = createStoragesBddApi(context);
    const actor = bdd.user();
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();

    await ap.linkViaWebhookConnectPrompt(actor, uniquePhoneHandle(), sends);

    await expect(storages.listStorages(actor, "user")).resolves.toStrictEqual(
      [],
    );
  });

  it.each(["dispatch context", "typing and plain-text completion"] as const)(
    "linked iMessage DMs preserve %s",
    async (scenario) => {
      mockEnv("APP_URL", "https://app.okou.ai");
      const webhooks = createWebhookCallbackApi(context);
      const ap = createAgentPhoneBddApi(context);
      const chat = createChatFilesBddApi(context);
      const integrations = createBddIntegrationApi(context);
      const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();
      await integrations.enableAuditLinkSwitch(actor);
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
        const admitted = await findAgentphoneChatEventByPromptFixture({
          userId: actor.userId,
          prompt: "summarize my inbox",
        });
        expect(admitted).toMatchObject({ eventId: expect.any(String) });
        if (!admitted) {
          throw new Error("Expected admitted AgentPhone input event");
        }
        const launchContext = await readChatEventContextFixture(
          admitted.eventId,
        );
        expect(launchContext).toMatchObject({
          contextType: "agentphone",
          contextId: expect.any(String),
          agentphoneChatThreadId: expect.any(String),
          agentphoneMessageText: "summarize my inbox",
          agentphoneThreadContext: "",
          agentphoneMessageId: messageId1,
          agentphoneRootMessageId: "dm",
          agentphoneConversationId: conversationId,
          agentphoneChannel: "imessage",
          agentphoneIsGroup: false,
          agentphonePhoneHandle: phone,
          agentphoneFromNumber: phone,
          agentphoneToNumber: AGENTPHONE_BDD_PHONE_NUMBER,
          agentphoneUserLinkId: expect.any(String),
          agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID,
        });
        const launchThreadId = launchContext?.agentphoneChatThreadId;
        if (!launchThreadId) {
          throw new Error("Expected AgentPhone launch context to own a thread");
        }
        const admittedEvents = await chat.listThreadEvents(
          actor,
          launchThreadId,
        );
        const admittedInput = admittedEvents.events.find((event) => {
          return (
            event.id === admitted.eventId && event.eventType === "input.prompt"
          );
        });
        expect(
          admittedInput?.eventType === "input.prompt"
            ? admittedInput.userMessage.parts.find((part) => {
                return part.type === "source";
              })
            : undefined,
        ).toStrictEqual({ type: "source", kind: "agentphone" });
      }

      const run1 = await claimDispatchedRun(runnerGroup);
      expect(run1.prompt).toBe("summarize my inbox");
      if (scenario === "dispatch context") {
        expectIntegrationImmediatelyBeforeRestrictedContent(
          run1.appendSystemPrompt,
          [
            "# Current Integration",
            "You are currently running inside: AgentPhone",
            `Shared AgentPhone number: ${AGENTPHONE_BDD_PHONE_NUMBER}`,
            `User phone handle: ${phone}`,
            `AgentPhone Agent ID: ${AGENTPHONE_BDD_AGENT_ID}`,
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
      await webhooks.requestAgentHeartbeat(
        { runId: run1.runId },
        { authorization: `Bearer ${run1.sandboxToken}` },
        [200],
      );
      await waitForTyping(sends, [
        conversationId,
        conversationId,
        conversationId,
      ]);

      // Completion converts markdown output to iMessage plain text and binds
      // the delayed audit link to the configured Okou app origin.
      const beforeCompletion = sends.messages.length;
      await completeSandboxRun(run1.sandboxToken, run1.runId, 0, {
        resultText: MARKDOWN_RUN_OUTPUT,
      });
      await waitForSendCount(sends, beforeCompletion + 1);
      const completionReply = lastSend(sends);
      expect(completionReply.toNumber).toBe(phone);
      expect(completionReply.conversationId).toBeUndefined();
      expect(completionReply.body).toContain(EXPECTED_PLAIN_RUN_OUTPUT);
      expect(completionReply.body).toContain(
        `Audit: https://app.okou.ai/activities/${run1.runId}`,
      );
      expect(completionReply.body).not.toContain("Responded by");
    },
  );

  it.each(["reuse", "reset"] as const)(
    "linked iMessage sessions support %s",
    async (scenario) => {
      const ap = createAgentPhoneBddApi(context);
      const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();
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

      if (scenario === "reuse") {
        // The follow-up DM reuses the saved session and carries stored context.
        await ap.postAgentPhoneInboundMessage({
          channel: "imessage",
          from: phone,
          body: "follow up",
          conversationId,
          isGroup: false,
        });
        const run2 = await claimDispatchedRun(runnerGroup);
        expect(run2.appendSystemPrompt).toContain(
          "# AgentPhone Message Context",
        );
        expect(run2.appendSystemPrompt).toContain("RELATIVE_INDEX");
        expect(run2.appendSystemPrompt).toContain(`MSG_ID: ${messageId1}`);
        expect(run2.appendSystemPrompt).toContain("SENDER: {id: BOT}");

        const beforeRun2Completion = sends.messages.length;
        await completeSandboxRun(run2.sandboxToken, run2.runId, 0);
        await waitForSendCount(sends, beforeRun2Completion + 1);
        expect(lastSend(sends).body).toBe("Task completed successfully.");
        await waitForRunSessionId(actor, run2.runId, session1);

        return;
      }

      // /new_session over iMessage replies without the SMS reliability warning.
      const beforeNewSession = sends.messages.length;
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "/new_session",
        conversationId,
        isGroup: false,
      });
      await waitForSendCount(sends, beforeNewSession + 1);
      expect(lastSend(sends).body).toBe("New session started.");

      // The next DM starts a fresh session.
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "fresh start",
        conversationId,
        isGroup: false,
      });
      const run3 = await claimDispatchedRun(runnerGroup);
      await completeSandboxRun(run3.sandboxToken, run3.runId, 0);
      const session3 = await waitForRunSessionIdPresent(actor, run3.runId);
      expect(session3).not.toBe(session1);
    },
  );

  it("replies to failed linked iMessage runs", async () => {
    const ap = createAgentPhoneBddApi(context);
    const { phone, runnerGroup, sends } = await entitledLinkedActor();
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
    const admittedSms = await findAgentphoneChatEventByPromptFixture({
      userId: actor.userId,
      prompt: "start on my phone",
    });
    if (!admittedSms) {
      throw new Error("Expected admitted AgentPhone SMS input event");
    }
    const smsLaunchContext = await readChatEventContextFixture(
      admittedSms.eventId,
    );
    expect(smsLaunchContext).toMatchObject({
      contextType: "agentphone",
      agentphoneMessageText: "start on my phone",
      agentphoneThreadContext: "",
      agentphoneMessageId: smsMessageId,
      agentphoneRootMessageId: "dm",
      agentphoneConversationId: null,
      agentphoneChannel: "sms",
      agentphoneIsGroup: false,
      agentphonePhoneHandle: phone,
      agentphoneFromNumber: phone,
      agentphoneToNumber: AGENTPHONE_BDD_PHONE_NUMBER,
      agentphoneUserLinkId: expect.any(String),
      agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID,
    });
    const phoneRun1 = await claimDispatchedRun(runnerGroup);
    expectIntegrationImmediatelyBeforeRestrictedContent(
      phoneRun1.appendSystemPrompt,
      [
        "# Current Integration",
        "You are currently running inside: AgentPhone",
        `Shared AgentPhone number: ${AGENTPHONE_BDD_PHONE_NUMBER}`,
        `User phone handle: ${phone}`,
        `AgentPhone Agent ID: ${AGENTPHONE_BDD_AGENT_ID}`,
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
    expect(thread).toMatchObject({
      selectedVideoModel: DEFAULT_VIDEO_MODEL,
    });
    const phoneEvents = await chat.listThreadEvents(actor, thread.chatThreadId);
    expect(
      phoneEvents.events.some((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.userMessage.parts.some((part) => {
            return part.type === "source" && part.kind === "agentphone";
          })
        );
      }),
    ).toBeTruthy();

    const webSend = await chat.requestSendEvent(
      actor,
      {
        agentId: thread.agentId,
        threadId: thread.chatThreadId,
        prompt: "continue from the web",
      },
      [201],
    );
    if (webSend.status !== 201 || !webSend.body.runId) {
      throw new Error("Expected the web message to create a run");
    }
    const webRun = await claimDispatchedRun(runnerGroup);
    expect(webRun.runId).toBe(webSend.body.runId);
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
    const secondEvent = await findAgentphoneChatEventByPromptFixture({
      userId: actor.userId,
      prompt: "second queued prompt",
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

  it("uses the configured Okou audit URL when a queued AgentPhone launch fails", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const ap = createAgentPhoneBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();
    await integrations.enableAuditLinkSwitch(actor);

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
    await completeSandboxRun(activeRun.sandboxToken, activeRun.runId, 0);
    await waitForSendCount(sends, beforeCompletion + 2);

    const completionBodies = sends.messages
      .slice(beforeCompletion)
      .map((send) => {
        return send.body ?? "";
      });
    expect(completionBodies).toContainEqual(
      expect.stringContaining("https://app.okou.ai/activities/"),
    );
  });

  it("deduplicates repeated provider messages and completion callbacks", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const ap = createAgentPhoneBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();
    await integrations.enableAuditLinkSwitch(actor);
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
    expect(lastSend(sends).body).toContain(
      `Audit: https://app.okou.ai/activities/${run.runId}`,
    );
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

  it("renders media prompts", async () => {
    const ap = createAgentPhoneBddApi(context);
    const { phone, runnerGroup } = await entitledLinkedActor();

    // A media DM walks both percent-decode branches of the filename.
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
        `[AgentPhone file] photo one+final%2zraw.png (image/png)\n   [ID] ${mediaMessageId}`,
      ].join("\n\n"),
    );
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
    expect(run.appendSystemPrompt).toContain("# AgentPhone Message Context");
    expect(run.appendSystemPrompt).toContain("MSG_ID: rh-full");
    expect(run.appendSystemPrompt).toContain("prior context from provider");
    expect(run.appendSystemPrompt).toContain("CHANNEL: sms");
    expect(run.appendSystemPrompt).toContain("AT: 2026-06-01T08:00:00.000Z");
    expect(run.appendSystemPrompt).toContain(
      "[AgentPhone file] https://media.agentphone.test/history-photo.png",
    );
    expect(
      run.appendSystemPrompt.match(/- RELATIVE_INDEX:/gu) ?? [],
    ).toHaveLength(2);
    await completeSandboxRun(run.sandboxToken, run.runId, 0);
  });

  it("answers the slash-command surface over SMS with link state and model selection", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);

    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const sends = ap.captureAgentPhoneSends();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const phone = uniquePhoneHandle();
    await ap.linkViaWebhookConnectPrompt(actor, phone, sends);
    expect(lastSend(sends).body).toContain(
      "Your phone number is now connected to Okou.",
    );
    expect(lastSend(sends).body).not.toContain("I'm Okou");

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
    expect(help).toContain("/model - Choose your model");
    expect(help).toContain(SMS_RISK_WARNING);

    const alreadyConnected = await commandReply("/connect");
    expect(alreadyConnected).toContain("You are already connected");
    expect(alreadyConnected).toContain("start using Okou");
    expect(alreadyConnected).toContain(SMS_RISK_WARNING);

    const modelOptions = await commandReply("/model");
    expect(modelOptions).toContain("Available models");
    expect(modelOptions).toContain("Current: workspace default");
    expect(modelOptions).toContain("/model claude-sonnet-5");
    expect(modelOptions).toContain("(workspace default)");

    const switched = await commandReply("/model claude-sonnet-5");
    expect(switched).toContain("Switched to ");

    const optionsAfterSwitch = await commandReply("/model");
    expect(optionsAfterSwitch).toContain("Current: Claude Sonnet 5");
    expect(optionsAfterSwitch).toContain("(current, workspace default)");

    const unknownModel = await commandReply("/model not-a-model");
    expect(unknownModel).toContain('Error: Unknown model "not-a-model".');

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

    const newSessionUnlinked = await commandReply("/new_session");
    expect(newSessionUnlinked).toContain("/agentphone/connect?");
    expect(newSessionUnlinked).toContain(SMS_RISK_WARNING);

    const modelUnlinked = await commandReply("/model");
    expect(modelUnlinked).toContain("/agentphone/connect?");

    const plainPromptUnlinked = await commandReply("hello again");
    expect(plainPromptUnlinked).toContain(
      "This shared AgentPhone number connects you to Okou.",
    );
    expect(plainPromptUnlinked).toContain("/agentphone/connect?");
    expect(plainPromptUnlinked).not.toContain(SMS_RISK_WARNING);
  });

  it("handles the iMessage group lifecycle: mentions, stored context, ambient silence, and account-command guards", async () => {
    const runs = createRunsApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    const { actor, phone, runnerGroup, sends } = await entitledLinkedActor();
    const conversationId = `${uniqueConversationId()}-${"g".repeat(230)}`;
    expect(conversationId.length).toBeLessThanOrEqual(255);
    expect(`group:${conversationId}`.length).toBeGreaterThan(255);

    // A mentioned group message preserves the mention and carries provider
    // history into the group run context.
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
    const admittedGroup = await findAgentphoneChatEventByPromptFixture({
      userId: actor.userId,
      prompt: "@Okou summarize this thread",
    });
    expect(admittedGroup).toMatchObject({ eventId: expect.any(String) });
    if (!admittedGroup) {
      throw new Error("Expected admitted AgentPhone group input event");
    }
    const groupLaunchContext = await readChatEventContextFixture(
      admittedGroup.eventId,
    );
    expect(groupLaunchContext).toMatchObject({
      contextType: "agentphone",
      agentphoneMessageText: "@Okou summarize this thread",
      agentphoneThreadContext: expect.stringContaining("Earlier group context"),
      agentphoneMessageId: groupMessageId,
      agentphoneConversationId: conversationId,
      agentphoneChannel: "imessage",
      agentphoneIsGroup: true,
      agentphonePhoneHandle: phone,
      agentphoneFromNumber: phone,
      agentphoneToNumber: AGENTPHONE_BDD_PHONE_NUMBER,
      agentphoneUserLinkId: expect.any(String),
      agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID,
    });
    const run1 = await claimDispatchedRun(runnerGroup);
    expect(run1.prompt).toBe("@Okou summarize this thread");
    const groupThreadContext = groupLaunchContext?.agentphoneThreadContext;
    if (!groupThreadContext) {
      throw new Error("Expected AgentPhone group launch thread context");
    }
    expectIntegrationImmediatelyBeforeRestrictedContent(
      run1.appendSystemPrompt,
      [
        "# Current Integration",
        "You are currently running inside: AgentPhone",
        `Shared AgentPhone number: ${AGENTPHONE_BDD_PHONE_NUMBER}`,
        `User phone handle: ${phone}`,
        `AgentPhone Agent ID: ${AGENTPHONE_BDD_AGENT_ID}`,
        "Channel: imessage",
        "Conversation type: group",
        `Conversation ID: ${conversationId}`,
        `Message ID: ${groupMessageId}`,
        "",
        groupThreadContext,
      ].join("\n"),
    );

    // The completion replies into the conversation, not to a number.
    const beforeGroupCompletion = sends.messages.length;
    await completeSandboxRun(run1.sandboxToken, run1.runId, 0);
    await waitForSendCount(sends, beforeGroupCompletion + 1);
    const groupReply = lastSend(sends);
    expect(groupReply.conversationId).toBe(conversationId);
    expect(groupReply.replyToMessageId).toBe(groupMessageId);
    expect(groupReply.toNumber).toBeUndefined();
    expect(groupReply.body).toBe("Task completed successfully.");
    const groupSession = await waitForRunSessionIdPresent(actor, run1.runId);

    // A second mention without provider history renders the stored group
    // context with sender handles and the bot reply.
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "@Okou what changed since then",
      conversationId,
      isGroup: true,
    });
    const run2 = await claimDispatchedRun(runnerGroup);
    expect(run2.appendSystemPrompt).toContain("# AgentPhone Message Context");
    expect(run2.appendSystemPrompt).toContain(`SENDER: {id: ${phone}}`);
    expect(run2.appendSystemPrompt).toContain("SENDER: {id: BOT}");
    await completeSandboxRun(run2.sandboxToken, run2.runId, 0);
    await waitForRunSessionId(actor, run2.runId, groupSession);

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
    expect(blockedReply.conversationId).toBe(conversationId);
    expect(blockedReply.body).toContain("Only the linked sender");
    expect(blockedReply.body).not.toContain("/agentphone/connect?");
    const stillLinked = await integrations.getAgentPhoneLinkStatus(actor);
    expect(stillLinked).toMatchObject({ linked: true, phoneHandle: phone });

    // Unlinked senders in a fresh group conversation are pointed to a DM,
    // never to a signed connect link.
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
          send.conversationId === strangerConversationId &&
          (send.body?.includes("message this number directly") ?? false)
        );
      },
    );
    expect(dmPrompt.conversationId).toBe(strangerConversationId);
    expect(dmPrompt.replyToMessageId).toBe(strangerMessageId);
    expect(dmPrompt.toNumber).toBeUndefined();
    expect(dmPrompt.body).toContain("message this number directly");
    expect(dmPrompt.body).not.toContain("/agentphone/connect?");

    // /connect from an unlinked sender in the linked conversation hits the
    // same account-command guard.
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
        send.conversationId === conversationId &&
        (send.body?.includes("Only the linked sender") ?? false)
      );
    });

    // Resetting the canonical route makes prior message history insufficient
    // to resolve the group owner.
    const beforeSessionReset = sends.messages.length;
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "/new_session @Okou",
      conversationId,
      isGroup: true,
    });
    await waitForSendMatching(sends, beforeSessionReset, (send) => {
      return (
        send.conversationId === conversationId &&
        send.body === "New session started."
      );
    });

    const beforeColdCutoverPrompt = sends.messages.length;
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: stranger,
      body: "@Okou resume the old group",
      conversationId,
      isGroup: true,
    });
    const coldCutoverPrompt = await waitForSendMatching(
      sends,
      beforeColdCutoverPrompt,
      (send) => {
        return (
          send.conversationId === conversationId &&
          (send.body?.includes("message this number directly") ?? false)
        );
      },
    );
    expect(coldCutoverPrompt.body).not.toContain("/agentphone/connect?");
    await runs.heartbeatRunner(runnerGroup);
    const coldCutoverIdle = await runs.pollRunner(runnerGroup);
    expect(coldCutoverIdle.body.job).toBeNull();
  });

  it("preserves a mention-only iMessage prompt with the preceding task", async () => {
    const runs = createRunsApi(context);
    const ap = createAgentPhoneBddApi(context);
    const { phone, runnerGroup, sends } = await entitledLinkedActor();
    const conversationId = uniqueConversationId();

    // A standalone mention carries the earlier task into the agent input.
    const beforeMention = sends.messages.length;
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "@okou",
      recentHistory: [
        {
          messageId: "prior-article-report",
          content: "Check the broken article at https://example.com/article",
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
    expect(mentionRun.appendSystemPrompt).toContain(
      "https://example.com/article",
    );
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

    // Group chatter that names no handle is still ignored.
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "okou would probably know",
      conversationId,
      isGroup: true,
    });
    await runs.heartbeatRunner(runnerGroup);
    const idle = await runs.pollRunner(runnerGroup);
    expect(idle.body.job).toBeNull();
  });

  it("skips completion delivery for runs whose phone link was disconnected mid-flight", async () => {
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

    await integrations.requestUnlinkAgentPhone(actor, [204]);
    const sendsBeforeCompletion = sends.messages.length;

    // DM stale variant: the handle no longer resolves to the payload link.
    await completeSandboxRun(dmRun.sandboxToken, dmRun.runId, 0);
    expect(sends.messages).toHaveLength(sendsBeforeCompletion);

    // Group stale variant: the link row itself is gone.
    await completeSandboxRun(groupRun.sandboxToken, groupRun.runId, 0);
    expect(sends.messages).toHaveLength(sendsBeforeCompletion);
  });

  it("uploads and streams phone media with a real run-scoped agent token", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const integrations = createBddIntegrationApi(context);
    const ap = createAgentPhoneBddApi(context);
    const { actor, phone, runnerGroup, sends, storage } =
      await entitledLinkedActor();

    const agent = await bdd.createAgent(actor, {
      displayName: "BDD agentphone upload agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "deliver a phone attachment",
      modelProvider: "anthropic-api-key",
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
    expect(init.body.fileUrl).toMatch(/^https:\/\/a\.okou\.io\/[^/]+\.png$/u);

    storage.addArtifactObject({
      userId: actor.userId,
      uploadId: init.body.uploadId,
      filename: "screen_shot.png",
      size: 456,
    });
    const completed = await ap.requestPhoneUploadCompleteWithToken(
      okouToken,
      {
        uploadId: init.body.uploadId,
        toNumber: phone,
        agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID,
        caption: "see attached",
        contentType: "image/png",
      },
      [200],
    );
    expect(completed.body).toMatchObject({
      filename: "screen_shot.png",
      mimetype: "image/png",
      size: 456,
      toNumber: phone,
    });
    const mediaSend = lastSend(sends);
    expect(mediaSend.body).toBe("see attached");
    expect(mediaSend.mediaUrl).toBe(completed.body.url);
    expect(mediaSend.toNumber).toBe(phone);

    // The recorded outbound message is readable back as owned media.
    server.use(
      http.get(completed.body.url, () => {
        return new HttpResponse("png-bytes", {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "9" },
        });
      }),
    );
    const downloaded = await ap.downloadPhoneFileRaw(
      okouToken,
      completed.body.messageId,
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("image/png");
    expect(downloaded.headers.get("x-file-name")).toBe("screen_shot.png");
    expect(downloaded.text).toBe("png-bytes");

    const unauthorized = await integrations.requestPhoneDownloadFile(
      null,
      completed.body.messageId,
      [401],
    );
    expectApiError(unauthorized.body);

    await completeSandboxRun(claim.sandboxToken, run.runId, 0);
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
