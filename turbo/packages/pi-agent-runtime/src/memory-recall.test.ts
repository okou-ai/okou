import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PiMemoryRecallSelection } from "./api-types";
import {
  loadPiSandboxMemoryRecall,
  resolvePiApiMemoryRecall,
} from "./memory-recall-node";
import { createPiMemoryTools } from "./memory-tools-node";
import {
  PI_MEMORY_PROMPT_UPSTREAM_COMMIT,
  PI_MEMORY_SUMMARY_MAX_BYTES,
  PI_MEMORY_SUMMARY_MAX_TOKENS,
  PI_MEMORY_SUMMARY_SOURCE_MAX_TOKENS,
  piMemorySummaryTokenCount,
  renderPiMemoryRecall,
  truncatePiMemorySummary,
} from "./memory-recall";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

function sha256(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readySelection(
  content: string,
  overrides: Partial<
    Extract<PiMemoryRecallSelection, { status: "ready" }>
  > = {},
): Extract<PiMemoryRecallSelection, { status: "ready" }> {
  const bytes = Buffer.from(content, "utf8");
  return {
    status: "ready",
    memoryStorageId: "memory-storage",
    storageVersionId: "storage-version-a",
    content,
    sourceHash: sha256(bytes),
    sourceSize: bytes.byteLength,
    tokenCount: piMemorySummaryTokenCount(content),
    ...overrides,
  };
}

async function memoryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-recall-"));
  temporaryDirectories.push(root);
  return root;
}

describe("Pi memory recall compatibility", () => {
  it("pins the adapted Codex prompt and exact o200k token boundary", () => {
    expect(PI_MEMORY_PROMPT_UPSTREAM_COMMIT).toBe(
      "5adb68a49933ae446bf11935662c83dba55a0804",
    );
    const rendered = renderPiMemoryRecall(
      "Prefer focused targeted tests.",
    )?.block;
    expect(rendered).toContain(
      "MUST use `memories_search` and `memories_read` before saying that it is unavailable",
    );
    expect(rendered).toContain("including `extensions/ad_hoc/notes/`");
    expect(rendered).toContain(
      "Use `add_ad_hoc_note` only when the user explicitly asks you to remember, forget, or update something",
    );
    expect(rendered).toContain(
      "do not use Bash or another generic filesystem tool",
    );
    expect(rendered).toContain(
      "A successful tool result means only that the note is staged in the current sandbox",
    );
    expect(rendered).toContain(
      "Durable retention still depends on the terminal artifact checkpoint succeeding",
    );
    expect(rendered).toContain(
      "Do not claim that the update is durable, published, or persistently saved before the run completes successfully",
    );
    expect(sha256(rendered ?? "")).toBe(
      "54c661e1d38e525dabe6cab63e94ef7362b02e442448c7b39e968bbc1b045e89",
    );

    const oversized = Array.from({ length: 4000 }, (_, index) => {
      return `memory-${index}`;
    }).join(" ");
    const truncated = truncatePiMemorySummary(oversized);
    expect(truncated.truncated).toBe(true);
    expect(truncated.tokenCount).toBe(PI_MEMORY_SUMMARY_MAX_TOKENS);
    expect(piMemorySummaryTokenCount(truncated.text)).toBe(
      PI_MEMORY_SUMMARY_MAX_TOKENS,
    );
    expect(sha256(truncated.text)).toBe(
      "006aeaf2dcbd236813160e768d18708286a4d5997bbffdf8c4b957ed978491f6",
    );
  });

  it("renders identical frozen bytes for API-first and sandbox", async () => {
    const root = await memoryRoot();
    const content = "# Working memory\n\nUse the repository-native checks.";
    const selection = readySelection(content);
    await writeFile(join(root, "memory_summary.md"), content, "utf8");

    const api = resolvePiApiMemoryRecall({
      schemaVersion: 2,
      agentsFiles: [],
      skills: [],
      memoryRecall: selection,
    });
    const sandbox = await loadPiSandboxMemoryRecall(selection, root);

    expect(api.block).toBe(sandbox.block);
    expect(api.outcome).toMatchObject({
      mode: "api-first",
      status: "hit",
      parity: "frozen-match",
    });
    expect(sandbox.outcome).toMatchObject({
      mode: "sandbox",
      status: "hit",
      parity: "frozen-match",
    });
    expect(JSON.stringify(api.outcome)).not.toContain(content);
    expect(JSON.stringify(sandbox.outcome)).not.toContain(content);
    expect(
      api.block?.match(/========= MEMORY_SUMMARY BEGINS =========/gu),
    ).toHaveLength(1);
  });

  it("preserves V1 and frozen no-content as no-byte paths", async () => {
    expect(
      resolvePiApiMemoryRecall({
        schemaVersion: 1,
        agentsFiles: [],
        skills: [],
      }),
    ).toMatchObject({
      block: null,
      outcome: { status: "miss", parity: "not-applicable", reason: "v1" },
    });

    const noContent: PiMemoryRecallSelection = {
      status: "no-content",
      memoryStorageId: "memory-storage",
      storageVersionId: "storage-version-a",
    };
    await expect(
      loadPiSandboxMemoryRecall(noContent, "/path/that/must/not/be/read"),
    ).resolves.toMatchObject({
      block: null,
      outcome: {
        status: "miss",
        parity: "frozen-no-content",
        reason: "frozen-no-content",
      },
    });
  });
});

