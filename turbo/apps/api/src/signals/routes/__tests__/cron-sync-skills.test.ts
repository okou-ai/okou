import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cronSyncSkillsContract } from "@okouai/api-contracts/contracts/cron";
import { readContentBundle } from "@okouai/core/content-bundle";
import { BUILT_IN_SKILLS } from "@okouai/core/built-in-skills";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronSyncSkillsRoutes } from "../cron-sync-skills";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { readExecutionContentBundle } from "./helpers/execution-content-bundle";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { setPaidToolDisabled } from "./helpers/paid-tools";
import { githubSource, sourceArchive } from "./helpers/seed-skill-source";

const context = testContext();
const CRON_SECRET = "seed-bundle-preparation-cron";

function emittedSeedFiles(objects: ReadonlyMap<string, Buffer>) {
  return [...objects.entries()]
    .filter(([key]) => {
      return key.startsWith("bundles/v1/");
    })
    .map(([key, archive]) => {
      const sha256 = createHash("sha256").update(archive).digest("hex");
      expect(key).toBe(`bundles/v1/${sha256}.tar.gz`);
      return new Map(
        readContentBundle(archive, {
          sha256,
          archiveBytes: archive.length,
        }).map((file) => {
          return [file.path, file.content];
        }),
      );
    });
}

