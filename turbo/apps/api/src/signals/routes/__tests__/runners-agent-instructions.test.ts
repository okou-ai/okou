import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { buildArtifactPrefix } from "../../../lib/file-url";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { readExecutionContentBundle } from "./helpers/execution-content-bundle";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

const context = testContext();
const api = createRunsApi(context);

describe("Published member instructions in direct Runs", () => {
  it("keeps each Run's published instruction bytes across later edits", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const bdd = createBddApi(context);
      const s3 = installWorkflowVolumeS3Fixture(context);
      await bdd.updatePersonalInstructions(owned.actor, "A at admission");
      const queued = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "execute with admitted instructions",
        model: "auto",
      });
      const current =
        "\uFEFF  B after Run creation\r\n中文\n[AGENT_PROFILE]\n  ";
      await bdd.updatePersonalInstructions(owned.actor, current);
      const { execution } = await owned.runExecution(queued.runId);
      const selected = execution.contentBundles.instructions!;
      expect(
        readExecutionContentBundle(s3.objects, selected)
          .get("instructions.md")
          ?.toString(),
      ).toBe("A at admission");
      await bdd.updatePersonalInstructions(
        owned.actor,
        "C after first publication",
      );
      expect(
        readExecutionContentBundle(s3.objects, selected)
          .get("instructions.md")
          ?.toString(),
      ).toBe("A at admission");
      const next = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "execute with the later edit",
        model: "auto",
      });
      const subsequent = await owned.runExecution(next.runId);
      const later = subsequent.execution.contentBundles.instructions!;
      expect(later.sha256).not.toBe(selected.sha256);
      expect(
        readExecutionContentBundle(s3.objects, later)
          .get("instructions.md")
          ?.toString(),
      ).toBe("C after first publication");
      await expect(
        api.readRun(owned.actor, queued.runId),
      ).resolves.toMatchObject({ status: "running" });
    });
  });

  it("dispatches an empty-file package when instructions are cleared before launch", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const bdd = createBddApi(context);
      const s3 = installWorkflowVolumeS3Fixture(context);
      await bdd.updatePersonalInstructions(owned.actor, "Old managed file");
      await bdd.updatePersonalInstructions(owned.actor, "");
      const queued = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "clear instructions",
        model: "auto",
      });
      const { execution } = await owned.runExecution(queued.runId);
      const files = readExecutionContentBundle(
        s3.objects,
        execution.contentBundles.instructions!,
      );
      expect([...files.keys()]).toStrictEqual(["instructions.md"]);
      expect(files.get("instructions.md")?.length).toBe(0);
    });
  });

  it("reuses the sending member's instructions captured before attachment verification", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const bdd = createBddApi(context);
      const member = bdd.user({
        orgId: owned.actor.orgId,
        orgRole: "org:member",
      });
      await bdd.updateAgentMetadata(owned.actor, owned.agentId, {
        visibility: "public",
      });
      await bdd.completeOnboarding(member);
      await createChatEventsFixture(context).configureSubscriptionPiModel(
        member,
      );
      const chat = createChatFilesBddApi(context);
      const fileId = randomUUID();
      const filename = "attachment.txt";
      chat.mockCompletedUploadObject(member, fileId, filename, 42);
      const s3 = installWorkflowVolumeS3Fixture(context, new Map(), {
        bundlesOnly: true,
      });
      await bdd.updatePersonalInstructions(
        member,
        "Instructions captured before attachment verification",
      );
      const send = context.mocks.s3.send.getMockImplementation();
      if (!send) {
        throw new Error("Expected the object store fixture");
      }
      context.mocks.s3.send.mockImplementation(async (command: unknown) => {
        if (
          command instanceof ListObjectsV2Command &&
          command.input.Prefix === buildArtifactPrefix(member.userId, fileId)
        ) {
          await flushWaitUntilForTest();
          await bdd.updatePersonalInstructions(
            member,
            "Member instructions updated during attachment verification",
          );
          await bdd.updateAgentMetadata(owned.actor, owned.agentId, {
            visibility: "private",
          });
        }
        return await send(command);
      });
      const { runId } = await chat.sendAndLaunch(member, {
        prompt: "Launch with my personal instructions",
        model: "gpt-6-luna",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Launch with my personal instructions" },
            {
              type: "file",
              fileId,
              filenameSnapshot: filename,
              contentType: "text/plain",
            },
          ],
        },
      });
      const { execution } = await owned.runExecution(runId);
      expect(
        readExecutionContentBundle(
          s3.objects,
          execution.contentBundles.instructions!,
        )
          .get("instructions.md")
          ?.toString(),
      ).toBe("Instructions captured before attachment verification");
    });
  });
});
