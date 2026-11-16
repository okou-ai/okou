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
  failureReason = "account_verification_required",
) {
  const owner = await publicChatActor(context);

  const installed = await owner.run(() => {
    return slack.installOrg({ actor: owner.actor, withConnection: true });
  });
  chat.chatCallbacks.acceptChatObjectStorage();
  chat.api.acceptStorageDownloads();
  chat.api.acceptTelemetryIngest();
  context.mocks.slack.views.update.mockResolvedValue({ ok: true });
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
        error: "Claude account requires verification",
        failureReason,
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
  it("switches the failed DM to GPT without changing the default or replaying the failed request", async () => {
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
    await chat.chat.requestSetThreadArchived(
      fixture.owner.actor,
      fixture.thread.id,
      true,
      [204],
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
    const beforeResend = await reads.requestListLogs(
      fixture.owner.actor,
      { triggerSource: "slack", limit: 50 },
      [200],
    );
    expect(
      beforeResend.body.data.map((run) => {
        return run.id;
      }),
    ).toStrictEqual([fixture.runId]);
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
        "Expected the next Slack request on the same conversation",
      );
    }
    expect(
      (await chat.api.readRun(fixture.owner.actor, nextInput.runId)).source
        .model,
    ).toBe("gpt-6-luna");
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
