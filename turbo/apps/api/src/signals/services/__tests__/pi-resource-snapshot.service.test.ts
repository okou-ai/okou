import { indexPiResourceArchive } from "../../../lib/pi-resource-index";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CANONICAL_WORKING_DIR,
  PI_AGENT_DIR,
  PI_MEMORY_ROOT,
  type PiMemoryRecallSelection,
  type StoredStorageMountEntry,
} from "@okouai/api-contracts/contracts/runners";
import { create as createTar, Header } from "tar";
import { gzipSync } from "node:zlib";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  buildPiResourceSnapshot as buildArchiveSnapshot,
  buildPiResourceSnapshotFromIndexes,
  piResourceDiscoveryMounts,
  piResourceSnapshotDigest,
  UnsupportedPiResourceError,
} from "../pi-resource-snapshot.service";

interface ArchiveFile {
  readonly path: string;
  readonly content: string | Buffer;
}

function archive(files: readonly ArchiveFile[]): Buffer {
  const root = mkdtempSync(join(tmpdir(), "pi-resource-archive-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  for (const file of files) {
    const filePath = join(root, file.path);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, file.content);
  }
  const archivePath = join(root, "resources.tar.gz");
  createTar(
    {
      cwd: root,
      file: archivePath,
      gzip: true,
      sync: true,
    },
    files.map((file) => {
      return file.path;
    }),
  );
  return readFileSync(archivePath);
}

function mount(args: {
  readonly name: string;
  readonly versionId: string;
  readonly mountPath: string;
  readonly archive: Buffer;
  readonly archiveUrl?: string;
}): StoredStorageMountEntry {
  return {
    name: args.name,
    storageId: `${args.name}-storage`,
    versionId: args.versionId,
    mountPath: args.mountPath,
    archiveUrl:
      args.archiveUrl ?? `https://storage.example/${args.name}.tar.gz`,
    archiveSize: args.archive.length,
    orgId: "test-org",
    userId: "test-user",
  };
}

