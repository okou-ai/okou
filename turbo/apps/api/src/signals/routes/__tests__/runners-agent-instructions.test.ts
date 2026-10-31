import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { readClaimedContentBundle } from "./helpers/claimed-content-bundle";

const context = testContext();
const api = createRunsApi(context);

describe("Runner claim-time Agent instructions", () => {
  it("pins published instruction bytes at claim and selects later edits only for later claims", async () => {
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
      const { claim } = await owned.claimChatRun(
        owned.runnerGroup,
        queued.runId,
      );
      const selected = claim.contentBundles.instructions!;
      expect(
        readClaimedContentBundle(s3.objects, selected)
          .get("instructions.md")
          ?.toString(),
      ).toBe(current);
      await bdd.updateAgentInstructions(
        owned.actor,
        owned.agentId,
        "C after claim",
      );
      expect(
        readClaimedContentBundle(s3.objects, selected)
          .get("instructions.md")
          ?.toString(),
      ).toBe(current);
      const next = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "claim the later edit",
        model: "auto",
      });
      const subsequent = await owned.claimChatRun(
        owned.runnerGroup,
        next.runId,
      );
      const later = subsequent.claim.contentBundles.instructions!;
      expect(later.sha256).not.toBe(selected.sha256);
      expect(
        readClaimedContentBundle(s3.objects, later)
          .get("instructions.md")
          ?.toString(),
      ).toBe("C after claim");
      await expect(
        api.readRun(owned.actor, queued.runId),
      ).resolves.toMatchObject({ status: "running" });
    });
  });

  it("claims an empty-file package when instructions are cleared before claim", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const bdd = createBddApi(context);
      const s3 = installWorkflowVolumeS3Fixture(context);
      await bdd.updateAgentInstructions(
        owned.actor,
        owned.agentId,
        "Old managed file",
      );
      const queued = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "clear instructions",
        model: "auto",
      });
      await bdd.updateAgentInstructions(owned.actor, owned.agentId, "");
      const { claim } = await owned.claimChatRun(
        owned.runnerGroup,
        queued.runId,
      );
      const files = readClaimedContentBundle(
        s3.objects,
        claim.contentBundles.instructions!,
      );
      expect([...files.keys()]).toStrictEqual(["instructions.md"]);
      expect(files.get("instructions.md")?.length).toBe(0);
    });
  });

  it("refuses a now-private Agent without consuming the queued claim", async () => {
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
      const rejected = await api.requestClaimRunnerJob(
        true,
        queued.runId,
        [404],
      );
      expect(rejected.body).toMatchObject({
        error: { message: "Agent not found" },
      });
      await bdd.updateAgentMetadata(owned.actor, owned.agentId, {
        visibility: "public",
      });
      const { claim } = await owned.claimChatRun(
        owned.runnerGroup,
        queued.runId,
      );
      expect(claim.contentBundles.instructions).toMatchObject({
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        archiveBytes: expect.any(Number),
      });
    });
  });
});