describe("sandbox Pi memory recall validation", () => {
  it("fails closed for missing, empty, symlink, and non-regular summaries", async () => {
    const root = await memoryRoot();
    const selection = readySelection("expected");

    await expect(
      loadPiSandboxMemoryRecall(selection, root),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "miss", reason: "missing" },
    });

    await writeFile(join(root, "memory_summary.md"), "", "utf8");
    await expect(
      loadPiSandboxMemoryRecall(selection, root),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "stale", reason: "size-mismatch" },
    });

    await rm(join(root, "memory_summary.md"));
    await symlink("target.md", join(root, "memory_summary.md"));
    await writeFile(join(root, "target.md"), "expected", "utf8");
    await expect(
      loadPiSandboxMemoryRecall(selection, root),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "invalid", reason: "symlink" },
    });

    await rm(join(root, "memory_summary.md"));
    await mkdir(join(root, "memory_summary.md"));
    await expect(
      loadPiSandboxMemoryRecall(selection, root),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "invalid", reason: "non-regular" },
    });
  });

  it("fails closed for invalid UTF-8, size, hash, and oversized files", async () => {
    const root = await memoryRoot();
    const path = join(root, "memory_summary.md");
    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    await writeFile(path, invalidUtf8);
    await expect(
      loadPiSandboxMemoryRecall(
        readySelection("ok", {
          content: "ok",
          sourceHash: sha256(invalidUtf8),
          sourceSize: invalidUtf8.byteLength,
          tokenCount: 1,
        }),
        root,
      ),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "invalid", reason: "invalid-utf8" },
    });

    await writeFile(path, "actual", "utf8");
    await expect(
      loadPiSandboxMemoryRecall(
        readySelection("actual", { sourceSize: 5 }),
        root,
      ),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "stale", reason: "size-mismatch" },
    });
    await expect(
      loadPiSandboxMemoryRecall(
        readySelection("actual", { sourceHash: "0".repeat(64) }),
        root,
      ),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "stale", reason: "hash-mismatch" },
    });

    await writeFile(path, "x".repeat(PI_MEMORY_SUMMARY_MAX_BYTES + 1), "utf8");
    await expect(
      loadPiSandboxMemoryRecall(readySelection("expected"), root),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "invalid", reason: "oversized" },
    });
  });

  it("fails closed for frozen token mismatch and impossible source counts", async () => {
    const root = await memoryRoot();
    const path = join(root, "memory_summary.md");

    await writeFile(path, "bounded memory", "utf8");
    const bounded = readySelection("bounded memory");
    await expect(
      loadPiSandboxMemoryRecall(
        { ...bounded, tokenCount: bounded.tokenCount + 1 },
        root,
      ),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "stale", reason: "token-mismatch" },
    });
    await expect(
      loadPiSandboxMemoryRecall(
        { ...bounded, tokenCount: PI_MEMORY_SUMMARY_SOURCE_MAX_TOKENS + 1 },
        root,
      ),
    ).resolves.toMatchObject({
      block: null,
      outcome: { status: "invalid", reason: "selection-invalid" },
    });
  });
});

/**
 * An ASCII summary of exactly `targetTokens` exact o200k tokens. Entries are
 * unique so an omitted middle stays detectable; ` x` is a single token, so the
 * tail padding lands the count exactly without a search loop.
 */
