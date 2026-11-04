import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { create } from "tar";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { cronSyncSkillsContract } from "@okouai/api-contracts/contracts/cron";
import { readContentBundle } from "@okouai/core/content-bundle";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronSyncSkillsRoutes } from "../cron-sync-skills";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { readClaimedContentBundle } from "./helpers/claimed-content-bundle";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { setPaidToolDisabled } from "./helpers/paid-tools";

const context = testContext();
const CRON_SECRET = "seed-bundle-preparation-cron";

async function sourceArchive(revision = "first") {
  const files = new Map<string, Buffer>();
  for (const name of [...SEED_SKILLS, "ordinary-skill"]) {
    files.set(
      `${name}/SKILL.md`,
      Buffer.from(
        `---\nname: ${name}\ndescription: ${name}\n---\n${name === "gen" ? revision : "stable"}\n`,
      ),
    );
  }
  files.set(
    "workflow-setup/references/guide.md",
    Buffer.from("Complete guide\n"),
  );
  const root = await mkdtemp(join(tmpdir(), "seed-skills-provider-"));
  onTestFinished(() => {
    return rm(root, { recursive: true, force: true });
  });
  for (const [path, content] of files) {
    const target = join(root, "okou-skills-main", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const archivePath = join(root, "source.tar.gz");
  await create({ cwd: root, file: archivePath, gzip: true }, [
    "okou-skills-main",
  ]);
  return { archive: await readFile(archivePath), files };
}

function githubSource(sha: string, archive: Buffer) {
  server.use(
    http.get("https://github.com/okou-ai/okou-skills.git/info/refs", () => {
      return new HttpResponse(`${sha} refs/heads/main\n`);
    }),
    http.get(
      "https://codeload.github.com/okou-ai/okou-skills/tar.gz/refs/heads/main",
      () => {
        return new HttpResponse(new Uint8Array(archive));
      },
    ),
  );
}

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

  it("publishes Seed bundles and non-Seed Storage, skips unchanged content, and updates changed content", async () => {
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
      synced: 4,
      skipped: 0,
      failed: 0,
      total: 4,
    });
    const bundles = emittedSeedFiles(s3.objects);
    expect(bundles).toHaveLength(SEED_SKILLS.length);
    for (const name of SEED_SKILLS) {
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
    const storageArchives = [...s3.objects.entries()].filter(([key]) => {
      return key.endsWith("/archive.tar.gz");
    });
    expect(storageArchives).toHaveLength(1);
    const ordinaryArchive = storageArchives[0]![1];
    expect(
      new Map(
        readContentBundle(ordinaryArchive, {
          sha256: createHash("sha256").update(ordinaryArchive).digest("hex"),
          archiveBytes: ordinaryArchive.length,
        }).map((file) => {
          return [file.path, file.content];
        }),
      ),
    ).toStrictEqual(
      new Map([["SKILL.md", first.files.get("ordinary-skill/SKILL.md")]]),
    );
    // Three Seed packages and the ordinary skill's archive + manifest.
    expect(s3.objects.size).toBe(SEED_SKILLS.length + 2);
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
      skipped: 4,
      failed: 0,
      total: 4,
    });
    expect(s3.objects).toStrictEqual(published);
    const changed = await sourceArchive("updated gen instructions");
    githubSource("c".repeat(40), changed.archive);
    expect((await sync()).body).toMatchObject({
      synced: 1,
      skipped: 3,
      failed: 0,
      total: 4,
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
      synced: 3,
      failed: 1,
      total: 4,
    });
    expect((await sync()).body).toMatchObject({
      synced: 1,
      skipped: 3,
      failed: 0,
      total: 4,
    });
    expect(emittedSeedFiles(s3.objects)).toHaveLength(SEED_SKILLS.length);
    expect((await sync()).body).toMatchObject({ total: 0, failed: 0 });
  });

  it("pins prepared Claude Code Seed bundles across later syncs", async () => {
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
    const run = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
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
    const { claim, sandboxHeaders } = await owned.claimChatRun(
      owned.runnerGroup,
      run.runId,
    );
    expect(claim.cliAgentType).toBe("claude-code");
    expect(
      claim.contentBundles.skills.map((bundle) => {
        return bundle.mountPath;
      }),
    ).toStrictEqual(
      SEED_SKILLS.map((name) => {
        return `${root}/${name}`;
      }),
    );
    for (const name of SEED_SKILLS) {
      const bundle = claim.contentBundles.skills.find((entry) => {
        return entry.mountPath === `${root}/${name}`;
      })!;
      const expected = new Map(
        [...source.files]
          .filter(([path]) => {
            return path.startsWith(`${name}/`);
          })
          .map(([path, content]) => {
            return [path.slice(name.length + 1), content];
          }),
      );
      expect(readClaimedContentBundle(s3.objects, bundle)).toStrictEqual(
        expected,
      );
    }
    const mountPaths = [
      ...claim.contentBundles.skills.map((bundle) => {
        return bundle.mountPath;
      }),
      ...(claim.storageManifest?.storageMounts ?? []).map((mount) => {
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
      agentId: owned.agentId,
      prompt: "Use the later Seed publication",
      model: "claude-fable-5-1",
    });
    const later = await owned.claimChatRun(owned.runnerGroup, next.runId);
    const selected = later.claim.contentBundles.skills.find((bundle) => {
      return bundle.mountPath === `${root}/gen`;
    })!;
    expect(readClaimedContentBundle(s3.objects, selected)).toStrictEqual(
      new Map([["SKILL.md", changed.files.get("gen/SKILL.md")]]),
    );
    expect(selected.sha256).not.toBe(
      claim.contentBundles.skills.find((bundle) => {
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
        agentId: owned.agentId,
        prompt: "Inspect system skills",
        model: "gpt-6-luna",
      });
      const { claim, sandboxHeaders } = await owned.claimChatRun(
        owned.runnerGroup,
        run.runId,
      );
      expect(claim.cliAgentType).toBe(framework);
      expect(
        claim.contentBundles.skills.map((bundle) => {
          return bundle.mountPath;
        }),
      ).toStrictEqual(
        SEED_SKILLS.map((name) => {
          return `${root}/${name}`;
        }),
      );
      for (const bundle of claim.contentBundles.skills) {
        expect(
          readClaimedContentBundle(s3.objects, bundle).get("SKILL.md"),
        ).toBeDefined();
      }
      const mountPaths = [
        ...claim.contentBundles.skills.map((bundle) => {
          return bundle.mountPath;
        }),
        ...(claim.storageManifest?.storageMounts ?? []).map((mount) => {
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

  it("filters disabled image generation from the claimed Seed bundles", async () => {
    const owned = await publicChatActor(context);
    const fixture = createChatEventsFixture(context);
    const s3 = await owned.run(async () => {
      const storage = installWorkflowVolumeS3Fixture(context);
      await setPaidToolDisabled(context, owned.actor, "image-generation", true);
      return storage;
    });
    const run = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Use permitted Seed skills",
    });
    const { claim, sandboxHeaders } = await owned.claimChatRun(
      owned.runnerGroup,
      run.runId,
    );
    expect(
      claim.contentBundles.skills.map((bundle) => {
        return bundle.mountPath.split("/").at(-1);
      }),
    ).toStrictEqual(["computer-use", "workflow-setup"]);
    for (const bundle of claim.contentBundles.skills) {
      expect(
        readClaimedContentBundle(s3.objects, bundle).get("SKILL.md"),
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
