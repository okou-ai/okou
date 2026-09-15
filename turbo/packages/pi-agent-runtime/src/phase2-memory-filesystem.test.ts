import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  stat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer as createNetServer } from "node:net";

import {
  PI_MEMORY_SUMMARY_MAX_BYTES,
  PI_MEMORY_SUMMARY_MAX_TOKENS,
} from "@okouai/api-contracts/contracts/runners";
import {
  MAX_FILE_SIZE_BYTES,
  STORAGE_MANIFEST_MAX_FILES,
  STORAGE_MANIFEST_MAX_PATH_BYTES,
} from "@okouai/api-contracts/contracts/storages";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Phase2OutputInvalidError } from "./phase2-memory-diagnostics";
import {
  applyValidatedPiMemoryPhase2Result,
  createPiMemoryPhase2Workspace,
  Phase2InputInvalidError,
  PI_MEMORY_PHASE2_EVIDENCE_SLUG_MAX_BYTES,
  PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES,
  PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES,
  piEvidencePath,
  preparedSetFromSnapshot,
  removePiMemoryPhase2Workspace,
  snapshotMountedPiMemoryPhase2Base,
  snapshotPiMemoryPhase2Input,
  truncatePiMemoryPhase2WorkspaceDiff,
  validatePiMemoryPhase2Output,
  type Phase2PrivateWorkspace,
} from "./phase2-memory-filesystem";
import {
  PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_BYTES,
  PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILE_BYTES,
  PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILES,
  PI_MEMORY_PHASE2_MEMORY_MAX_BYTES,
  PI_MEMORY_PHASE2_PREPARED_MAX_BYTES,
  PI_MEMORY_PHASE2_WORKSPACE_DIFF_MAX_BYTES,
  type PiMemoryPhase2BaseFile,
  type PiMemoryPhase2LocalConsolidationArgs,
  type PiMemoryPhase2SelectedSnapshot,
} from "./phase2-memory-types";

const temporaryDirectories: string[] = [];
const EMPTY_HASH = createHash("sha256").update("").digest("hex");

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await removePiMemoryPhase2Workspace(directory);
    }),
  );
});

function baseFile(
  path: string,
  content: string | Uint8Array,
): PiMemoryPhase2BaseFile {
  const bytes = Buffer.from(content);
  return {
    type: "file",
    path,
    hash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    bytes,
  };
}

function selected(
  piSessionId: string,
  overrides: Partial<PiMemoryPhase2SelectedSnapshot> = {},
): PiMemoryPhase2SelectedSnapshot {
  return {
    piSessionId,
    sourceRunId: `run-${piSessionId}`,
    sourceHistoryHash: createHash("sha256")
      .update(`history-${piSessionId}`)
      .digest("hex"),
    sourceCompletedAt: new Date("2026-09-03T01:02:03.000Z"),
    rawMemory: `raw-${piSessionId}`,
    rolloutSummary: `summary-${piSessionId}`,
    rolloutSlug: null,
    ...overrides,
  };
}

function consolidationArgs(
  baseFiles: readonly PiMemoryPhase2BaseFile[],
  selectedSnapshots: readonly PiMemoryPhase2SelectedSnapshot[] = [],
): PiMemoryPhase2LocalConsolidationArgs {
  return {
    memoryStorageId: "storage-phase2",
    baseFiles,
    selected: selectedSnapshots,
    model: {
      provider: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "unused-test-key",
      model: "gpt-5.6-terra",
      dialect: "openai-responses",
      transport: "sse",
    },
  };
}

async function freshWorkspace(
  baseFiles: readonly PiMemoryPhase2BaseFile[],
  selectedSnapshots: readonly PiMemoryPhase2SelectedSnapshot[] = [],
): Promise<Phase2PrivateWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-phase2-fs-test-"));
  temporaryDirectories.push(root);
  const input = snapshotPiMemoryPhase2Input(
    consolidationArgs(baseFiles, selectedSnapshots),
    new AbortController().signal,
  );
  return await createPiMemoryPhase2Workspace(root, input);
}