function syntheticSummary(targetTokens: number): string {
  const lines = ["# Working memory"];
  let index = 0;
  while (piMemorySummaryTokenCount(lines.join("\n")) < targetTokens * 0.6) {
    for (let batch = 0; batch < 16; batch += 1) {
      lines.push(
        `- decision-${index.toString()}: keep repository-native checks`,
      );
      index += 1;
    }
  }
  const content = lines.join("\n");
  return (
    content + " x".repeat(targetTokens - piMemorySummaryTokenCount(content))
  );
}

/** Repeats `unit` until the exact o200k count exceeds `atLeast`. */
function repeatBeyond(unit: string, atLeast: number): string {
  return unit.repeat(Math.ceil(atLeast / piMemorySummaryTokenCount(unit)) + 1);
}

async function readSummaryLines(
  root: string,
  startLine: number,
  lineCount: number,
): Promise<string> {
  const tool = createPiMemoryTools({
    mode: "sandbox",
    selection: {
      status: "no-content",
      memoryStorageId: "memory-storage",
      storageVersionId: "storage-version-a",
    },
    memoryRoot: root,
  }).find((candidate) => {
    return candidate.name === "memories_read";
  });
  if (!tool) {
    throw new Error("Missing memories_read tool");
  }
  const result = await tool.execute(
    "memory-tool-call",
    {
      path: "memory_summary.md",
      start_line: startLine,
      line_count: lineCount,
    } as never,
    undefined,
    undefined,
    undefined as never,
  );
  const content = result.content?.[0];
  if (content?.type !== "text") {
    throw new Error("Expected text content from memories_read");
  }
  return content.text;
}

