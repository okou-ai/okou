import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { testContext } from "../../../__tests__/test-context";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const { cancelChatRun } = createChatEventsFixture(context);

describe("custom-domain CLI guidance in the dispatched system prompt", () => {
  it.each([false, true])(
    "includes custom-domain instructions only when the feature is enabled: %s",
    async (enabled) => {
      const owned = await publicChatActor(context);
      const { actor } = owned;
      const orgId = actor.orgId;
      if (!orgId) {
        throw new Error("Expected a workspace member");
      }
      owned.ownsFeatureSwitches();
      await owned.run(async () => {
        await updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId },
          { [FeatureSwitchKey.HostedSiteCustomDomains]: enabled },
        );
        const run = await owned.sendChatRun(actor, {
          prompt: "Connect my website's custom domain",
        });
        const { execution } = await owned.runExecution(run.runId);
        const prompt = execution.appendSystemPrompt ?? "";
        if (enabled) {
          expect(prompt).toContain("okou host domain --help");
          expect(prompt).toContain("okou host domain add <site> <hostname>");
          expect(prompt).toContain("okou host domain verify <site> <hostname>");
          expect(prompt).toContain("additional certificate TXT records");
          expect(prompt).toContain("Only after all checks are ready");
          expect(prompt).toContain("Do not poll or guess DNS targets");
          expect(prompt).toContain("keeping connected domains active");
          expect(prompt).toContain("paid-subscription requirement");
          expect(prompt).toContain(
            "Preserve the website's existing visibility",
          );
        } else {
          expect(prompt).not.toContain("okou host domain");
        }
        await cancelChatRun(actor, run.runId);
      });
    },
  );
});