describe("Seed Skill bundles through sync-skills", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
  });

  it("publishes complete Seed bundles, skips unchanged content, and updates changed content", async () => {
    const app = await setupApp({
      context,
      routes: cronSyncSkillsRoutes,
      isolatePg: true,
    });
    const s3 = installWorkflowVolumeS3Fixture(context);
    const first = await sourceArchive();
    githubSource("a".repeat(40), first.archive);
    const sync = () => {
      return accept(
        app(cronSyncSkillsContract).sync({
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
        [200],
      );
    };
    expect((await sync()).body).toMatchObject({
      synced: BUILT_IN_SKILLS.length,
      skipped: 0,
      failed: 0,
      removed: 0,
      total: BUILT_IN_SKILLS.length,
    });
    const bundles = emittedSeedFiles(s3.objects);
    expect(bundles).toHaveLength(BUILT_IN_SKILLS.length);
    for (const name of BUILT_IN_SKILLS) {
      const expected = new Map(
        [...first.files]
          .filter(([path]) => {
            return path.startsWith(`${name}/`);
          })
          .map(([path, content]) => {
            return [path.slice(name.length + 1), content];
          }),
      );
      expect(bundles).toContainEqual(expected);
    }
    expect(s3.objects.size).toBe(BUILT_IN_SKILLS.length);
    const published = new Map(s3.objects);
    expect((await sync()).body).toMatchObject({
      synced: 0,
      skipped: 0,
      failed: 0,
      total: 0,
    });
    githubSource("b".repeat(40), first.archive);
    expect((await sync()).body).toMatchObject({
      synced: 0,
      skipped: BUILT_IN_SKILLS.length,
      failed: 0,
      total: BUILT_IN_SKILLS.length,
    });
    expect(s3.objects).toStrictEqual(published);
    const changed = await sourceArchive("updated gen instructions");
    githubSource("c".repeat(40), changed.archive);
    expect((await sync()).body).toMatchObject({
      synced: 1,
      skipped: BUILT_IN_SKILLS.length - 1,
      failed: 0,
      total: BUILT_IN_SKILLS.length,
    });
    expect(emittedSeedFiles(s3.objects)).toContainEqual(
      new Map([["SKILL.md", changed.files.get("gen/SKILL.md")]]),
    );
  });

  it("retries an incomplete publication after a bundle provider failure", async () => {
    const app = await setupApp({
      context,
      routes: cronSyncSkillsRoutes,
      isolatePg: true,
    });
    const s3 = installWorkflowVolumeS3Fixture(context);
    githubSource("d".repeat(40), (await sourceArchive()).archive);
    s3.beforeNextBundleWrite(() => {
      throw new Error("Object storage temporarily unavailable");
    });
    const sync = () => {
      return accept(
        app(cronSyncSkillsContract).sync({
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
        [200],
      );
    };
    expect((await sync()).body).toMatchObject({
      synced: BUILT_IN_SKILLS.length - 1,
      failed: 1,
      total: BUILT_IN_SKILLS.length,
    });
    expect((await sync()).body).toMatchObject({
      synced: 1,
      skipped: BUILT_IN_SKILLS.length - 1,
      failed: 0,
      total: BUILT_IN_SKILLS.length,
    });
    expect(emittedSeedFiles(s3.objects)).toHaveLength(BUILT_IN_SKILLS.length);
    expect((await sync()).body).toMatchObject({ total: 0, failed: 0 });
  });

  it("loads current Claude Code Seed bundles during preparation and retains delivered bytes", async () => {
    const root = "/home/user/.claude/skills";
    const app = await setupApp({
      context,
      routes: cronSyncSkillsRoutes,
      isolatePg: true,
    });
    const owned = await publicChatActor(context);
    const fixture = createChatEventsFixture(context);
    const source = await sourceArchive();
    const s3 = await owned.run(async () => {
      await fixture.api.ensurePersonalSubscriptionModel(owned.actor, {
        model: "claude-fable-5-1",
      });
      const storage = installWorkflowVolumeS3Fixture(context);
      githubSource("e".repeat(40), source.archive);
      await accept(
        app(cronSyncSkillsContract).sync({
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
        [200],
      );
      return storage;
    });
    const queued = await owned.queueChatRun(owned.actor, {
      prompt: "Inspect system skills",
      model: "claude-fable-5-1",
    });
    const changed = await sourceArchive("updated gen instructions");
    await owned.run(async () => {
      githubSource("f".repeat(40), changed.archive);
      await accept(
        app(cronSyncSkillsContract).sync({
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
        [200],
      );
    });
    const run = await queued.launch();
    const { execution, sandboxHeaders } = await owned.runExecution(run.runId);
    const laterSource = await sourceArchive("later gen instructions");
    await owned.run(async () => {
      githubSource("1".repeat(40), laterSource.archive);
      await accept(
        app(cronSyncSkillsContract).sync({
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
        [200],
      );
    });
    expect(execution.cliAgentType).toBe("claude-code");
    expect(
      execution.contentBundles.skills.map((bundle) => {
        return bundle.mountPath;
      }),
    ).toStrictEqual(
      BUILT_IN_SKILLS.map((name) => {
        return `${root}/${name}`;
      }),
    );
    for (const name of BUILT_IN_SKILLS) {
      const bundle = execution.contentBundles.skills.find((entry) => {
        return entry.mountPath === `${root}/${name}`;
      })!;
      const expected = new Map(
        [...changed.files]
          .filter(([path]) => {
            return path.startsWith(`${name}/`);
          })
          .map(([path, content]) => {
            return [path.slice(name.length + 1), content];
          }),
      );
      expect(readExecutionContentBundle(s3.objects, bundle)).toStrictEqual(
        expected,
      );
    }
    const mountPaths = [
      ...execution.contentBundles.skills.map((bundle) => {
        return bundle.mountPath;
      }),
      ...(execution.storageManifest?.storageMounts ?? []).map((mount) => {
        return mount.mountPath;
      }),
    ];
    expect(new Set(mountPaths).size).toBe(mountPaths.length);
    await owned.run(() => {
      return fixture.failChatRun(
        run.runId,
        sandboxHeaders,
        "Captured Seed bundles inspected",
      );
    });
    await owned.run(flushWaitUntilForTest);
    const next = await owned.sendChatRun(owned.actor, {
      prompt: "Use the later Seed publication",
      model: "claude-fable-5-1",
    });
    const later = await owned.runExecution(next.runId);
    const selected = later.execution.contentBundles.skills.find((bundle) => {
      return bundle.mountPath === `${root}/gen`;
    })!;
    expect(readExecutionContentBundle(s3.objects, selected)).toStrictEqual(
      new Map([["SKILL.md", laterSource.files.get("gen/SKILL.md")]]),
    );
    expect(selected.sha256).not.toBe(
      execution.contentBundles.skills.find((bundle) => {
        return bundle.mountPath === `${root}/gen`;
      })!.sha256,
    );
    await owned.run(() => {
      return fixture.failChatRun(
        next.runId,
        later.sandboxHeaders,
        "Later Seed bundle inspected",
      );
    });
    await owned.run(flushWaitUntilForTest);
  });
});

describe("Seed Skill bundle delivery", () => {
  it.each([
    { framework: "codex", root: "/home/user/.codex/skills" },
    { framework: "pi", root: "/home/user/.pi/agent/skills" },
  ] as const)(
    "delivers prepared $framework Seed bundles at their skill mounts",
    async ({ framework, root }) => {
      const owned = await publicChatActor(context);
      owned.ownsFeatureSwitches();
      const fixture = createChatEventsFixture(context);
      const s3 = await owned.run(async () => {
        await fixture.configureSubscriptionPiModel(owned.actor);
        if (!owned.actor.orgId) {
          throw new Error("Expected an entitled workspace");
        }
        await updateFeatureSwitchesForUser(
          context,
          { ...owned.actor, orgId: owned.actor.orgId },
          { [FeatureSwitchKey.CodexExecution]: framework === "codex" },
        );
        return installWorkflowVolumeS3Fixture(context);
      });
      const run = await owned.sendChatRun(owned.actor, {
        prompt: "Inspect system skills",
        model: "gpt-6-luna",
      });
      const { execution, sandboxHeaders } = await owned.runExecution(run.runId);
      expect(execution.cliAgentType).toBe(framework);
      expect(
        execution.contentBundles.skills.map((bundle) => {
          return bundle.mountPath;
        }),
      ).toStrictEqual(
        BUILT_IN_SKILLS.map((name) => {
          return `${root}/${name}`;
        }),
      );
      for (const bundle of execution.contentBundles.skills) {
        expect(
          readExecutionContentBundle(s3.objects, bundle).get("SKILL.md"),
        ).toBeDefined();
      }
      const mountPaths = [
        ...execution.contentBundles.skills.map((bundle) => {
          return bundle.mountPath;
        }),
        ...(execution.storageManifest?.storageMounts ?? []).map((mount) => {
          return mount.mountPath;
        }),
      ];
      expect(new Set(mountPaths).size).toBe(mountPaths.length);
      await owned.run(() => {
        return fixture.failChatRun(
          run.runId,
          sandboxHeaders,
          "Prepared Seed bundles inspected",
        );
      });
      await owned.run(flushWaitUntilForTest);
    },
  );

  it("filters disabled image generation from the published Seed bundles", async () => {
    const owned = await publicChatActor(context);
    const fixture = createChatEventsFixture(context);
    const s3 = await owned.run(async () => {
      const storage = installWorkflowVolumeS3Fixture(context);
      await setPaidToolDisabled(context, owned.actor, "image-generation", true);
      return storage;
    });
    const run = await owned.sendChatRun(owned.actor, {
      prompt: "Use permitted Seed skills",
    });
    const { execution, sandboxHeaders } = await owned.runExecution(run.runId);
    expect(
      execution.contentBundles.skills.map((bundle) => {
        return bundle.mountPath.split("/").at(-1);
      }),
    ).toStrictEqual(["computer-use", "workflow-setup"]);
    for (const bundle of execution.contentBundles.skills) {
      expect(
        readExecutionContentBundle(s3.objects, bundle).get("SKILL.md"),
      ).toBeDefined();
    }
    await owned.run(() => {
      return fixture.failChatRun(
        run.runId,
        sandboxHeaders,
        "Permitted Seed bundles inspected",
      );
    });
    await owned.run(flushWaitUntilForTest);
  });
});
