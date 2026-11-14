import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { testContext } from "../../../__tests__/test-context";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const fixture = createChatEventsFixture(context);

describe("captured My Okou execution guidance", () => {
  it("keeps fixed identity and personal scope through claim after a live flag change", async () => {
    const owned = await publicChatActor(context);
    const { actor } = owned;
    if (!actor.orgId) {
      throw new Error("Expected a workspace member");
    }
    const member = { ...actor, orgId: actor.orgId };
    await owned.run(async () => {
      fixture.bdd.acceptAgentStorageWrites();
      const status = await fixture.bdd.readOnboardingStatus(actor);
      if (!status.defaultAgentId) {
        throw new Error("Expected the workspace executor");
      }
      await fixture.bdd.updateAgentMetadata(actor, status.defaultAgentId, {
        description: "MUTABLE_SHARED_ROLE_DO_NOT_INHERIT",
        sound: "friendly",
      });
      owned.ownsFeatureSwitches();
      await updateFeatureSwitchesForUser(context, member, {
        [FeatureSwitchKey.SingleAgent]: true,
      });
      const run = await owned.sendChatRun(actor, {
        agentId: status.defaultAgentId,
        prompt: "Work with my personal Instructions",
      });
      await updateFeatureSwitchesForUser(context, member, {
        [FeatureSwitchKey.SingleAgent]: false,
      });
      const { execution } = await owned.runExecution(run.runId);
      const prompt = execution.appendSystemPrompt ?? "";
      expect(prompt).toContain(
        "# Identity\nYour name is Okou. You are the user's personal AI assistant in the current workspace.",
      );
      expect(prompt).toContain(
        "Communicate in a clear, polished, and business-appropriate tone",
      );
      expect(prompt).toContain("okou instructions view");
      expect(prompt).toContain("okou instructions edit --file <path>");
      expect(prompt).toContain(
        "Workflows are shared within the current workspace",
      );
      expect(prompt).toContain(
        "the user's same-name private Workflow takes precedence",
      );
      expect(prompt).toContain(
        "Saving does not replace the Instructions already loaded into work in progress",
      );
      expect(prompt).toContain("existing authorization rules");
      expect(prompt).toContain(
        "permission expiry/revocation, and purchase approvals",
      );
      expect(prompt).toContain("runtime child-task tools are execution tools");
      expect(prompt).toContain(
        "the current thread's override for future runs, not the current run or global default",
      );
      expect(prompt).not.toContain("MUTABLE_SHARED_ROLE_DO_NOT_INHERIT");
      expect(prompt).not.toContain("Communicate in a warm, approachable");
      expect(prompt).not.toContain("Agent instructions are team-shared");
      expect(prompt).not.toContain("okou agent edit");
      expect(prompt).not.toContain("okou agent view");
      await fixture.cancelChatRun(actor, run.runId);

      const legacy = await owned.sendChatRun(actor, {
        agentId: status.defaultAgentId,
        prompt: "Use the legacy saved mode",
      });
      const legacyExecution = await owned.runExecution(legacy.runId);
      expect(legacyExecution.execution.appendSystemPrompt).toContain(
        "MUTABLE_SHARED_ROLE_DO_NOT_INHERIT",
      );
      expect(legacyExecution.execution.appendSystemPrompt).toContain(
        "Agent instructions are team-shared",
      );
    });
  });

  it("retains legacy configuration for a non-default executor even when the member switch is enabled", async () => {
    const owned = await publicChatActor(context);
    const { actor, agentId } = owned;
    if (!actor.orgId) {
      throw new Error("Expected a workspace member");
    }
    await owned.run(async () => {
      owned.ownsFeatureSwitches();
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: actor.orgId! },
        { [FeatureSwitchKey.SingleAgent]: true },
      );
      const run = await owned.sendChatRun(actor, {
        agentId,
        prompt: "Read this retained executor's history",
      });
      const { execution } = await owned.runExecution(run.runId);
      expect(execution.appendSystemPrompt).toContain(
        "Exercises the web chat send route.",
      );
      expect(execution.appendSystemPrompt).toContain(
        "Agent instructions are team-shared",
      );
      expect(execution.appendSystemPrompt).not.toContain(
        "# Personal Instructions and memory",
      );
    });
  });
});
