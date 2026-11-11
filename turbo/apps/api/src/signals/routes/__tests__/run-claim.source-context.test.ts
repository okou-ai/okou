import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { userPreferencesRoutes } from "../user-preferences";
import { chatThreadRoutes } from "../chat-threads";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const fixture = createChatEventsFixture(context);

describe("Runner Claim current member and account sources", () => {
  it.each([false, true])(
    "retains the accepted explicit selection while pending (Chat accounts: %s)",
    async (chatAccounts) => {
      const owned = await publicChatActor(context);
      owned.ownsFeatureSwitches();
      await owned.run(async () => {
        await fixture.connectors.updateFeatureSwitches(owned.actor, {
          connectorChatAccountAccess: chatAccounts,
        });
        const first = await fixture.connectors.connectManualGrant(
          owned.actor,
          "openai",
          "api-token",
          { apiKey: "default-native-account" },
          owned.agentId,
        );
        const selected = await fixture.connectors.connectManualGrant(
          owned.actor,
          "openai",
          "api-token",
          { apiKey: "accepted-native-account" },
          owned.agentId,
        );
        const thread = await fixture.chat.createThread(owned.actor, {
          agentId: owned.agentId,
          title: "Accepted account intent",
        });
        const selections = setupApp({ context, routes: chatThreadRoutes })(
          chatThreadConnectorSelectionContract,
        );
        async function select(connectionId: string) {
          await accept(
            selections.update({
              headers: fixture.sessionHeaders(owned.actor),
              params: { id: thread.id },
              body: {
                connectionId,
                target: { kind: "builtin", connectorSlug: "openai" },
              },
            }),
            [200],
          );
        }
        await select(selected.id);
        const queued = await fixture.sendChatRun(owned.actor, {
          agentId: owned.agentId,
          threadId: thread.id,
          model: "claude-fable-5-1",
          prompt: "Keep this Run's explicit account intent",
        });
        await select(first.id);
        const { claim, sandboxHeaders } = await fixture.claimChatRun(
          owned.runnerGroup,
          queued.runId,
        );
        owned.rememberClaim(queued.runId, claim.sandboxToken);
        expect(claim.environment?.OPENAI_TOKEN).toBe("accepted-native-account");
        expect(claim.secretConnectorMetadataMap?.OPENAI_TOKEN).toMatchObject({
          sourceId: selected.id,
        });
        await fixture.cancelChatRun(owned.actor, queued.runId, sandboxHeaders);
      });
    },
  );

  it.each([false, true])(
    "selects an account connected after admission (Chat accounts: %s)",
    async (chatAccounts) => {
      const owned = await publicChatActor(context);
      owned.ownsFeatureSwitches();
      await owned.run(() => {
        return fixture.connectors.updateFeatureSwitches(owned.actor, {
          connectorChatAccountAccess: chatAccounts,
        });
      });
      const queued = await owned.sendChatRun(owned.actor, {
        agentId: owned.agentId,
        model: "claude-fable-5-1",
        prompt: "Use the account available when the Runner claims",
      });
      const connection = await owned.run(() => {
        return fixture.connectors.connectManualGrant(
          owned.actor,
          "figma",
          "api-token",
          { accessToken: "connected-after-admission" },
          owned.agentId,
        );
      });
      const { claim, sandboxHeaders } = await owned.claimChatRun(
        owned.runnerGroup,
        queued.runId,
      );
      expect(claim.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining({
          kind: "builtin",
          connectorSlug: "figma",
          sourceId: connection.id,
        }),
      );
      expect(claim.secretConnectorMetadataMap?.FIGMA_TOKEN).toMatchObject({
        sourceId: connection.id,
      });
      await owned.run(() => {
        return fixture.cancelChatRun(owned.actor, queued.runId, sandboxHeaders);
      });
    },
  );

  it.each([false, true])(
    "uses the current default account at Claim (Chat accounts: %s)",
    async (chatAccounts) => {
      const owned = await publicChatActor(context);
      owned.ownsFeatureSwitches();
      await owned.run(() => {
        return fixture.connectors.updateFeatureSwitches(owned.actor, {
          connectorChatAccountAccess: chatAccounts,
        });
      });
      await owned.run(() => {
        return fixture.connectors.connectManualGrant(
          owned.actor,
          "figma",
          "api-token",
          { accessToken: "previous-default" },
          owned.agentId,
        );
      });
      const next = await owned.run(() => {
        return fixture.connectors.connectManualGrant(
          owned.actor,
          "figma",
          "api-token",
          { accessToken: "claim-default" },
          owned.agentId,
        );
      });
      const queued = await owned.sendChatRun(owned.actor, {
        agentId: owned.agentId,
        model: "claude-fable-5-1",
        prompt: "Resolve the current default at Claim",
      });
      await owned.run(() => {
        return fixture.connectors.setDefaultBuiltinConnectorAccount(
          owned.actor,
          "figma",
          next.id,
        );
      });
      const { claim, sandboxHeaders } = await owned.claimChatRun(
        owned.runnerGroup,
        queued.runId,
      );
      expect(claim.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining({
          kind: "builtin",
          connectorSlug: "figma",
          sourceId: next.id,
        }),
      );
      expect(claim.secretConnectorMetadataMap?.FIGMA_TOKEN).toMatchObject({
        sourceId: next.id,
      });
      await owned.run(() => {
        return fixture.cancelChatRun(owned.actor, queued.runId, sandboxHeaders);
      });
    },
  );

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
