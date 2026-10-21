import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();
const api = createRunsApi(context);

describe("Runner claim-time Agent instructions", () => {
  it("selects edits committed after queueing, preserves raw text, and leaves the claimed body unchanged", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const bdd = createBddApi(context);
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
      expect(claim.agentInstructions).toBe(current);
      await bdd.updateAgentInstructions(
        owned.actor,
        owned.agentId,
        "C after claim",
      );
      const next = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "claim the later edit",
        model: "auto",
      });
      const subsequent = await owned.claimChatRun(
        owned.runnerGroup,
        next.runId,
      );
      expect(subsequent.claim.agentInstructions).toBe("C after claim");
      await expect(
        api.readRun(owned.actor, queued.runId),
      ).resolves.toMatchObject({ status: "running" });
    });
  });

  it("returns an explicit empty body when instructions are cleared before claim", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const bdd = createBddApi(context);
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
      expect(claim.agentInstructions).toBe("");
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
      await api.requestClaimRunnerJob(true, queued.runId, [404]);
      await bdd.updateAgentMetadata(owned.actor, owned.agentId, {
        visibility: "public",
      });
      const { claim } = await owned.claimChatRun(
        owned.runnerGroup,
        queued.runId,
      );
      expect(claim.agentInstructions).toBe("");
    });
  });
});
