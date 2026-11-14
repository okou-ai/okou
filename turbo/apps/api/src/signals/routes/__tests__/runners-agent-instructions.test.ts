import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { readExecutionContentBundle } from "./helpers/execution-content-bundle";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

const context = testContext();
const api = createRunsApi(context);

describe("API dispatch-time Agent instructions", () => {
  it("pins published instruction bytes at dispatch and selects later edits for later Runs", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const bdd = createBddApi(context);
      const s3 = installWorkflowVolumeS3Fixture(context);
      await bdd.updateAgentInstructions(
        owned.actor,
        owned.agentId,
        "A at queue time",
      );
      const queued = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "claim current instructions",
        model: "auto",
      });
      const current = "\uFEFF  B before claim\r\n中文\n[AGENT_PROFILE]\n  ";
      await bdd.updateAgentInstructions(owned.actor, owned.agentId, current);
      const { execution } = await owned.runExecution(queued.runId);
      const selected = execution.contentBundles.instructions!;
      expect(
        readExecutionContentBundle(s3.objects, selected)
          .get("instructions.md")
          ?.toString(),
      ).toBe("A at queue time");
      await bdd.updateAgentInstructions(
        owned.actor,
        owned.agentId,
        "C after claim",
      );
      expect(
        readExecutionContentBundle(s3.objects, selected)
          .get("instructions.md")
          ?.toString(),
      ).toBe("A at queue time");
      const next = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "claim the later edit",
        model: "auto",
      });
      const subsequent = await owned.runExecution(next.runId);
      const later = subsequent.execution.contentBundles.instructions!;
      expect(later.sha256).not.toBe(selected.sha256);
      expect(
        readExecutionContentBundle(s3.objects, later)
          .get("instructions.md")
          ?.toString(),
      ).toBe("C after claim");
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
      await bdd.updateAgentInstructions(
        owned.actor,
        owned.agentId,
        "Old managed file",
      );
      await bdd.updateAgentInstructions(owned.actor, owned.agentId, "");
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

  it("rejects later member inputs after the Agent becomes private and retains published instructions", async () => {
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
      const queued = await api.createThreadRun(member, {
        agentId: owned.agentId,
        prompt: "require current Agent eligibility",
        model: "gpt-6-luna",
      });
      await bdd.updateAgentMetadata(owned.actor, owned.agentId, {
        visibility: "private",
      });
      const rejected = await createChatFilesBddApi(context).requestSendEvent(
        member,
        {
          agentId: owned.agentId,
          model: "gpt-6-luna",
          prompt: "Require current private Agent authority",
        },
        [403],
      );
      expect(rejected.body).toMatchObject({
        error: { message: "Only the private agent owner can run this agent" },
      });
      await bdd.updateAgentMetadata(owned.actor, owned.agentId, {
        visibility: "public",
      });
      const { execution } = await owned.runExecution(queued.runId);
      expect(execution.contentBundles.instructions).toMatchObject({
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        archiveBytes: expect.any(Number),
      });
    });
  });
});
