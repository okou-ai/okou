import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const { cancelChatRun } = createChatEventsFixture(context);

describe("captured My Okou execution guidance", () => {
  it("keeps fixed identity and personal scope through dispatch", async () => {
    const owned = await publicChatActor(context);
    const { actor } = owned;
    if (!actor.orgId) {
      throw new Error("Expected a workspace member");
    }
    await owned.run(async () => {
      const run = await owned.sendChatRun(actor, {
        prompt: "Work with my personal Instructions",
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
        "a successful switch also saves this Chat's current account for subsequent Runs",
      );
      await cancelChatRun(actor, run.runId);
    });
  });
});
