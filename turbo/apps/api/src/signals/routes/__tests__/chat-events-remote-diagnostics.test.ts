import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { requireOrgId } from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();

test.each([
  { diagnostics: true, vnc: true },
  { diagnostics: true, vnc: false },
  { diagnostics: false, vnc: true },
  { diagnostics: false, vnc: false },
])(
  "claims exact-attempt guidance with diagnostics=$diagnostics and vnc=$vnc",
  async ({ diagnostics, vnc }) => {
    const owned = await publicChatActor(context);
    owned.ownsFeatureSwitches();
    await owned.run(async () => {
      const { actor, agentId, runnerGroup } = owned;
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: requireOrgId(actor) },
        {
          [FeatureSwitchKey.RemoteConnectionDiagnostics]: diagnostics,
          [FeatureSwitchKey.VncAccess]: vnc,
        },
      );
      const run = await owned.sendChatRun(actor, {
        agentId,
        prompt: "Explain the retained failure from my remote operation",
      });
      const { claim } = await owned.claimChatRun(runnerGroup, run.runId);
      const prompt = claim.appendSystemPrompt ?? "";
      expect(prompt.includes("- VNC: use")).toBe(vnc);

      for (const protocol of ["ssh", "vnc"] as const) {
        const prefix = `- Remote ${protocol.toUpperCase()} failures:`;
        const guidance = prompt.split("\n").find((line) => {
          return line.startsWith(prefix);
        });
        if (!diagnostics || (protocol === "vnc" && !vnc)) {
          expect(guidance).toBeUndefined();
          continue;
        }
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
  },
);
