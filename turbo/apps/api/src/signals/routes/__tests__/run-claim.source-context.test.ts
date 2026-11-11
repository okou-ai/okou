import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { userPreferencesRoutes } from "../user-preferences";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const fixture = createChatEventsFixture(context);

describe("Runner Claim current member and account sources", () => {
  it.each([0, 20])(
    "uses queued preference changes with %s saved accounts",
    async (accountCount) => {
      const preferences = (
        await setupApp({
          context,
          routes: userPreferencesRoutes,
          isolatePg: true,
        })
      )(userPreferencesContract);
      const owned = await publicChatActor(context);
      await owned.run(async () => {
        for (let index = 0; index < accountCount; index += 1) {
          await fixture.connectors.connectManualGrant(
            owned.actor,
            "figma",
            "api-token",
            { accessToken: `claim-member-account-${index}` },
            owned.agentId,
          );
        }
        await accept(
          preferences.update({
            headers: fixture.sessionHeaders(owned.actor),
            body: { timezone: "Asia/Tokyo" },
          }),
          [200],
        );
      });
      const queued = await owned.sendChatRun(owned.actor, {
        agentId: owned.agentId,
        model: "claude-fable-5-1",
        prompt: "Use the member preferences current when the Runner claims",
      });
      await owned.run(async () => {
        await accept(
          preferences.update({
            headers: fixture.sessionHeaders(owned.actor),
            body: { timezone: "America/Los_Angeles" },
          }),
          [200],
        );
        const { claim, sandboxHeaders } = await fixture.claimChatRun(
          owned.runnerGroup,
          queued.runId,
        );
        owned.rememberClaim(queued.runId, claim.sandboxToken);
        expect(claim.userTimezone).toBe("America/Los_Angeles");
        expect(
          claim.connectorRuntimeTargets.filter((target) => {
            return (
              target.kind === "builtin" && target.connectorSlug === "figma"
            );
          }),
        ).toHaveLength(accountCount === 0 ? 0 : 1);
        await fixture.cancelChatRun(owned.actor, queued.runId, sandboxHeaders);
      });
    },
  );
});
