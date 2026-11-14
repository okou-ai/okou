import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { getCustomConnectorSkillName } from "@okouai/core/storage-names";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { workflowsRoutes } from "../workflows";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { readClaimedContentBundle } from "./helpers/claimed-content-bundle";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { publicChatActor } from "./helpers/public-chat-actor";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();

describe("Connector Skill bundle delivery", () => {
  it.each([false, true])(
    "delivers current custom configuration and Skill bytes (Chat accounts: %s)",
    async (chatAccounts) => {
      const owner = await publicChatActor(context);
      owner.ownsFeatureSwitches();
      const fixture = createChatEventsFixture(context);
      const api = createConnectorBddApi(context);
      const { selected, s3, connectionId } = await owner.run(async () => {
        const s3 = installWorkflowVolumeS3Fixture(context);
        const selected = await api.createCustomConnector(owner.actor, {
          displayName: "Default bundle delivery",
          prefixTemplates: ["https://default-skill.example.test/api/"],
          fields: [],
          headerInjections: [],
          queryInjections: [],
          authMode: "none",
          skillMarkdown: "Selected Skill instructions.",
        });
        const account = await api.setCustomConnectorValues(
          owner.actor,
          selected.id,
          [],
        );
        await api.updateAgentCustomConnectors(owner.actor, owner.agentId, [
          selected.id,
        ]);
        await api.updateFeatureSwitches(owner.actor, {
          [FeatureSwitchKey.ConnectorChatAccountAccess]: chatAccounts,
        });
        return { selected, s3, connectionId: account.connectionId };
      });
      const queued = await owner.queueChatRun(owner.actor, {
        agentId: owner.agentId,
        model: "claude-fable-5-1",
        prompt: "Use the selected custom Skill",
      });
      await owner.run(async () => {
        await api.updateCustomConnector(owner.actor, selected.id, {
          displayName: "Default bundle delivery",
          prefixTemplates: ["https://updated-skill.example.test/api/"],
          fields: [],
          headerInjections: [],
          queryInjections: [],
          authMode: "none",
          skillMarkdown: "Selected Skill instructions.",
        });
        await api.setCustomConnectorValues(owner.actor, selected.id, [], {
          intent: "reconnect",
          connectionId,
        });
      });
      const run = await queued.launch();
      const claimed = await owner.claimChatRun(owner.runnerGroup, run.runId);
      const firewall = claimed.claim.firewalls?.find((entry) => {
        return (
          entry.kind === "inline" && entry.customConnectorId === selected.id
        );
      });
      expect(firewall).toMatchObject({
        kind: "inline",
        customConnectorId: selected.id,
        firewall: {
          apis: [
            expect.objectContaining({
              base: "https://updated-skill.example.test/api/",
            }),
          ],
        },
      });
      const mountPath = `/home/user/.claude/skills/${getCustomConnectorSkillName(selected.slug, selected.id)}`;
      const bundle = claimed.claim.contentBundles.skills.find((candidate) => {
        return candidate.mountPath === mountPath;
      })!;
      expect(
        readClaimedContentBundle(s3.objects, bundle)
          .get("SKILL.md")
          ?.toString(),
      ).toContain("Selected Skill instructions.");
      await owner.run(() => {
        return fixture.failChatRun(
          run.runId,
          claimed.sandboxHeaders,
          "Default bundle inspected",
        );
      });
    },
  );

  it.each([
    {
      framework: "claude-code",
      root: "/home/user/.claude/skills",
      model: "claude-fable-5-1",
    },
    {
      framework: "codex",
      root: "/home/user/.codex/skills",
      model: "gpt-6-luna",
    },
    {
      framework: "pi",
      root: "/home/user/.pi/agent/skills",
      model: "gpt-6-luna",
    },
  ] as const)(
    "delivers current authorized $framework Skill bytes at Claim and for the next Run",
    async ({ framework, root, model }) => {
      const owner = await publicChatActor(context);
      owner.ownsFeatureSwitches();
      const fixture = createChatEventsFixture(context);
      const api = createConnectorBddApi(context);
      const body = manualHttpCustomConnectorCreateBody({
        displayName: "Selected connector",
        prefixTemplates: ["https://selected-skill.example.test/api/"],
        skillMarkdown: "Original instructions with authored Unicode: 技能。",
      });
      const { selected, s3 } = await owner.run(async () => {
        await fixture.configureSubscriptionPiModel(owner.actor);
        if (!owner.actor.orgId) {
          throw new Error("Expected an entitled workspace");
        }
        await updateFeatureSwitchesForUser(
          context,
          { ...owner.actor, orgId: owner.actor.orgId },
          {
            [FeatureSwitchKey.CodexExecution]: framework === "codex",
            // These delivery cases override Skills with retained Agent Workflows.
            [FeatureSwitchKey.SingleAgent]: false,
          },
        );
        const s3 = installWorkflowVolumeS3Fixture(context);
        const selected = await api.createCustomConnector(owner.actor, body);
        await api.createCustomConnector(owner.actor, {
          ...body,
          displayName: "Unselected connector",
          skillMarkdown: "Unselected private instructions.",
        });
        await api.updateAgentCustomConnectors(owner.actor, owner.agentId, [
          selected.id,
        ]);
        await fixture.api.enableAgentConnectors(owner.actor, owner.agentId, [
          "nintendo-store",
        ]);
        return { selected, s3 };
      });
      const other = await publicChatActor(context);
      await other.run(() => {
        return api.createCustomConnector(other.actor, {
          ...body,
          displayName: "Other workspace connector",
          skillMarkdown: "Other workspace private instructions.",
        });
      });
      const mountPath = `${root}/${getCustomConnectorSkillName(selected.slug, selected.id)}`;
      const queued = await owner.queueChatRun(owner.actor, {
        agentId: owner.agentId,
        prompt: "Use the selected Connector Skill",
        model,
      });
      // A queued Run reads the current authorized publication at Claim.
      await owner.run(() => {
        installWorkflowVolumeS3Fixture(context, s3.objects);
        return api.updateCustomConnector(owner.actor, selected.id, {
          ...body,
          skillMarkdown: "Updated instructions while the Run is queued.",
        });
      });
      const run = await queued.launch();
      const first = await owner.claimChatRun(owner.runnerGroup, run.runId);
      expect(first.claim.cliAgentType).toBe(framework);
      expect(first.claim.contentBundles.skills).toContainEqual(
        expect.objectContaining({ mountPath: `${root}/nintendo-store` }),
      );
      const firstBundles = first.claim.contentBundles.skills.filter(
        (bundle) => {
          return bundle.mountPath.includes("/custom-");
        },
      );
      expect(firstBundles).toHaveLength(1);
      const bundle = firstBundles[0]!;
      expect(bundle.mountPath).toBe(mountPath);
      expect(
        readClaimedContentBundle(s3.objects, bundle)
          .get("SKILL.md")
          ?.toString(),
      ).toContain("Updated instructions while the Run is queued.");
      await owner.run(() => {
        return fixture.failChatRun(
          run.runId,
          first.sandboxHeaders,
          "Captured Skill inspected",
        );
      });
      await owner.run(() => {
        installWorkflowVolumeS3Fixture(context, s3.objects);
        return api.updateCustomConnector(owner.actor, selected.id, {
          ...body,
          skillMarkdown: "Updated instructions for the next Run.",
        });
      });
      const next = await owner.sendChatRun(owner.actor, {
        agentId: owner.agentId,
        prompt: "Use the updated Connector Skill",
        model,
      });
      const second = await owner.claimChatRun(owner.runnerGroup, next.runId);
      const updated = second.claim.contentBundles.skills.find((candidate) => {
        return candidate.mountPath === mountPath;
      })!;
      expect(updated.sha256).not.toBe(bundle.sha256);
      expect(
        readClaimedContentBundle(s3.objects, updated)
          .get("SKILL.md")
          ?.toString(),
      ).toContain("Updated instructions for the next Run.");
      await owner.run(() => {
        return fixture.failChatRun(
          next.runId,
          second.sandboxHeaders,
          "Updated Skill inspected",
        );
      });
      const workflowNames = [
        getCustomConnectorSkillName(selected.slug, selected.id),
        "nintendo-store",
      ];
      await owner.run(async () => {
        installWorkflowVolumeS3Fixture(context, s3.objects);
        const workflows = setupApp({ context, routes: workflowsRoutes })(
          workflowsCollectionContract,
        );
        for (const name of workflowNames) {
          await accept(
            workflows.create({
              headers: { authorization: "Bearer clerk-session" },
              body: {
                agentId: owner.agentId,
                name,
                instruction: `Workflow overrides ${name}`,
              },
            }),
            [201],
          );
        }
      });
      const collisionRun = await owner.sendChatRun(owner.actor, {
        agentId: owner.agentId,
        prompt: "Use the overriding Workflows",
        model,
      });
      const collision = await owner.claimChatRun(
        owner.runnerGroup,
        collisionRun.runId,
      );
      for (const name of workflowNames) {
        const mounts = collision.claim.contentBundles.skills.filter(
          (candidate) => {
            return candidate.mountPath === `${root}/${name}`;
          },
        );
        expect(mounts).toHaveLength(1);
        expect(
          readClaimedContentBundle(s3.objects, mounts[0]!)
            .get("SKILL.md")
            ?.toString(),
        ).toContain(`Workflow overrides ${name}`);
      }
      await owner.run(() => {
        return fixture.failChatRun(
          collisionRun.runId,
          collision.sandboxHeaders,
          "Mount precedence inspected",
        );
      });
    },
  );
});
