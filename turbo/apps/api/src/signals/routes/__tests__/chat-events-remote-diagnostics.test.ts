import { expect, test } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();

test("claims exact-attempt SSH and VNC guidance", async () => {
  const owned = await publicChatActor(context);
  await owned.run(async () => {
    const { actor, agentId, runnerGroup } = owned;
    const run = await owned.sendChatRun(actor, {
      agentId,
      prompt: "Explain the retained failure from my remote operation",
    });
    const { claim } = await owned.claimChatRun(runnerGroup, run.runId);
    const prompt = claim.appendSystemPrompt ?? "";
    expect(prompt).toContain("- VNC: use");

    for (const protocol of ["ssh", "vnc"] as const) {
      const prefix = `- Remote ${protocol.toUpperCase()} failures:`;
      const guidance = prompt.split("\n").find((line) => {
        return line.startsWith(prefix);
      });
      expect(guidance).toContain("actual failed operation's Attempt ID");
      expect(guidance).toContain(
        `okou ${protocol} diagnose <connection-id> --attempt-id <attempt-id> --json`,
      );
      expect(guidance).toContain("`--session-id <id>` when known");
      expect(guidance).toContain("Use IDs from that failed operation");
      expect(guidance).toContain("latest matching retained failure");
      expect(guidance).toContain(
        "verify its operation, connection, session, and time before attributing it",
      );
      expect(guidance).toContain(
        "If the exact attempt is not retained, report its evidence as unavailable; do not substitute another failure",
      );
      expect(guidance).toContain("passive history within this Run");
      expect(guidance).toContain("not a current-connectivity check");
      expect(guidance).toContain(
        "unavailable evidence does not establish a cause",
      );
      expect(guidance).toContain(
        protocol === "ssh"
          ? "Never automatically replay an uncertain command or check"
          : "Never automatically replay uncertain input or checks",
      );
    }
  });
});
