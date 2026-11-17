import {
  createAuthDeviceApiActions,
  mockClaudeCodeTokenEndpoint,
} from "./helpers/api-bdd-auth-device";
import { addRecoverySubscription } from "./helpers/subscription-recovery";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { describe, expect, it } from "vitest";
import { array, literal, object, string, unknown as zUnknown } from "zod";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createPublicSlackOrgApi } from "./helpers/slack-public-install";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { now } from "../../../lib/time";

const context = testContext();
const chat = createChatEventsFixture(context);
const integrations = createBddIntegrationApi(context);
const slack = createPublicSlackOrgApi(context);

const postedMessageSchema = object({
  text: string(),
  blocks: array(
    object({
      type: string(),
      elements: array(
        object({ action_id: string().optional(), value: string().optional() }),
      ).optional(),
    }),
  ),
});
const modalSchema = object({
  view: object({
    type: literal("modal"),
    private_metadata: string().optional(),
    blocks: array(zUnknown()),
  }),
});

async function failedSlackConversation(
  failureReason: string | null = "account_verification_required",
  providerType:
    "claude-code-oauth-token" | "codex-oauth-token" = "claude-code-oauth-token",
  withProfileMetadata = true,
) {
  const owner = await publicChatActor(context);
  if (providerType === "codex-oauth-token") {
    await owner.run(() => {
      return chat.configureSubscriptionPiModel(owner.actor);
    });
  }

  if (!withProfileMetadata) {
    await owner.run(async () => {
      mockClaudeCodeTokenEndpoint({ accountEmail: "", organizationName: "" });
      await createMiscRoutesApi(context).upsertPersonalModelProvider(
        owner.actor,
        {
          type: "claude-code-oauth-token",
          secret: "sk-ant-oat-without-profile",
        },
        [200, 201],
      );
    });
  }

  const installed = await owner.run(() => {
    return slack.installOrg({ actor: owner.actor, withConnection: true });
  });
  chat.chatCallbacks.acceptChatObjectStorage();
  chat.api.acceptStorageDownloads();
  chat.api.acceptTelemetryIngest();
  context.mocks.slack.views.update.mockResolvedValue({ ok: true });
  context.mocks.slack.chat.postMessage.mockResolvedValue({
    ok: true,
    ts: "1794840001.000003",
    message: { ts: "1794840001.000003" },
  });
  const before = await chat.chat.requestThreadEvents(owner.actor, {}, [200]);
  await owner.run(() => {
    return integrations.postSlackEvent(installed.slackWorkspaceId, {
      type: "message",
      channel_type: "im",
      channel: "D0RECOVERY",
      user: installed.slackUserId,
      ts: "1794840000.000001",
      text: "Review the forwarded attachment",
    });
  });
  await flushWaitUntilForTest();
  const after = await chat.chat.requestThreadEvents(owner.actor, {}, [200]);
  if (before.status !== 200 || after.status !== 200) {
    throw new Error("Expected current conversation events");
  }
  const created = after.body.events.find((event) => {
    return (
      event.kind === "created" &&
      !before.body.events.some((existing) => {
        return existing.id === event.id;
      })
    );
  });
  const thread = created ? { id: created.chatThreadId } : undefined;
  if (!thread) {
    throw new Error("Slack did not create its canonical conversation");
  }
  const input = (
    await chat.chat.listThreadEvents(owner.actor, thread.id)
  ).events.find((event) => {
    return event.eventType === "input.prompt" && event.runId;
  });
  if (!input?.runId) {
    throw new Error("Slack did not launch the conversation input");
  }
  const runId = input.runId;
  await chat.api.heartbeatRunner(owner.runnerGroup);
  const execution = await owner.executionInput(input.runId);
  await owner.run(() => {
    return chat.webhooks.requestAgentComplete(
      {
        runId,
        exitCode: 1,
        error:
          failureReason === null
            ? "You've hit your usage limit. Try again tomorrow."
            : "Claude account requires verification",
        ...(failureReason === null ? {} : { failureReason }),
      },
      { authorization: `Bearer ${execution.sandboxToken}` },
      [200],
    );
  });
  await flushWaitUntilForTest();
  const failed = (
    await chat.chat.listThreadEvents(owner.actor, thread.id)
  ).events.find((event) => {
    return event.eventType === "run.failed";
  });
  if (!failed) {
    throw new Error("The failure was not saved in the Web conversation");
  }
  const failedEventId = failed.id;
  const actor = {
    user: { id: installed.slackUserId },
    team: { id: installed.slackWorkspaceId },
  };
  async function open(eventId = failedEventId) {
    context.mocks.slack.views.update.mockClear();
    await integrations.postSlackInteractive({
      ...actor,
      type: "block_actions",
      channel: { id: "D0RECOVERY" },
      trigger_id: "model-picker-trigger",
      actions: [{ action_id: "switch_model", value: eventId }],
    });
    await flushWaitUntilForTest();
    return modalSchema.parse(
      context.mocks.slack.views.update.mock.calls.at(-1)?.[0],
    ).view;
  }
  function submit(
    metadata: string,
    model: string,
    userId = installed.slackUserId,
  ) {
    return integrations.postSlackInteractive({
      ...actor,
      user: { id: userId },
      type: "view_submission",
      view: {
        callback_id: "switch_model",
        private_metadata: metadata,
        state: {
          values: {
            model: { selection: { selected_option: { value: model } } },
          },
        },
      },
    });
  }
  return { owner, installed, thread, runId: input.runId, failed, open, submit };
}