// Byte-level archive discovery is the Pi loader contract; these fixtures also
// exercise ordered/ignored entries that ordinary upload manifests cannot express.
describe.each(["archive", "index"] as const)(
  "Pi resource snapshot (%s)",
  (mode) => {
    const buildPiResourceSnapshot = (
      mounts: readonly StoredStorageMountEntry[],
      archives: readonly (Buffer | null)[],
      memoryRecall?: PiMemoryRecallSelection,
    ) => {
      return mode === "archive"
        ? buildArchiveSnapshot(mounts, archives, memoryRecall)
        : buildPiResourceSnapshotFromIndexes(
            mounts,
            archives.map((value) => {
              return value ? indexPiResourceArchive(value) : null;
            }),
            memoryRecall,
          );
    };

    it("preserves ordered duplicate entries for instruction remapping and normal mounts", () => {
      const chunks: Buffer[] = [];
      for (const content of ["first instruction", "last instruction"]) {
        const bytes = Buffer.from(content);
        const header = Buffer.alloc(512);
        new Header({
          path: "AGENTS.md",
          size: bytes.length,
          type: "File",
          mode: 0o644,
        }).encode(header);
        chunks.push(
          header,
          bytes,
          Buffer.alloc((512 - (bytes.length % 512)) % 512),
        );
      }
      const bytes = gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
      const mounted = mount({
        name: "duplicates",
        versionId: "duplicate-version",
        mountPath: CANONICAL_WORKING_DIR,
        archive: bytes,
      });
      expect(
        buildPiResourceSnapshot([mounted], [bytes]).agentsFiles,
      ).toStrictEqual([
        {
          path: `${CANONICAL_WORKING_DIR}/AGENTS.md`,
          content: "last instruction",
        },
      ]);
      expect(
        buildPiResourceSnapshot(
          [{ ...mounted, instructionsTargetFilename: "AGENTS.md" }],
          [bytes],
        ).agentsFiles,
      ).toStrictEqual([
        {
          path: `${CANONICAL_WORKING_DIR}/AGENTS.md`,
          content: "first instruction",
        },
      ]);
    });

    it("replays Pi context and skill discovery from mounted archives", () => {
      const userArchive = archive([
        { path: "AGENTS.md", content: "Global Pi instructions." },
        {
          path: "skills/.gitignore",
          content: "ignored/\n",
        },
        {
          path: "skills/release-check/SKILL.md",
          content:
            "---\nname: release-check\ndescription: Inspect a release.\n---\nBody stays in Storage.\n",
        },
        {
          path: "skills/manual-only/SKILL.md",
          content:
            "---\nname: manual-only\ndescription: Explicit invocation only.\ndisable-model-invocation: true\n---\n",
        },
        {
          path: "skills/ignored/SKILL.md",
          content:
            "---\nname: ignored\ndescription: Must not be discovered.\n---\n",
        },
      ]);
      const projectArchive = archive([
        {
          path: "AGENTS.override.md",
          content: "Project Pi instructions.",
        },
        {
          path: ".pi/skills/project-check/SKILL.md",
          content:
            "---\nname: project-check\ndescription: Inspect this project.\n---\n",
        },
      ]);
      const mounts = [
        mount({
          name: "pi-agent",
          versionId: "agent-v1",
          mountPath: PI_AGENT_DIR,
          archive: userArchive,
        }),
        mount({
          name: "workspace",
          versionId: "workspace-v1",
          mountPath: CANONICAL_WORKING_DIR,
          archive: projectArchive,
        }),
      ];

      const snapshot = buildPiResourceSnapshot(mounts, [
        userArchive,
        projectArchive,
      ]);

      expect(snapshot.agentsFiles).toStrictEqual([
        {
          path: `${PI_AGENT_DIR}/AGENTS.md`,
          content: "Global Pi instructions.",
        },
        {
          path: `${CANONICAL_WORKING_DIR}/AGENTS.override.md`,
          content: "Project Pi instructions.",
        },
      ]);
      expect(snapshot.skills).toStrictEqual([
        {
          name: "manual-only",
          description: "Explicit invocation only.",
          filePath: `${PI_AGENT_DIR}/skills/manual-only/SKILL.md`,
          baseDir: `${PI_AGENT_DIR}/skills/manual-only`,
          scope: "user",
          disableModelInvocation: true,
        },
        {
          name: "release-check",
          description: "Inspect a release.",
          filePath: `${PI_AGENT_DIR}/skills/release-check/SKILL.md`,
          baseDir: `${PI_AGENT_DIR}/skills/release-check`,
          scope: "user",
          disableModelInvocation: false,
        },
        {
          name: "project-check",
          description: "Inspect this project.",
          filePath: `${CANONICAL_WORKING_DIR}/.pi/skills/project-check/SKILL.md`,
          baseDir: `${CANONICAL_WORKING_DIR}/.pi/skills/project-check`,
          scope: "project",
          disableModelInvocation: false,
        },
      ]);
    });

    it("ignores adjacent binary assets and discovers PAX long-path skills", () => {
      const nestedPath = Array.from({ length: 8 }, (_, index) => {
        return `nested-${index}-${"x".repeat(28)}`;
      }).join("/");
      const skillPath = `skills/${nestedPath}/long-path-skill/SKILL.md`;
      expect(Buffer.byteLength(skillPath, "utf8")).toBeGreaterThan(255);
      const resourceArchive = archive([
        {
          path: skillPath,
          content:
            "---\nname: pax-long-path\ndescription: Discover a PAX path.\n---\n",
        },
        {
          path: `skills/${nestedPath}/long-path-skill/icon.png`,
          content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]),
        },
      ]);
      const mounts = [
        mount({
          name: "pi-agent",
          versionId: "agent-pax-v1",
          mountPath: PI_AGENT_DIR,
          archive: resourceArchive,
        }),
      ];

      expect(
        buildPiResourceSnapshot(mounts, [resourceArchive]).skills,
      ).toStrictEqual([
        {
          name: "pax-long-path",
          description: "Discover a PAX path.",
          filePath: `${PI_AGENT_DIR}/${skillPath}`,
          baseDir: `${PI_AGENT_DIR}/${skillPath.replace(/\/SKILL\.md$/u, "")}`,
          scope: "user",
          disableModelInvocation: false,
        },
      ]);
    });

    it("keys the durable snapshot by ordered Storage versions, not signed URLs", () => {
      const emptyArchive = archive([{ path: "README.md", content: "none" }]);
      const first = mount({
        name: "workspace",
        versionId: "workspace-v1",
        mountPath: CANONICAL_WORKING_DIR,
        archive: emptyArchive,
        archiveUrl: "https://storage.example/first-signature",
      });
      const refreshedUrl = {
        ...first,
        archiveUrl: "https://storage.example/refreshed-signature",
      };
      expect(piResourceSnapshotDigest([first])).toBe(
        piResourceSnapshotDigest([refreshedUrl]),
      );
      expect(piResourceSnapshotDigest([first])).not.toBe(
        piResourceSnapshotDigest([{ ...first, versionId: "workspace-v2" }]),
      );
      expect(piResourceSnapshotDigest([first])).toBe(
        "6ad98abb45acd479f74a513c58af0940616b1272b043aecf61ec0afb7758b7fa",
      );

      const noContentA: PiMemoryRecallSelection = {
        status: "no-content",
        memoryStorageId: "memory-storage",
        storageVersionId: "memory-version-a",
      };
      const noContentB: PiMemoryRecallSelection = {
        ...noContentA,
        storageVersionId: "memory-version-b",
      };
      const readyA: PiMemoryRecallSelection = {
        ...noContentA,
        status: "ready",
        content: "frozen memory",
        sourceHash: "a".repeat(64),
        sourceSize: 13,
        tokenCount: 2,
      };
      expect(piResourceSnapshotDigest([first], noContentA)).not.toBe(
        piResourceSnapshotDigest([first]),
      );
      expect(piResourceSnapshotDigest([first], noContentA)).not.toBe(
        piResourceSnapshotDigest([first], noContentB),
      );
      expect(piResourceSnapshotDigest([first], noContentA)).not.toBe(
        piResourceSnapshotDigest([first], readyA),
      );
      expect(
        piResourceSnapshotDigest([first], {
          ...readyA,
          content: "changed memory",
          sourceHash: "b".repeat(64),
          sourceSize: 14,
        }),
      ).not.toBe(piResourceSnapshotDigest([first], readyA));
      expect(
        buildPiResourceSnapshot([first], [emptyArchive], readyA),
      ).toMatchObject({
        schemaVersion: 2,
        memoryRecall: readyA,
      });

      const artifact = mount({
        name: "artifact",
        versionId: "artifact-v1",
        mountPath: `${CANONICAL_WORKING_DIR}/artifacts`,
        archive: emptyArchive,
      });
      const memory = mount({
        name: "memory",
        versionId: "memory-version-a",
        mountPath: PI_MEMORY_ROOT,
        archive: emptyArchive,
      });
      expect(
        piResourceDiscoveryMounts([first, artifact, memory]),
      ).toStrictEqual([first]);
    });

    it("fails with an unsupported resource error for settings", () => {
      const settingsArchive = archive([
        { path: "settings.json", content: '{"packages":["custom"]}' },
      ]);
      const mounts = [
        mount({
          name: "pi-agent",
          versionId: "agent-v1",
          mountPath: PI_AGENT_DIR,
          archive: settingsArchive,
        }),
      ];
      expect(() => {
        return buildPiResourceSnapshot(mounts, [settingsArchive]);
      }).toThrow(UnsupportedPiResourceError);
    });

    it("rejects invalid UTF-8 instead of approximating Pi discovery", () => {
      const invalidArchive = archive([
        {
          path: "skills/invalid/SKILL.md",
          content: Buffer.from([0xff, 0xfe]),
        },
      ]);
      const mounts = [
        mount({
          name: "pi-agent",
          versionId: "agent-invalid-utf8",
          mountPath: PI_AGENT_DIR,
          archive: invalidArchive,
        }),
      ];

      expect(() => {
        return buildPiResourceSnapshot(mounts, [invalidArchive]);
      }).toThrow(/valid for encoding utf-8/u);
    });
    it("keeps invalid ignored metadata inert and stops discovery below an invalid skill", () => {
      const bytes = archive([
        { path: "skills/.gitignore", content: "ignored/\n" },
        { path: "skills/ignored/SKILL.md", content: Buffer.from([0xff]) },
        {
          path: "skills/no-description/SKILL.md",
          content: "---\nname: empty\n---\n",
        },
        {
          path: "skills/no-description/nested/SKILL.md",
          content: "---\nname: hidden\ndescription: Must remain hidden\n---\n",
        },
        {
          path: "skills/valid/SKILL.md",
          content: "---\ndescription: Visible skill\n---\n",
        },
      ]);
      const snapshot = buildPiResourceSnapshot(
        [
          mount({
            name: "ignored",
            versionId: "ignored-v1",
            mountPath: PI_AGENT_DIR,
            archive: bytes,
          }),
        ],
        [bytes],
      );
      expect(
        snapshot.skills.map((skill) => {
          return skill.name;
        }),
      ).toStrictEqual(["valid"]);
    });

    it("resolves unnamed skills at each mount and lets an empty overlay hide earlier resources", () => {
      const bytes = archive([
        {
          path: "SKILL.md",
          content: "---\ndescription: Reusable skill\n---\n",
        },
      ]);
      const mounts = ["first", "second"].map((name) => {
        return mount({
          name,
          versionId: "shared-v1",
          mountPath: `${PI_AGENT_DIR}/skills/${name}`,
          archive: bytes,
        });
      });
      expect(
        buildPiResourceSnapshot(mounts, [bytes, bytes]).skills.map((skill) => {
          return skill.name;
        }),
      ).toStrictEqual(["first", "second"]);
      const overlay: StoredStorageMountEntry = {
        name: "empty",
        storageId: "empty-storage",
        versionId: "empty-v1",
        mountPath: `${PI_AGENT_DIR}/skills/first`,
        empty: true,
        writeback: true,
        orgId: "test-org",
        userId: "test-user",
      };
      expect(
        buildPiResourceSnapshot(
          [...mounts, overlay],
          [bytes, bytes, null],
        ).skills.map((skill) => {
          return skill.name;
        }),
      ).toStrictEqual(["second"]);
    });

    it("evaluates unsupported resources after overlays and mounting", () => {
      const bytes = archive([{ path: "settings.json", content: "{}" }]);
      const ordinary = mount({
        name: "ordinary",
        versionId: "settings-v1",
        mountPath: `${CANONICAL_WORKING_DIR}/assets`,
        archive: bytes,
      });
      expect(buildPiResourceSnapshot([ordinary], [bytes]).skills).toStrictEqual(
        [],
      );
      const pi = { ...ordinary, mountPath: PI_AGENT_DIR };
      expect(() => {
        return buildPiResourceSnapshot([pi], [bytes]);
      }).toThrow(UnsupportedPiResourceError);
      expect(
        buildPiResourceSnapshot(
          [pi, { ...pi, versionId: "replacement" }],
          [bytes, null],
        ).skills,
      ).toStrictEqual([]);
    });
  },
);