describe("Pi memory recall bounded injection", () => {
  it("authenticates a full 2943-token source and injects a bounded excerpt", async () => {
    const root = await memoryRoot();
    const content = syntheticSummary(2943);
    expect(piMemorySummaryTokenCount(content)).toBe(2943);
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(
      PI_MEMORY_SUMMARY_MAX_BYTES,
    );

    const selection = readySelection(content);
    await writeFile(join(root, "memory_summary.md"), content, "utf8");
    const api = resolvePiApiMemoryRecall({
      schemaVersion: 2,
      agentsFiles: [],
      skills: [],
      memoryRecall: selection,
    });
    const sandbox = await loadPiSandboxMemoryRecall(selection, root);

    expect(api.outcome).toMatchObject({
      mode: "api-first",
      status: "hit",
      parity: "frozen-match",
      reason: "matched",
    });
    expect(sandbox.outcome).toMatchObject({
      mode: "sandbox",
      status: "hit",
      parity: "frozen-match",
      reason: "matched",
    });
    // API-first and sandbox inject the same excerpt of the same frozen source.
    expect(api.block).toBe(sandbox.block);
    expect(api.outcome.injectedTokenCount).toBe(
      sandbox.outcome.injectedTokenCount,
    );
    expect(api.outcome.injectedTokenCount).toBeLessThanOrEqual(
      PI_MEMORY_SUMMARY_MAX_TOKENS,
    );
    expect(api.outcome.injectedTokenCount).toBeLessThan(2943);

    // Full-source metadata is never replaced by excerpt metadata.
    expect(selection.tokenCount).toBe(2943);
    expect(api.outcome.sourceSize).toBe(Buffer.byteLength(content, "utf8"));
    expect(api.outcome.sourceHash).toBe(sha256(Buffer.from(content, "utf8")));

    const excerpt = truncatePiMemorySummary(content);
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.originalTokenCount).toBe(2943);
    expect(piMemorySummaryTokenCount(excerpt.text)).toBe(excerpt.tokenCount);
    expect(excerpt.tokenCount).toBeLessThanOrEqual(
      PI_MEMORY_SUMMARY_MAX_TOKENS,
    );
    expect(excerpt.text).toMatch(/\n…\d+ tokens truncated…\n/u);
  });

  it("keeps omitted middle content readable through memories_read", async () => {
    const root = await memoryRoot();
    const content = syntheticSummary(2943);
    await writeFile(join(root, "memory_summary.md"), content, "utf8");
    const selection = readySelection(content);
    const sandbox = await loadPiSandboxMemoryRecall(selection, root);
    const block = sandbox.block ?? "";

    const lines = content.split("\n");
    const omitted = lines
      .map((line, offset) => {
        return { line, lineNumber: offset + 1 };
      })
      .filter((entry) => {
        return (
          entry.line.startsWith("- decision-") && !block.includes(entry.line)
        );
      });
    expect(omitted.length).toBeGreaterThan(0);

    const first = omitted[0];
    if (!first) {
      throw new Error("Expected an omitted summary line");
    }
    const read = await readSummaryLines(root, first.lineNumber, 1);
    expect(read).toContain(first.line);
  });

  it("discloses truncation and allows reading the omitted summary content", () => {
    const intact = renderPiMemoryRecall("Prefer focused targeted tests.");
    expect(intact?.block).toContain(
      "(already provided below; do NOT open again)",
    );
    expect(intact?.block).not.toContain("Truncated MEMORY_SUMMARY:");

    const truncated = renderPiMemoryRecall(syntheticSummary(3200));
    expect(truncated?.block).toContain("Truncated MEMORY_SUMMARY:");
    expect(truncated?.block).toContain(
      "run a targeted `memories_read` on `memory_summary.md`",
    );
    expect(truncated?.block).not.toContain(
      "(already provided below; do NOT open again)",
    );
  });

  it("keeps under-limit and exactly-at-limit summaries intact", () => {
    const underLimit = syntheticSummary(PI_MEMORY_SUMMARY_MAX_TOKENS - 200);
    const under = truncatePiMemorySummary(underLimit);
    expect(under.truncated).toBe(false);
    expect(under.text).toBe(underLimit.trim());

    const atLimit = syntheticSummary(PI_MEMORY_SUMMARY_MAX_TOKENS);
    expect(piMemorySummaryTokenCount(atLimit)).toBe(
      PI_MEMORY_SUMMARY_MAX_TOKENS,
    );
    const exact = truncatePiMemorySummary(atLimit);
    expect(exact.truncated).toBe(false);
    expect(exact.tokenCount).toBe(PI_MEMORY_SUMMARY_MAX_TOKENS);
    expect(exact.text).toBe(atLimit.trim());
  });

  it.each([
    ["chinese", "记忆摘要：保持仓库原生检查与定向测试。\n"],
    ["emoji", "🎉 launch 🚀 note 👍🏽 family 👨‍👩‍👧‍👦 flag 🇨🇳 done\n"],
    ["multi-token characters", "𠀀𠀁𠀂𠀃𠀄𠀅𠀆𠀇𠀈𠀉 rare plane-2 glyphs\n"],
    ["mixed whitespace", "  记忆 \t memory 🎉 note \n\n"],
  ])("keeps %s excerpts deterministic and valid Unicode", (_name, unit) => {
    const content = repeatBeyond(unit, PI_MEMORY_SUMMARY_MAX_TOKENS + 700);
    const trimmed = content.trim();
    expect(trimmed).not.toContain("�");

    const first = truncatePiMemorySummary(content);
    const second = truncatePiMemorySummary(content);
    expect(first.truncated).toBe(true);
    expect(second.text).toBe(first.text);
    expect(first.tokenCount).toBeLessThanOrEqual(PI_MEMORY_SUMMARY_MAX_TOKENS);
    expect(piMemorySummaryTokenCount(first.text)).toBe(first.tokenCount);
    // A token slice boundary must not introduce a replacement character.
    expect(first.text).not.toContain("�");

    // The excerpt is a genuine prefix plus a genuine suffix of the source.
    const marker = /\n…\d+ tokens truncated…\n/u.exec(first.text);
    const markerText = marker?.[0];
    if (markerText === undefined) {
      throw new Error("Expected a truncation marker");
    }
    const markerIndex = first.text.indexOf(markerText);
    expect(trimmed.startsWith(first.text.slice(0, markerIndex))).toBe(true);
    expect(
      trimmed.endsWith(first.text.slice(markerIndex + markerText.length)),
    ).toBe(true);
  });

  it("does not leak tokenizer decoder state between excerpts", () => {
    // Characters that span several tokens used to leave partial bytes buffered
    // in the tokenizer's shared streaming decoder when a slice split them.
    const unicodeSource = repeatBeyond(
      "𠀀𠀁𠀂𠀃𠀄𠀅𠀆𠀇𠀈𠀉",
      PI_MEMORY_SUMMARY_MAX_TOKENS + 500,
    );
    for (const padding of ["", "x", "xx", "xxx"]) {
      expect(
        truncatePiMemorySummary(`${padding}${unicodeSource}`).text,
      ).not.toContain("�");
    }
    expect(
      sha256(
        renderPiMemoryRecall("Prefer focused targeted tests.")?.block ?? "",
      ),
    ).toBe("54c661e1d38e525dabe6cab63e94ef7362b02e442448c7b39e968bbc1b045e89");
  });
});