describe("integration model recovery in Slack", () => {
  it.each(["claude-code-oauth-token", "codex-oauth-token"] as const)(
    "automatically continues a %s quota failure after switching accounts exactly once",
    async (providerType) => {
      const fixture = await failedSlackConversation(
        "usage_limit",
        providerType,
      );
      const replacementId = await fixture.owner.run(() => {
        return addRecoverySubscription(
          context,
          fixture.owner.actor,
          providerType,
        );
      });
      const reads = createRunReadsApi(context);
      expect(
        (
          await reads.requestListLogs(
            fixture.owner.actor,
            { triggerSource: "slack", limit: 50 },
            [200],
          )
        ).body.data,
      ).toHaveLength(1);
      context.mocks.slack.apiCall.mockClear();
      const support = createAuthDeviceSupportApi(context);
      await fixture.owner.run(() => {
        return support.activatePersonalModelProviderAccount(
          fixture.owner.actor,
          replacementId,
        );
      });
      await flushWaitUntilForTest();
      const recovered = await reads.requestListLogs(
        fixture.owner.actor,
        { triggerSource: "slack", limit: 50 },
        [200],
      );
      expect(recovered.body.data).toHaveLength(2);
      const next = recovered.body.data.find((run) => {
        return run.id !== fixture.runId;
      });
      if (!next) {
        throw new Error("Expected automatic subscription recovery");
      }
      await chat.api.heartbeatRunner(fixture.owner.runnerGroup);
      const execution = await fixture.owner.executionInput(next.id);
      expect(execution.prompt).toBe("continue");
      expect(execution.appendSystemPrompt).toContain("D0RECOVERY");
      expect(execution.appendSystemPrompt).toContain("1794840000.000001");
      expect(context.mocks.slack.apiCall.mock.calls).toContainEqual([
        "agents.sessions.setStatus",
        {
          channel_id: "D0RECOVERY",
          thread_ts: "1794840000.000001",
          status: "processing",
        },
      ]);
      await support.activatePersonalModelProviderAccount(
        fixture.owner.actor,
        replacementId,
      );
      await flushWaitUntilForTest();
      expect(
        (
          await reads.requestListLogs(
            fixture.owner.actor,
            { triggerSource: "slack", limit: 50 },
            [200],
          )
        ).body.data,
      ).toHaveLength(2);
      await fixture.owner.run(() => {
        return chat.webhooks.requestAgentComplete(
          {
            runId: next.id,
            exitCode: 1,
            error: "recovery finished",
            failureReason: "provider_server_error",
          },
          { authorization: `Bearer ${execution.sandboxToken}` },
          [200],
        );
      });
      await flushWaitUntilForTest();
      expect(context.mocks.slack.apiCall.mock.calls.at(-1)).toStrictEqual([
        "agents.sessions.setStatus",
        {
          channel_id: "D0RECOVERY",
          thread_ts: "1794840000.000001",
          status: "active",
        },
      ]);
    },
  );

  it.each(["invalid_credentials", "usage_limit"] as const)(
    "handles same-account reauthorization after %s without blindly retrying an exhausted account",
    async (reason) => {
      const fixture = await failedSlackConversation(reason);
      const device = createAuthDeviceApiActions(context);
      await fixture.owner.run(async () => {
        mockClaudeCodeTokenEndpoint();
        const started = await device.requestClaudeCodeStart(
          fixture.owner.actor,
          "personal",
          [200],
          { mode: "reconnect", modelProviderId: fixture.owner.providerId },
        );
        if (started.status !== 200) {
          throw new Error("Expected reauthorization");
        }
        const state = new URL(started.body.browserUrl).searchParams.get(
          "state",
        );
        if (!state) {
          throw new Error("Expected OAuth state");
        }
        await device.requestClaudeCodeComplete(
          fixture.owner.actor,
          started.body.sessionToken,
          `claude_code_test#${state}`,
          [200],
        );
      });
      await flushWaitUntilForTest();
      expect(
        (
          await createRunReadsApi(context).requestListLogs(
            fixture.owner.actor,
            { triggerSource: "slack", limit: 50 },
            [200],
          )
        ).body.data,
      ).toHaveLength(reason === "usage_limit" ? 1 : 2);
    },
  );

  it("continues after changing models when optional upstream profile metadata is absent", async () => {
    const fixture = await failedSlackConversation(
      "usage_limit",
      "claude-code-oauth-token",
      false,
    );
    await fixture.owner.run(() => {
      return chat.connectSubscriptionPiModel(fixture.owner.actor);
    });
    const modal = await fixture.open();
    if (!modal.private_metadata) {
      throw new Error("Expected model recovery without an upstream profile");
    }
    await fixture.submit(modal.private_metadata, "gpt-6-luna");
    await flushWaitUntilForTest();
    expect(
      (
        await createRunReadsApi(context).requestListLogs(
          fixture.owner.actor,
          { triggerSource: "slack", limit: 50 },
          [200],
        )
      ).body.data,
    ).toHaveLength(2);
  });

  it("ignores delayed Slack Stop events but lets the user stop an automatically continued Run", async () => {
    const fixture = await failedSlackConversation("usage_limit");
    const id = await fixture.owner.run(() => {
      return addRecoverySubscription(context, fixture.owner.actor);
    });
    await fixture.owner.run(() => {
      return createAuthDeviceSupportApi(
        context,
      ).activatePersonalModelProviderAccount(fixture.owner.actor, id);
    });
    await flushWaitUntilForTest();
    const next = (
      await createRunReadsApi(context).requestListLogs(
        fixture.owner.actor,
        { triggerSource: "slack", limit: 50 },
        [200],
      )
    ).body.data.find((run) => {
      return run.id !== fixture.runId;
    });
    if (!next) {
      throw new Error("Expected automatic subscription recovery");
    }
    await chat.api.heartbeatRunner(fixture.owner.runnerGroup);
    await fixture.owner.executionInput(next.id);
    const stop = {
      type: "agent_session_stopped",
      channel: "D0RECOVERY",
      user: fixture.installed.slackUserId,
      thread_ts: "1794840000.000001",
      streaming_message_ts: [],
    };
    await fixture.owner.run(() => {
      return integrations.postSlackEvent(fixture.installed.slackWorkspaceId, {
        ...stop,
        event_ts: "1794840000.000002",
      });
    });
    await flushWaitUntilForTest();
    expect((await chat.api.readRun(fixture.owner.actor, next.id)).status).toBe(
      "running",
    );
    await fixture.owner.run(() => {
      return integrations.postSlackEvent(fixture.installed.slackWorkspaceId, {
        ...stop,
        event_ts: `${Math.floor(now() / 1000) + 60}.000000`,
      });
    });
    await flushWaitUntilForTest();
    expect((await chat.api.readRun(fixture.owner.actor, next.id)).status).toBe(
      "cancelled",
    );
    expect(context.mocks.slack.apiCall.mock.calls.at(-1)).toStrictEqual([
      "agents.sessions.setStatus",
      {
        channel_id: "D0RECOVERY",
        thread_ts: "1794840000.000001",
        status: "active",
      },
    ]);
  });

  it("continues native quota errors that have no structured failure reason", async () => {
    const fixture = await failedSlackConversation(null);
    const modal = await fixture.open();
    expect(modal.private_metadata).toBeDefined();
    const id = await fixture.owner.run(() => {
      return addRecoverySubscription(context, fixture.owner.actor);
    });
    await fixture.owner.run(() => {
      return createAuthDeviceSupportApi(
        context,
      ).activatePersonalModelProviderAccount(fixture.owner.actor, id);
    });
    await flushWaitUntilForTest();
    expect(
      (
        await createRunReadsApi(context).requestListLogs(
          fixture.owner.actor,
          { triggerSource: "slack", limit: 50 },
          [200],
        )
      ).body.data,
    ).toHaveLength(2);
  });

  it("continues after replacing the active subscription credentials", async () => {
    const fixture = await failedSlackConversation("usage_limit");
    await fixture.owner.run(async () => {
      mockClaudeCodeTokenEndpoint({ accountEmail: "replacement@example.com" });
      await createMiscRoutesApi(context).upsertPersonalModelProvider(
        fixture.owner.actor,
        { type: "claude-code-oauth-token", secret: "sk-ant-oat-replacement" },
        [200, 201],
      );
    });
    await flushWaitUntilForTest();
    const listed = await createRunReadsApi(context).requestListLogs(
      fixture.owner.actor,
      { triggerSource: "slack", limit: 50 },
      [200],
    );
    expect(listed.body.data).toHaveLength(2);
  });

  it.each(["archived", "manually-continued", "non-model-failure"] as const)(
    "does not revive a %s conversation when switching subscriptions",
    async (state) => {
      const fixture = await failedSlackConversation(
        state === "non-model-failure"
          ? "guest_home_filesystem_full"
          : "usage_limit",
      );
      if (state === "archived") {
        await chat.chat.requestSetThreadArchived(
          fixture.owner.actor,
          fixture.thread.id,
          true,
          [204],
        );
      }
      if (state === "manually-continued") {
        await fixture.owner.run(() => {
          return integrations.postSlackEvent(
            fixture.installed.slackWorkspaceId,
            {
              type: "message",
              channel_type: "im",
              channel: "D0RECOVERY",
              user: fixture.installed.slackUserId,
              ts: "1794840000.000002",
              text: "continue",
            },
          );
        });
        await flushWaitUntilForTest();
      }
      const id = await fixture.owner.run(() => {
        return addRecoverySubscription(context, fixture.owner.actor);
      });
      await fixture.owner.run(() => {
        return createAuthDeviceSupportApi(
          context,
        ).activatePersonalModelProviderAccount(fixture.owner.actor, id);
      });
      await flushWaitUntilForTest();
      expect(
        (
          await createRunReadsApi(context).requestListLogs(
            fixture.owner.actor,
            { triggerSource: "slack", limit: 50 },
            [200],
          )
        ).body.data,
      ).toHaveLength(state === "manually-continued" ? 2 : 1);
    },
  );

  it("continues the failed DM on GPT with its native indicator without changing the default", async () => {
    const fixture = await failedSlackConversation();
    const posted = context.mocks.slack.chat.postMessage.mock.calls
      .map(([body]) => {
        return postedMessageSchema.safeParse(body);
      })
      .filter((result) => {
        return result.success;
      });
    expect(
      posted.some((result) => {
        return result.data.blocks.some((block) => {
          return block.elements?.some((element) => {
            return (
              element.action_id === "switch_model" &&
              element.value === fixture.failed.id
            );
          });
        });
      }),
    ).toBeTruthy();
    await fixture.owner.run(() => {
      return chat.connectSubscriptionPiModel(fixture.owner.actor);
    });
    await chat.api.updateUserModelPreference(
      fixture.owner.actor,
      "gpt-6-astra",
    );
    expect(
      (
        await chat.chat.readThreadMetadata(
          fixture.owner.actor,
          fixture.thread.id,
        )
      ).selectedModel,
    ).toBe("claude-fable-5-1");
    await chat.chat.renameThread(
      fixture.owner.actor,
      fixture.thread.id,
      "Forwarded attachment review",
    );
    const modal = await fixture.open();
    expect(modal.blocks).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "input",
          element: expect.objectContaining({
            options: expect.arrayContaining([
              expect.objectContaining({
                value: "gpt-6-luna",
                description: {
                  type: "plain_text",
                  text: "Your ChatGPT subscription",
                },
              }),
              expect.objectContaining({
                value: "auto",
                description: {
                  type: "plain_text",
                  text: "Uses workspace credits",
                },
              }),
            ]),
          }),
        }),
      ]),
    );
    if (!modal.private_metadata) {
      throw new Error(
        "Expected the selector to identify its current model state",
      );
    }
    context.mocks.slack.apiCall.mockClear();
    const saved = await fixture.submit(modal.private_metadata, "gpt-6-luna");
    expect(saved).toMatchObject({
      response_action: "update",
      view: {
        blocks: [
          expect.objectContaining({
            text: expect.objectContaining({
              text: expect.stringContaining("Switched to"),
            }),
          }),
        ],
      },
    });
    expect(
      (
        await chat.chat.readThreadMetadata(
          fixture.owner.actor,
          fixture.thread.id,
        )
      ).selectedModel,
    ).toBe("gpt-6-luna");
    expect(
      (await integrations.readUserModelPreference(fixture.owner.actor))
        .selectedModel,
    ).toBe("gpt-6-astra");
    await flushWaitUntilForTest();
    const reads = createRunReadsApi(context);
    const recovered = await reads.requestListLogs(
      fixture.owner.actor,
      { triggerSource: "slack", limit: 50 },
      [200],
    );
    expect(recovered.body.data).toHaveLength(2);
    const nextInput = (
      await chat.chat.listThreadEvents(fixture.owner.actor, fixture.thread.id)
    ).events.find((event) => {
      return (
        event.eventType === "input.prompt" &&
        event.runId &&
        event.runId !== fixture.runId
      );
    });
    if (!nextInput?.runId) {
      throw new Error(
        "Expected automatic continuation on the same conversation",
      );
    }
    expect(nextInput).toMatchObject({
      userMessage: {
        parts: expect.arrayContaining([{ type: "text", text: "continue" }]),
      },
    });
    expect(
      (await chat.api.readRun(fixture.owner.actor, nextInput.runId)).source
        .model,
    ).toBe("gpt-6-luna");
    expect(context.mocks.slack.apiCall.mock.calls).toContainEqual([
      "agents.sessions.setStatus",
      expect.objectContaining({
        channel_id: "D0RECOVERY",
        thread_ts: "1794840000.000001",
        status: "processing",
      }),
    ]);
    await fixture.submit(modal.private_metadata, "gpt-6-luna");
    await flushWaitUntilForTest();
    expect(
      (
        await reads.requestListLogs(
          fixture.owner.actor,
          { triggerSource: "slack", limit: 50 },
          [200],
        )
      ).body.data,
    ).toHaveLength(2);
  });

  it("rejects another sender and an old modal after the owner changes the model in Web", async () => {
    const fixture = await failedSlackConversation();
    const modal = await fixture.open();
    if (!modal.private_metadata) {
      throw new Error("Expected recovery state");
    }
    await fixture.submit(modal.private_metadata, "auto", "U0ANOTHERPERSON");
    expect(
      (
        await chat.chat.readThreadMetadata(
          fixture.owner.actor,
          fixture.thread.id,
        )
      ).selectedModel,
    ).toBe("claude-fable-5-1");
    await chat.chat.updateThreadModelSelection(
      fixture.owner.actor,
      fixture.thread.id,
      "claude-sonnet-5-5",
    );
    const stale = await fixture.submit(modal.private_metadata, "auto");
    expect(stale).toMatchObject({
      response_action: "update",
      view: {
        blocks: [
          expect.objectContaining({
            text: expect.objectContaining({
              text: expect.stringContaining("no longer current"),
            }),
          }),
        ],
      },
    });
    expect(
      (
        await chat.chat.readThreadMetadata(
          fixture.owner.actor,
          fixture.thread.id,
        )
      ).selectedModel,
    ).toBe("claude-sonnet-5-5");
    await flushWaitUntilForTest();
    const recovered = await createRunReadsApi(context).requestListLogs(
      fixture.owner.actor,
      { triggerSource: "slack", limit: 50 },
      [200],
    );
    expect(recovered.body.data).toHaveLength(2);
  });

  it("recovers when the conversation's subscription becomes unavailable before launch", async () => {
    const fixture = await failedSlackConversation();
    await createMiscRoutesApi(context).deletePersonalModelProvider(
      fixture.owner.actor,
      "claude-code-oauth-token",
      [204],
    );
    await fixture.owner.run(() => {
      return integrations.postSlackEvent(fixture.installed.slackWorkspaceId, {
        type: "message",
        channel_type: "im",
        channel: "D0RECOVERY",
        user: fixture.installed.slackUserId,
        ts: "1794840000.000002",
        text: "Review the attachment again",
      });
    });
    await flushWaitUntilForTest();
    const admission = (
      await chat.chat.listThreadEvents(fixture.owner.actor, fixture.thread.id)
    ).events.find((event) => {
      return event.eventType === "output.error";
    });
    if (!admission) {
      throw new Error("Expected the pre-launch failure in the original thread");
    }
    const posted = postedMessageSchema.parse(
      context.mocks.slack.chat.postMessage.mock.calls.at(-1)?.[0],
    );
    expect(posted.blocks).toContainEqual(
      expect.objectContaining({
        elements: expect.arrayContaining([
          expect.objectContaining({
            action_id: "switch_model",
            value: admission.id,
          }),
        ]),
      }),
    );
    const modal = await fixture.open(admission.id);
    if (!modal.private_metadata) {
      throw new Error("Expected a recovery selector for the admission failure");
    }
    await fixture.submit(modal.private_metadata, "auto");
    await expect(
      chat.chat.readThreadMetadata(fixture.owner.actor, fixture.thread.id),
    ).resolves.toMatchObject({ selectedModel: "auto" });
  });

  it("keeps the original error for a non-model failure", async () => {
    const fixture = await failedSlackConversation("guest_home_filesystem_full");
    expect(fixture.failed.eventType).toBe("run.failed");
    const messages = context.mocks.slack.chat.postMessage.mock.calls
      .map(([body]) => {
        return postedMessageSchema.safeParse(body);
      })
      .filter((result) => {
        return result.success;
      });
    expect(
      messages.some((result) => {
        return result.data.blocks.some((block) => {
          return block.elements?.some((element) => {
            return element.action_id === "switch_model";
          });
        });
      }),
    ).toBeFalsy();
    expect(
      messages.some((result) => {
        return result.data.text.length > 0;
      }),
    ).toBeTruthy();
  });
});
