import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import {
  getCustomConnectorSkillName,
  getCustomConnectorSkillStorageName,
} from "@okouai/core/storage-names";
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
  it("keeps delivery off by default and captures each Run's selected mode across flag changes", async () => {
    const owner = await publicChatActor(context);
    owner.ownsFeatureSwitches();
    const fixture = createChatEventsFixture(context);
    const api = createConnectorBddApi(context);
    const selected = await owner.run(async () => {
      installWorkflowVolumeS3Fixture(context);
      const selected = await api.createCustomConnector(
        owner.actor,
        manualHttpCustomConnectorCreateBody({
          displayName: "Staged delivery",
          prefixTemplates: ["https://staged-skill.example.test/api/"],
          skillMarkdown: "Staged Skill instructions.",
        }),
      );
      await api.updateAgentCustomConnectors(owner.actor, owner.agentId, [
        selected.id,
      ]);
      return selected;
    });
    const setDelivery = (enabled: boolean) => {
      return owner.run(() => {
        if (!owner.actor.orgId) {
          throw new Error("Expected a workspace");
        }
        return updateFeatureSwitchesForUser(
          context,
          { ...owner.actor, orgId: owner.actor.orgId },
          {
            [FeatureSwitchKey.ConnectorSkillBundleDelivery]: enabled,
          },
        );
      });
    };
    const createRun = () => {
      return owner.sendChatRun(owner.actor, {
        agentId: owner.agentId,
        model: "claude-fable-5-1",
        prompt: "Inspect the captured delivery mode",
      });
    };
    const mountPath = `/home/user/.claude/skills/${getCustomConnectorSkillName(selected.slug, selected.id)}`;
    const legacy = await createRun();
    await setDelivery(true);
    const legacyClaim = await owner.claimChatRun(
      owner.runnerGroup,
      legacy.runId,
    );
    expect(legacyClaim.claim.storageManifest?.storageMounts).toContainEqual(
      expect.objectContaining({
        name: getCustomConnectorSkillStorageName(selected.id),
        mountPath,
      }),
    );
    expect(
      legacyClaim.claim.contentBundles.skills.some((bundle) => {
        return bundle.mountPath === mountPath;
      }),
    ).toBeFalsy();
    await owner.run(() => {
      return fixture.failChatRun(
        legacy.runId,
        legacyClaim.sandboxHeaders,
        "Legacy capture inspected",
      );
    });
    const bundled = await createRun();
    await setDelivery(false);
    const bundleClaim = await owner.claimChatRun(
      owner.runnerGroup,
      bundled.runId,
    );
    expect(bundleClaim.claim.contentBundles.skills).toContainEqual(
      expect.objectContaining({ mountPath }),
    );
    expect(
      bundleClaim.claim.storageManifest?.storageMounts.some((mount) => {
        return mount.mountPath === mountPath;
      }),
    ).toBeFalsy();
    await owner.run(() => {
      return fixture.failChatRun(
        bundled.runId,
        bundleClaim.sandboxHeaders,
        "Bundle capture inspected",
      );
    });
  });

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
    "delivers only authorized $framework Skill bytes and selects a fresh revision for the next Run",
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
            [FeatureSwitchKey.ConnectorSkillBundleDelivery]: true,
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
      const run = await owner.sendChatRun(owner.actor, {
        agentId: owner.agentId,
        prompt: "Use the selected Connector Skill",
        model,
      });
      // Publication after Run capture cannot replace its selected immutable bytes.
      await owner.run(() => {
        installWorkflowVolumeS3Fixture(context, s3.objects);
        return api.updateCustomConnector(owner.actor, selected.id, {
          ...body,
          skillMarkdown: "Updated instructions for the next Run.",
        });
      });
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
      ).toContain(body.skillMarkdown);
      await owner.run(() => {
        return fixture.failChatRun(
          run.runId,
          first.sandboxHeaders,
          "Captured Skill inspected",
        );
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