async function put(
  workspace: Phase2PrivateWorkspace,
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const target = join(workspace.memoryRoot, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

const VALID_BASE = [
  baseFile("MEMORY.md", "# Task Group: existing\n"),
  baseFile("memory_summary.md", "v1\n## User Profile\n- existing\n"),
  baseFile(".git/config", "codex-git-state"),
  baseFile("legacy-topic.md", "legacy"),
  baseFile("raw_memories.md", "codex raw"),
  baseFile("extensions/preserved.txt", "extension"),
  baseFile("rollout_summaries/codex.md", "codex evidence"),
] as const;

describe("Pi memory Phase 2 filesystem", () => {
  it("preserves binary, Unicode and empty bytes with fixed manifest identities", async () => {
    const base = [
      baseFile("memory_summary.md", "v1\n用户偏好\n"),
      baseFile("legacy-empty", ""),
      baseFile("MEMORY.md", "# Task Group: café\n你好 🌍\n"),
      baseFile(".git/objects/data", Uint8Array.from([0, 255, 128, 10])),
    ];
    const workspace = await freshWorkspace(base);
    const prepared = await validatePiMemoryPhase2Output(
      workspace,
      "storage-phase2",
    );
    // These values come from an independent SHA-256 and uint32-BE encoder.
    expect(prepared.manifest).toEqual({
      version: 1,
      files: [
        {
          path: ".git/objects/data",
          hash: "6d6f7836f1e146dc0204afb5133dae52fdc05603d8ac2dc793b481b0e0829fd1",
          size: 4,
        },
        {
          path: "MEMORY.md",
          hash: "d7fcd3ab3d9c22852455a6aed5a1e5c27eb929d8f1aa69df94697853994cbd84",
          size: 32,
        },
        {
          path: "legacy-empty",
          hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          size: 0,
        },
        {
          path: "memory_summary.md",
          hash: "a254bd86fbea5c5109477168ae9a66ba8a09838f752b9769a11b059ef906877e",
          size: 16,
        },
      ],
      fileCount: 4,
      pathBytes: 55,
      totalBytes: 52,
      digest:
        "f10125c3425160b1cabdeeb41443897ac697ee5ad18136dea620618e590eea3c",
    });
    expect(prepared.contentIdentity).toBe(
      "36253330ddc58ade098ac294536f6cd990f1768a2c7386b96fd765e830085142",
    );
    const expected = new Map(
      base.map(({ path, bytes }) => {
        return [path, Buffer.from(bytes)] as const;
      }),
    );
    for (const file of base) {
      file.bytes.fill(0);
    }
    const baseFiles = await snapshotMountedPiMemoryPhase2Base(
      workspace.memoryRoot,
    );
    const applying = applyValidatedPiMemoryPhase2Result({
      memoryRoot: workspace.memoryRoot,
      memoryStorageId: "storage-phase2",
      baseFiles,
      ...prepared,
    });
    // The application boundary must own both snapshots before its first await.
    for (const file of [...baseFiles, ...prepared.files]) {
      file.bytes.fill(0);
    }
    await applying;
    for (const [path, bytes] of expected) {
      expect(await readFile(join(workspace.memoryRoot, path))).toEqual(bytes);
    }
  });

  it.each(["bytes", "hash", "size"] as const)(
    "rejects mutated prepared %s before changing the mounted tree",
    async (field) => {
      const workspace = await freshWorkspace(VALID_BASE);
      const baseFiles = await snapshotMountedPiMemoryPhase2Base(
        workspace.memoryRoot,
      );
      const prepared = await validatePiMemoryPhase2Output(
        workspace,
        "storage-phase2",
      );
      const files = prepared.files.map((file) => {
        if (file.path !== "MEMORY.md") {
          return file;
        }
        if (field === "bytes") {
          file.bytes.fill(0);
          return file;
        }
        return {
          ...file,
          ...(field === "hash"
            ? { hash: "0".repeat(64) }
            : { size: file.size + 1 }),
        };
      });
      await expect(
        applyValidatedPiMemoryPhase2Result({
          memoryRoot: workspace.memoryRoot,
          memoryStorageId: "storage-phase2",
          baseFiles,
          files,
          contentIdentity: prepared.contentIdentity,
        }),
      ).rejects.toMatchObject({
        diagnostic: { stage: "mounted_apply", reason: "file_integrity" },
      });
      for (const file of baseFiles) {
        expect(await readFile(join(workspace.memoryRoot, file.path))).toEqual(
          Buffer.from(file.bytes),
        );
      }
    },
  );

  it.each([0o444, 0o600])(
    "applies changes without rewriting unchanged immutable files (mode %s), including no-diff",
    async (mode) => {
      const original = [
        ...VALID_BASE,
        baseFile(
          ".git/objects/ab/synthetic-object",
          "synthetic immutable bytes",
        ),
        baseFile("skills/existing/old.md", "delete me"),
      ];
      const memoryRoot = await mkdtemp(join(tmpdir(), "pi-memory-writeback-"));
      temporaryDirectories.push(memoryRoot);
      for (const file of original) {
        const path = join(memoryRoot, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.bytes);
      }
      const objectPath = join(memoryRoot, ".git/objects/ab/synthetic-object");
      await chmod(objectPath, mode);
      const baseFiles = await snapshotMountedPiMemoryPhase2Base(memoryRoot);
      const workspace = await freshWorkspace(baseFiles);
      await put(workspace, "MEMORY.md", "# Changed memory\n");
      await put(workspace, "skills/existing/new.md", "new reference");
      await unlink(join(workspace.memoryRoot, "skills/existing/old.md"));
      const prepared = await validatePiMemoryPhase2Output(
        workspace,
        "storage-phase2",
      );
      const writes = vi.spyOn(fs, "writeFile");
      await applyValidatedPiMemoryPhase2Result({
        memoryRoot,
        memoryStorageId: "storage-phase2",
        baseFiles,
        ...prepared,
      });
      expect(
        writes.mock.calls
          .map(([path]) => {
            return String(path);
          })
          .sort(),
      ).toEqual([
        join(memoryRoot, "MEMORY.md"),
        join(memoryRoot, "skills/existing/new.md"),
      ]);
      expect(await readFile(objectPath, "utf8")).toBe(
        "synthetic immutable bytes",
      );
      expect((await stat(objectPath)).mode & 0o777).toBe(mode);
      await expect(
        readFile(join(memoryRoot, "skills/existing/old.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const mounted = await snapshotMountedPiMemoryPhase2Base(memoryRoot);
      expect(
        mounted.map(({ path, bytes }) => {
          return [path, bytes.toString()];
        }),
      ).toEqual(
        prepared.files.map(({ path, bytes }) => {
          return [path, Buffer.from(bytes).toString()];
        }),
      );
      expect(
        preparedSetFromSnapshot(
          "storage-phase2",
          new Map(
            mounted.map(({ path, bytes }) => {
              return [path, Buffer.from(bytes)];
            }),
          ),
        ),
      ).toEqual(prepared);
      writes.mockClear();
      await applyValidatedPiMemoryPhase2Result({
        memoryRoot,
        memoryStorageId: "storage-phase2",
        baseFiles: mounted,
        ...prepared,
      });
      expect(writes).not.toHaveBeenCalled();
      expect((await stat(objectPath)).mode & 0o777).toBe(mode);
    },
  );

  it.each(["EACCES", "ENOSPC"])(
    "retains %s for a changed read-only target without chmod or publication",
    async (code) => {
      const workspace = await freshWorkspace(VALID_BASE);
      const target = join(workspace.memoryRoot, "MEMORY.md");
      await chmod(target, 0o444);
      const baseFiles = await snapshotMountedPiMemoryPhase2Base(
        workspace.memoryRoot,
      );
      const files = new Map(
        baseFiles.map((file) => {
          return [file.path, Buffer.from(file.bytes)];
        }),
      );
      files.set("MEMORY.md", Buffer.from("changed"));
      const prepared = preparedSetFromSnapshot("storage-phase2", files);
      const originalWrite = fs.writeFile;
      vi.spyOn(fs, "writeFile").mockImplementation(
        async (path, data, options) => {
          if (path === target)
            throw Object.assign(new Error("SECRET /private/path"), {
              code,
              path: "/private/path",
            });
          return await originalWrite(path, data, options);
        },
      );
      await expect(
        applyValidatedPiMemoryPhase2Result({
          memoryRoot: workspace.memoryRoot,
          memoryStorageId: "storage-phase2",
          baseFiles,
          ...prepared,
        }),
      ).rejects.toMatchObject({
        diagnostic: {
          stage: "mounted_apply",
          reason: "filesystem",
          errno: code,
          fileClass: "memory",
        },
      });
      expect(await readFile(target, "utf8")).toBe("# Task Group: existing\n");
      expect((await stat(target)).mode & 0o777).toBe(0o444);
    },
  );

  it("distinguishes exact-base and final identity rejection", async () => {
    const workspace = await freshWorkspace(VALID_BASE);
    const baseFiles = await snapshotMountedPiMemoryPhase2Base(
      workspace.memoryRoot,
    );
    const prepared = await validatePiMemoryPhase2Output(
      workspace,
      "storage-phase2",
    );
    const applyArgs = {
      memoryRoot: workspace.memoryRoot,
      memoryStorageId: "storage-phase2",
      baseFiles,
      ...prepared,
    };
    await expect(
      applyValidatedPiMemoryPhase2Result({
        ...applyArgs,
        contentIdentity: "0".repeat(64),
      }),
    ).rejects.toMatchObject({
      diagnostic: { stage: "mounted_apply", reason: "final_identity" },
    });
    await put(workspace, "MEMORY.md", "changed mount epoch");
    await expect(
      applyValidatedPiMemoryPhase2Result(applyArgs),
    ).rejects.toMatchObject({
      diagnostic: { stage: "mounted_apply", reason: "base_mismatch" },
    });
    expect(
      await readFile(join(workspace.memoryRoot, "MEMORY.md"), "utf8"),
    ).toBe("changed mount epoch");
  });

  it.each([
    ["summary_header", "V1\nPRIVATE_SUMMARY_SENTINEL"],
    ["summary_bytes", `v1\n${" ".repeat(PI_MEMORY_SUMMARY_MAX_BYTES - 2)}`],
  ])(
    "classifies %s without exposing generated content",
    async (reason, content) => {
      const workspace = await freshWorkspace(VALID_BASE);
      await put(workspace, "memory_summary.md", content);
      try {
        await validatePiMemoryPhase2Output(workspace, "storage-phase2");
        expect.fail("invalid summary accepted");
      } catch (error) {
        expect(error).toMatchObject({
          diagnostic: {
            stage: "output_validation",
            reason,
            fileClass: "summary",
          },
        });
        if (reason === "summary_bytes")
          expect(error).toMatchObject({
            diagnostic: { actual: 65537, limit: 65536 },
          });
        expect(JSON.stringify(error)).not.toContain("PRIVATE_SUMMARY_SENTINEL");
      }
    },
  );

  it("keeps the inclusive summary byte boundary", async () => {
    const workspace = await freshWorkspace(VALID_BASE);
    await put(workspace, "memory_summary.md", `v1\n${" ".repeat(65533)}`);
    await expect(
      validatePiMemoryPhase2Output(workspace, "storage-phase2"),
    ).resolves.toBeDefined();
  });

  it("publishes a summary above the prompt injection budget in full", async () => {
    const workspace = await freshWorkspace(VALID_BASE);
    // The production failures reported exactly 2943 source tokens; the prompt
    // budget belongs to the injected excerpt, not to the stored artifact.
    const summary = `v1\n${" token".repeat(2940)}`;
    expect(encode(summary).length).toBe(2943);
    expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(
      PI_MEMORY_SUMMARY_MAX_BYTES,
    );
    await put(workspace, "memory_summary.md", summary);
    await put(workspace, "MEMORY.md", "# Task Group: larger consolidation\n");
    const baseFiles = await snapshotMountedPiMemoryPhase2Base(
      workspace.memoryRoot,
    );

    const prepared = await validatePiMemoryPhase2Output(
      workspace,
      "storage-phase2",
    );
    const published = prepared.files.find((file) => {
      return file.path === "memory_summary.md";
    });
    expect(published?.size).toBe(Buffer.byteLength(summary));
    expect(published?.bytes).toEqual(Buffer.from(summary, "utf8"));

    await applyValidatedPiMemoryPhase2Result({
      memoryRoot: workspace.memoryRoot,
      memoryStorageId: "storage-phase2",
      baseFiles,
      ...prepared,
    });
    expect(
      await readFile(join(workspace.memoryRoot, "memory_summary.md"), "utf8"),
    ).toBe(summary);
    expect(
      await readFile(join(workspace.memoryRoot, "MEMORY.md"), "utf8"),
    ).toBe("# Task Group: larger consolidation\n");
  });

  it("pins every frozen size and count boundary", () => {
    expect(PI_MEMORY_PHASE2_WORKSPACE_DIFF_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(PI_MEMORY_SUMMARY_MAX_BYTES).toBe(64 * 1024);
    expect(PI_MEMORY_SUMMARY_MAX_TOKENS).toBe(2500);
    expect(STORAGE_MANIFEST_MAX_FILES).toBe(50_000);
    expect(STORAGE_MANIFEST_MAX_PATH_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_FILE_SIZE_BYTES).toBe(100 * 1024 * 1024);
    expect(PI_MEMORY_PHASE2_PREPARED_MAX_BYTES).toBe(128 * 1024 * 1024);
    expect(PI_MEMORY_PHASE2_MEMORY_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILES).toBe(256);
    expect(PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILE_BYTES).toBe(1024 * 1024);
    expect(PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_BYTES).toBe(16 * 1024 * 1024);
    expect(PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES).toBe(256);
    expect(PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES).toBe(21_036_800);

    const empty = snapshotPiMemoryPhase2Input(
      consolidationArgs([]),
      new AbortController().signal,
    );
    expect(empty.selectionDigest).toBe(
      "f95c6835f8a93234e88b26bc2162bd3cf8defd709037f6eefb14ee6ae3d56e48",
    );
    const one = snapshotPiMemoryPhase2Input(
      consolidationArgs(
        [],
        [selected("session-a", { sourceHistoryHash: "a".repeat(64) })],
      ),
      new AbortController().signal,
    );
    expect(one.selectionDigest).toBe(
      "24a9bc5c377eb5bfc66e9976218eb1c99ecb6461e2593788b2c752f4437288b2",
    );
    expect(() => {
      snapshotPiMemoryPhase2Input(
        consolidationArgs(
          [],
          [selected("session", { sourceRunId: "r".repeat(256) })],
        ),
        new AbortController().signal,
      );
    }).toThrow(Phase2InputInvalidError);
  });

  it("leaves an interrupted mounted apply unpublished for checkpoint recovery", async () => {
    const memoryRoot = await mkdtemp(
      join(tmpdir(), "pi-memory-phase2-mounted-apply-test-"),
    );
    temporaryDirectories.push(memoryRoot);
    await writeFile(join(memoryRoot, "MEMORY.md"), "# Task Group: before\n");
    await writeFile(
      join(memoryRoot, "memory_summary.md"),
      "v1\n## User Profile\n- before\n",
    );
    const baseFiles = await snapshotMountedPiMemoryPhase2Base(memoryRoot);
    const blockedTarget = join(memoryRoot, "skills", "blocked", "SKILL.md");
    await mkdir(blockedTarget, { recursive: true });
    const prepared = new Map<string, Buffer>([
      ["MEMORY.md", Buffer.from("# Task Group: after\n")],
      ["memory_summary.md", Buffer.from("v1\n## User Profile\n- after\n")],
      [
        "skills/blocked/SKILL.md",
        Buffer.from(
          "---\nname: blocked\ndescription: interrupted fixture\n---\n",
        ),
      ],
    ]);
    const validated = preparedSetFromSnapshot("storage-phase2", prepared);

    await expect(
      applyValidatedPiMemoryPhase2Result({
        memoryRoot,
        memoryStorageId: "storage-phase2",
        baseFiles,
        files: validated.files,
        contentIdentity: validated.contentIdentity,
      }),
    ).rejects.toBeDefined();

    expect(await readFile(join(memoryRoot, "MEMORY.md"), "utf8")).toBe(
      "# Task Group: after\n",
    );
    await expect(readFile(blockedTarget)).rejects.toBeDefined();
  });

  it("rejects unsafe, ambiguous, non-file, and mismatched base inventory", () => {
    const valid = baseFile("safe.md", "safe");
    const invalidCases: readonly (readonly PiMemoryPhase2BaseFile[])[] = [
      [baseFile("/absolute.md", "x")],
      [baseFile("../parent.md", "x")],
      [baseFile("dir/./child.md", "x")],
      [baseFile("dir\\child.md", "x")],
      [baseFile("nul\0child.md", "x")],
      [valid, valid],
      [valid, baseFile("SAFE.md", "other")],
      [baseFile("prefix", "x"), baseFile("prefix/child", "x")],
      [{ ...valid, type: "directory" } as unknown as PiMemoryPhase2BaseFile],
      [{ ...valid, hash: "0".repeat(64) }],
      [{ ...valid, size: valid.size + 1 }],
      [{ ...valid, size: MAX_FILE_SIZE_BYTES + 1 }],
    ];
    for (const files of invalidCases) {
      expect(() => {
        snapshotPiMemoryPhase2Input(
          consolidationArgs(files),
          new AbortController().signal,
        );
      }).toThrow(Phase2InputInvalidError);
    }
  });

  it("rejects non-adjacent ancestors and accepts valid near prefixes", () => {
    const collisions = [
      ["a", "a-", "a/b"],
      ["E\u0301", "é-", "É/child"],
    ] as const;
    for (const paths of collisions) {
      const files = paths.map((path, index) => {
        return baseFile(path, `collision-${index.toString()}`);
      });
      for (const ordered of [files, [...files].reverse()]) {
        expect(() => {
          snapshotPiMemoryPhase2Input(
            consolidationArgs(ordered),
            new AbortController().signal,
          );
        }).toThrow(Phase2InputInvalidError);
      }
    }

    const nearPrefixes = [
      baseFile("a", "exact"),
      baseFile("a-/child", "hyphen"),
      baseFile("a.b", "dot"),
      baseFile("a0/b", "suffix"),
      baseFile("E\u0301", "decomposed"),
      baseFile("é-/child", "normalized hyphen"),
    ];
    for (const files of [nearPrefixes, [...nearPrefixes].reverse()]) {
      const snapshot = snapshotPiMemoryPhase2Input(
        consolidationArgs(files),
        new AbortController().signal,
      );
      expect(
        snapshot.baseFiles.map((file) => {
          return file.path;
        }),
      ).toStrictEqual(
        nearPrefixes
          .map((file) => {
            return file.path;
          })
          .sort(),
      );
    }
  });

  it("preflights file-count, path-byte, per-file, and total bounds before copying bytes", () => {
    const empty = {
      type: "file" as const,
      hash: EMPTY_HASH,
      size: 0,
      bytes: new Uint8Array(),
    };
    const tooMany = Array.from(
      { length: STORAGE_MANIFEST_MAX_FILES + 1 },
      (_, index) => {
        return { ...empty, path: `many/${index.toString()}` };
      },
    );
    const tooManyPathBytes = Array.from({ length: 49_000 }, (_, index) => {
      return {
        ...empty,
        path: `paths/${index.toString().padStart(5, "0")}-${"x".repeat(170)}`,
      };
    });
    const tooLargeTotal = Array.from({ length: 129 }, (_, index) => {
      return {
        ...empty,
        path: `total/${index.toString()}`,
        size: 1024 * 1024,
      };
    });
    for (const files of [tooMany, tooManyPathBytes, tooLargeTotal]) {
      expect(() => {
        snapshotPiMemoryPhase2Input(
          consolidationArgs(files),
          new AbortController().signal,
        );
      }).toThrow(Phase2InputInvalidError);
    }
  });

  it("projects ordered hashed evidence, prunes nested Pi only, and keeps private inputs private", async () => {
    const stale = baseFile("rollout_summaries/pi/stale.md", "stale");
    const replaced = baseFile(
      piEvidencePath("session-z"),
      "source_history_hash: old-history",
    );
    const snapshots = [
      selected("session-z"),
      selected("session-a", {
        rolloutSlug: `  Résumé / ${"Safe-".repeat(20)} secret_VALUE  `,
      }),
    ];
    const workspace = await freshWorkspace(
      [...VALID_BASE, stale, replaced],
      snapshots,
    );
    const evidenceA = piEvidencePath(
      "session-a",
      snapshots[1]?.rolloutSlug ?? null,
    );
    const evidenceZ = piEvidencePath("session-z");
    expect(evidenceA).toMatch(
      /^rollout_summaries\/pi\/[a-f0-9]{64}-[a-z0-9-]+\.md$/u,
    );
    const slug = evidenceA.slice(evidenceA.lastIndexOf("-") + 1, -3);
    expect(Buffer.byteLength(slug)).toBeLessThanOrEqual(
      PI_MEMORY_PHASE2_EVIDENCE_SLUG_MAX_BYTES,
    );
    expect(workspace.agentBaseline.has(evidenceA)).toBe(true);
    expect(workspace.agentBaseline.has(evidenceZ)).toBe(true);
    expect(workspace.agentBaseline.get(evidenceZ)?.equals(replaced.bytes)).toBe(
      false,
    );
    expect(workspace.agentBaseline.has("rollout_summaries/pi/stale.md")).toBe(
      false,
    );
    expect(
      workspace.agentBaseline.get("rollout_summaries/codex.md")?.toString(),
    ).toBe("codex evidence");

    const evidence = await readFile(
      join(workspace.memoryRoot, ...evidenceA.split("/")),
      "utf8",
    );
    expect(evidence).toContain('pi_session_id: "session-a"');
    expect(evidence).toContain('source_run_id: "run-session-a"');
    expect(evidence).toContain("source_history_hash:");
    expect(evidence).toContain(
      'source_completed_at: "2026-09-03T01:02:03.000Z"',
    );
    expect(evidence).toContain("summary-session-a");
    expect(evidence).not.toContain("raw-session-a");

    const privateRaw = await readFile(
      join(workspace.inputsRoot, "raw-memories.md"),
      "utf8",
    );
    expect(privateRaw.indexOf("session-a")).toBeLessThan(
      privateRaw.indexOf("session-z"),
    );
    expect(privateRaw).toContain("raw-session-a");
    const privateDiff = await readFile(
      join(workspace.inputsRoot, "workspace-diff.md"),
    );
    expect(privateDiff.length).toBeLessThanOrEqual(
      PI_MEMORY_PHASE2_WORKSPACE_DIFF_MAX_BYTES,
    );
    expect(workspace.diff).toMatchObject({ added: 1, changed: 1, deleted: 1 });

    const prepared = await validatePiMemoryPhase2Output(
      workspace,
      "storage-phase2",
    );
    expect(
      prepared.files.map((file) => {
        return file.path;
      }),
    ).toStrictEqual(
      prepared.files
        .map((file) => {
          return file.path;
        })
        .slice()
        .sort(),
    );
    const canonicalContentLines = prepared.files
      .map((file) => {
        return `${file.path}:${file.hash}`;
      })
      .sort();
    expect(prepared.contentIdentity).toBe(
      createHash("sha256")
        .update(`storage:storage-phase2\n${canonicalContentLines.join("\n")}`)
        .digest("hex"),
    );
    expect(
      prepared.files.some((file) => {
        return file.path.startsWith("inputs/");
      }),
    ).toBe(false);
    expect(
      prepared.files.find((file) => {
        return file.path === ".git/config";
      }),
    ).toMatchObject({
      path: ".git/config",
      hash: baseFile(".git/config", "codex-git-state").hash,
      size: Buffer.byteLength("codex-git-state"),
    });

    const permuted = await freshWorkspace(
      [replaced, stale, ...[...VALID_BASE].reverse()],
      [...snapshots].reverse(),
    );
    const permutedPrepared = await validatePiMemoryPhase2Output(
      permuted,
      "storage-phase2",
    );
    expect(permutedPrepared).toStrictEqual(prepared);
  });

  it("truncates private multibyte diffs on a valid UTF-8 boundary", () => {
    const input = `${"a".repeat(PI_MEMORY_PHASE2_WORKSPACE_DIFF_MAX_BYTES - 2)}💡💡`;
    const bounded = truncatePiMemoryPhase2WorkspaceDiff(input);
    expect(bounded.truncated).toBe(true);
    expect(bounded.content.length).toBeLessThanOrEqual(
      PI_MEMORY_PHASE2_WORKSPACE_DIFF_MAX_BYTES,
    );
    expect(() => {
      new TextDecoder("utf8", { fatal: true }).decode(bounded.content);
    }).not.toThrow();
    expect(bounded.content.toString()).toContain("[workspace diff truncated]");
  });

  it("accepts only the two consolidated files and valid optional skills as mutable", async () => {
    const workspace = await freshWorkspace(VALID_BASE);
    await put(workspace, "MEMORY.md", "# Task Group: updated\n");
    await put(
      workspace,
      "memory_summary.md",
      "v1\n## User Profile\n- updated\n",
    );
    await put(
      workspace,
      "skills/reusable/SKILL.md",
      "---\nname: reusable\ndescription: test\n---\n\n# Reusable\n",
    );
    await put(workspace, "skills/reusable/reference.md", "reference");

    const prepared = await validatePiMemoryPhase2Output(
      workspace,
      "storage-phase2",
    );
    const files = new Map(
      prepared.files.map((file) => {
        return [file.path, Buffer.from(file.bytes).toString()];
      }),
    );
    expect(files.get("MEMORY.md")).toContain("updated");
    expect(files.get(".git/config")).toBe("codex-git-state");
    expect(files.get("legacy-topic.md")).toBe("legacy");
    expect(files.get("raw_memories.md")).toBe("codex raw");
    expect(files.get("extensions/preserved.txt")).toBe("extension");
    expect(files.get("rollout_summaries/codex.md")).toBe("codex evidence");
  });

  it("rejects invalid generated text, skills, immutable changes, links, and special entries", async () => {
    const invalidMutations: ReadonlyArray<
      (workspace: Phase2PrivateWorkspace) => Promise<void>
    > = [
      async (workspace) => {
        await put(workspace, "MEMORY.md", "");
      },
      async (workspace) => {
        await unlink(join(workspace.memoryRoot, "MEMORY.md"));
      },
      async (workspace) => {
        await put(workspace, "MEMORY.md", Buffer.from([0xff]));
      },
      async (workspace) => {
        await put(
          workspace,
          "MEMORY.md",
          "x".repeat(PI_MEMORY_PHASE2_MEMORY_MAX_BYTES + 1),
        );
      },
      async (workspace) => {
        await put(workspace, "memory_summary.md", "V1\nwrong\n");
      },
      async (workspace) => {
        await put(workspace, "memory_summary.md", Buffer.from([0xff]));
      },
      async (workspace) => {
        await put(
          workspace,
          "memory_summary.md",
          `v1\n${"s".repeat(PI_MEMORY_SUMMARY_MAX_BYTES)}`,
        );
      },
      async (workspace) => {
        await put(workspace, "skills/missing-manifest/reference.md", "x");
      },
      async (workspace) => {
        await put(
          workspace,
          "skills/bad-manifest/SKILL.md",
          "---\nname: another-name\ndescription: mismatch\n---\n",
        );
      },
      async (workspace) => {
        await put(workspace, "skills/Bad_Name/SKILL.md", "x");
      },
      async (workspace) => {
        await put(
          workspace,
          "skills/large/SKILL.md",
          "x".repeat(PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILE_BYTES + 1),
        );
      },
      async (workspace) => {
        await put(
          workspace,
          "skills/too-many/SKILL.md",
          "---\nname: too-many\ndescription: count boundary\n---\n",
        );
        await Promise.all(
          Array.from(
            { length: PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILES },
            async (_, index) => {
              await put(
                workspace,
                `skills/too-many/file-${index.toString()}.md`,
                "x",
              );
            },
          ),
        );
      },
      async (workspace) => {
        await put(
          workspace,
          "skills/too-large-total/SKILL.md",
          "---\nname: too-large-total\ndescription: total boundary\n---\n",
        );
        await Promise.all(
          Array.from({ length: 17 }, async (_, index) => {
            await put(
              workspace,
              `skills/too-large-total/file-${index.toString()}.md`,
              "x".repeat(1024 * 1024),
            );
          }),
        );
      },
      async (workspace) => {
        await put(workspace, "legacy-topic.md", "mutated");
      },
      async (workspace) => {
        const target = join(workspace.memoryRoot, "memory_summary.md");
        await unlink(target);
        await symlink("MEMORY.md", target);
      },
      async (workspace) => {
        const outside = join(workspace.root, "hardlink-source");
        await writeFile(outside, "v1\n## User Profile\n");
        const target = join(workspace.memoryRoot, "memory_summary.md");
        await unlink(target);
        await link(outside, target);
      },
    ];

    for (const mutate of invalidMutations) {
      const workspace = await freshWorkspace(VALID_BASE);
      await mutate(workspace);
      await expect(
        validatePiMemoryPhase2Output(workspace, "storage-phase2"),
      ).rejects.toBeInstanceOf(Phase2OutputInvalidError);
    }
  });

  it("restores private permissions for cleanup without following links", async () => {
    const workspace = await freshWorkspace(VALID_BASE);
    const outside = join(
      tmpdir(),
      `pi-phase2-outside-${process.pid.toString()}`,
    );
    await writeFile(outside, "outside-safe");
    await symlink(outside, join(workspace.root, "cleanup-link"));
    await removePiMemoryPhase2Workspace(workspace.root);
    expect(await readFile(outside, "utf8")).toBe("outside-safe");
    await rm(outside);
    temporaryDirectories.splice(
      temporaryDirectories.indexOf(workspace.root),
      1,
    );
  });

  it("rejects a special filesystem entry without returning files", async () => {
    const workspace = await freshWorkspace(VALID_BASE);
    const socketPath = join(workspace.memoryRoot, "special.sock");
    const server = createNetServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      await expect(
        validatePiMemoryPhase2Output(workspace, "storage-phase2"),
      ).rejects.toBeInstanceOf(Phase2OutputInvalidError);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });
});
