import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { array, object, string, unknown as zUnknown } from "zod";
import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createPublicTeamsDispatchFixture } from "./helpers/public-teams-dispatch-fixture";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  postTeamsActivityForTest,
  teamsMessageActivityForTest,
} from "./helpers/teams-connect";

const context = testContext();

describe("integration model recovery in Teams", () => {
  it("opens a native dialog and saves only the requesting owner's conversation", async () => {
    const fixtures = createPublicTeamsDispatchFixture(context);
    const runs = createRunsApi(context);
    const reads = createRunReadsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const chat = createChatFilesBddApi(context);
    await fixtures.run(async () => {
      const fixture = await fixtures.create({
        withDefaultAgent: true,
        paidNative: true,
      });
      await fixtures.dispatch(fixture, "Recover this Teams model");
      const listed = await reads.requestListLogs(
        fixture.actor,
        { triggerSource: "teams", limit: 10 },
        [200],
      );
      const run = listed.body.data[0];
      if (!run) {
        throw new Error("Expected a Teams run");
      }
      await runs.heartbeatRunner("vm0/test");
      const execution = await runs.executionInput(run.id);
      const messages: unknown[] = [];
      server.use(
        http.post(
          `${fixture.installation.serviceUrl}v3/conversations/:conversationId/activities/:activityId`,
          async ({ request }) => {
            messages.push(await request.json());
            return HttpResponse.json({ id: "model-error" });
          },
        ),
      );
      await webhooks.requestAgentComplete(
        {
          runId: run.id,
          exitCode: 1,
          error: "Claude verification required",
          failureReason: "account_verification_required",
        },
        { authorization: `Bearer ${execution.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
      const error = object({
        attachments: array(
          object({
            content: object({
              actions: array(
                object({
                  title: string(),
                  data: object({ action: string(), eventId: string() }),
                }),
              ),
            }),
          }),
        ),
      }).parse(messages.at(-1));
      const action = error.attachments[0]?.content.actions[0];
      if (!action) {
        throw new Error("Expected the error's switch-model action");
      }
      expect(action.title).toBe("Switch model");
      const threadEvents = await chat.requestThreadEvents(
        fixture.actor,
        {},
        [200],
      );
      if (threadEvents.status !== 200) {
        throw new Error("Expected the conversation list");
      }
      const thread = threadEvents.body.events.find((event) => {
        return event.kind === "created";
      });
      if (!thread) {
        throw new Error("Expected the canonical Teams conversation");
      }
      const activity = teamsMessageActivityForTest(fixture.installation, {
        type: "invoke",
        name: "task/fetch",
        conversation: {
          id: "19:e2e-dm@thread.v2",
          conversationType: "personal",
        },
        value: { data: action.data },
      });
      const opened = await postTeamsActivityForTest({
        signal: context.signal,
        activity,
      });
      expect(opened.status).toBe(200);
      const picker = object({
        task: object({
          type: string(),
          value: object({
            card: object({
              content: object({
                body: array(zUnknown()),
                actions: array(
                  object({
                    data: object({
                      action: string(),
                      eventId: string(),
                      selectedModel: string(),
                      updatedAt: string(),
                    }).optional(),
                  }),
                ),
              }),
            }),
          }),
        }),
      }).parse(await opened.json());
      expect(picker.task.type).toBe("continue");
      const state = picker.task.value.card.content.actions[0]?.data;
      if (!state) {
        throw new Error("Expected the native dialog's model state");
      }
      const wrongSender = await postTeamsActivityForTest({
        signal: context.signal,
        activity: {
          ...activity,
          name: "task/submit",
          from: { id: "another-teams-user" },
          value: { data: { ...state, model: "auto" } },
        },
      });
      await expect(wrongSender.json()).resolves.toMatchObject({
        task: {
          type: "message",
          value: expect.stringContaining("no longer current"),
        },
      });
      expect(
        (await chat.readThreadMetadata(fixture.actor, thread.chatThreadId))
          .selectedModel,
      ).toBe("claude-fable-5-1");
      const saved = await postTeamsActivityForTest({
        signal: context.signal,
        activity: {
          ...activity,
          name: "task/submit",
          value: { data: { ...state, model: "auto" } },
        },
      });
      await expect(saved.json()).resolves.toMatchObject({
        task: {
          type: "message",
          value: expect.stringContaining("Switched to Auto"),
        },
      });
      expect(
        (await chat.readThreadMetadata(fixture.actor, thread.chatThreadId))
          .selectedModel,
      ).toBe("auto");
      expect(
        (
          await reads.requestListLogs(
            fixture.actor,
            { triggerSource: "teams", limit: 10 },
            [200],
          )
        ).body.data,
      ).toHaveLength(1);
    });
  });
});
