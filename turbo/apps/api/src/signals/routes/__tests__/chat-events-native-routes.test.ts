import { publicChatActor } from "./helpers/public-chat-actor";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { accept, testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { expectThreadModelCredits } from "./helpers/public-thread-usage";
import {
  createChatEventsFixture,
  claimEnvironment,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  authDeviceSupport,
  entitledNativeChatActor,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
  sessionHeaders,
  threadPiAutomationsClient,
  postThreadPiAutomationEvent,
  lastThreadPiAutomationRun,
  waitForRunStatus,
  completeChatRunOk,
} = createChatEventsFixture(context);

describe("personal native subscription activation", () => {
  it.each(["schedule", "event"] as const)(
    "uses the personal Claude %s Automation handoff and completion",
    async (source) => {
      const {
        actor,
        agentId,
        runnerGroup,
        run: own,
        ownsFeatureSwitches,
        claimChatRun,
      } = await publicChatActor(context, {
        tier: source === "event" ? "team" : "pro",
      });
      ownsFeatureSwitches();
      await own(async () => {
        await authDeviceSupport.updateFeatureSwitches(actor, {
          [FeatureSwitchKey.PiMemory]: true,
        });
        const workflows = createWorkflowsBddApi(context);
        const workflowId = await workflows.createWorkflow(actor, {
          agentId,
          name: `personal-source-${source}`,
        });
        const created = await accept(
          threadPiAutomationsClient().create({
            headers: sessionHeaders(actor),
            params: { workflowId },
            body:
              source === "schedule"
                ? { schedule: { type: "loop", intervalSeconds: 3600 } }
                : { kind: "event", eventType: "webhook-received" },
          }),
          [201],
        );
        const automation = created.body;
        let threadId: string;
        if (
          automation.kind === "event" &&
          automation.eventType === "webhook-received" &&
          automation.webhookUrl &&
          automation.webhookSecret &&
          automation.chatThreadId
        ) {
          const event = {
            webhookUrl: automation.webhookUrl,
            webhookSecret: automation.webhookSecret,
            payload: "personal event",
            timestamp: Math.floor(now() / 1000),
          };
          await expect(
            postThreadPiAutomationEvent(event),
          ).resolves.toMatchObject({ duplicate: false });
          await expect(
            postThreadPiAutomationEvent(event),
          ).resolves.toMatchObject({ duplicate: true });
          threadId = automation.chatThreadId;
        } else {
          const started = await accept(
            threadPiAutomationsClient().run({
              headers: sessionHeaders(actor),
              params: { id: automation.id },
            }),
            [201],
          );
          threadId = started.body.chatThreadId;
        }
        const runId = await lastThreadPiAutomationRun(actor, threadId);
        await flushWaitUntilForTest();
        const { claim, sandboxHeaders } = await claimChatRun(
          runnerGroup,
          runId,
        );
        expect(claim.cliAgentType).toBe("claude-code");
        expect(claim.piModelConfig).toBeUndefined();
        expect(claimEnvironment(claim).CLAUDE_CODE_OAUTH_TOKEN).toBeTruthy();
        await expect(api.readRun(actor, runId)).resolves.toMatchObject({
          source: {
            model: "claude-fable-5-1",
            providerType: "claude-code-oauth-token",
            credentialScope: "member",
          },
        });
        await completeChatRunOk(runId, sandboxHeaders, {
          cliAgentType: "claude-code",
        });
        await waitForRunStatus(actor, runId, "completed");
        await flushWaitUntilForTest();
        const page = await chat.listThreadEvents(actor, threadId);
        expect(
          page.events
            .filter((event) => {
              return (
                event.runId === runId &&
                isChatRunTerminalEventType(event.eventType)
              );
            })
            .map((event) => {
              return event.eventType;
            }),
        ).toStrictEqual(["run.completed"]);
        await expectThreadModelCredits(context, actor, threadId, 0);
      });
    },
    90_000,
  );

  it("keeps official Claude member subscription credentials on Claude Code with Pi enabled", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PiMemory]: true,
    });
    const run = await sendChatRun(actor, {
      agentId,
      model: "claude-fable-5-1",
      prompt: "retain official Claude subscription ownership",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    expect(claim.cliAgentType).toBe("claude-code");
    expect(claim.piModelConfig).toBeUndefined();
    expect(claimEnvironment(claim).CLAUDE_CODE_OAUTH_TOKEN).toBeTruthy();
    await cancelChatRun(actor, run.runId, sandboxHeaders);
  }, 90_000);
});
