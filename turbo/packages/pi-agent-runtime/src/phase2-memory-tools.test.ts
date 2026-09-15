import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPiMemoryPhase2Tools,
  PI_MEMORY_PHASE2_TOOL_MAX_PATH_BYTES,
  PI_MEMORY_PHASE2_TOOL_MAX_RENDERED_BYTES,
  PI_MEMORY_PHASE2_TOOL_MAX_WRITE_BYTES,
  PI_MEMORY_PHASE2_TOOL_NAMES,
} from "./phase2-memory-tools";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function put(root: string, path: string, content: string): Promise<void> {
  const target = join(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function roots(): Promise<{
  readonly root: string;
  readonly memoryRoot: string;
  readonly inputsRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-phase2-tools-"));
  temporaryDirectories.push(root);
  const memoryRoot = join(root, "memory");
  const inputsRoot = join(root, "inputs");
  await mkdir(memoryRoot);
  await mkdir(inputsRoot);
  return { root, memoryRoot, inputsRoot };
}

type ToolName = (typeof PI_MEMORY_PHASE2_TOOL_NAMES)[number];

function namedTool(
  tools: ReturnType<typeof createPiMemoryPhase2Tools>,
  name: ToolName,
) {
  const tool = tools.find((candidate) => {
    return candidate.name === name;
  });
  if (!tool) {
    throw new Error(`Missing Phase 2 tool ${name}`);
  }
  return tool;
}

async function executeText(
  tools: ReturnType<typeof createPiMemoryPhase2Tools>,
  name: ToolName,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const result = await namedTool(tools, name).execute(
    "phase2-tool-call",
    params as never,
    signal,
    undefined,
    undefined as never,
  );
  const content = result.content?.[0];
  if (content?.type !== "text") {
    throw new Error("Expected Phase 2 text tool output");
  }
  return content.text;
}

function expectSanitizedFailure(promise: Promise<unknown>, secret: string) {
  return expect(promise).rejects.toSatisfy((error: unknown) => {
    return (
      error instanceof Error &&
      error.message === "The Phase 2 maintenance tool request was rejected." &&
      !error.message.includes(secret) &&
      !error.message.includes("ENOENT")
    );
  });
}

describe("Pi memory Phase 2 maintenance tools", () => {
  it("exposes exactly six bounded tools and supports the allowed operations", async () => {
    const fixture = await roots();
    await put(fixture.memoryRoot, "MEMORY.md", "old needle");
    await put(fixture.memoryRoot, ".git/config", "hidden needle");
    await put(fixture.memoryRoot, "legacy.md", "legacy needle");
    await put(fixture.inputsRoot, "raw-memories.md", "private needle");
    await put(fixture.inputsRoot, "workspace-diff.md", "diff needle");
    const tools = createPiMemoryPhase2Tools(fixture);

    expect(
      tools.map((tool) => {
        return tool.name;
      }),
    ).toStrictEqual(PI_MEMORY_PHASE2_TOOL_NAMES);
    const listed = await executeText(tools, "phase2_list", {});
    expect(listed).toContain("file\tmemory/MEMORY.md");
    expect(listed).toContain("file\tinputs/raw-memories.md");
    expect(listed).not.toContain(".git");

    const read = await executeText(tools, "phase2_read", {
      path: "inputs/raw-memories.md",
    });
    expect(read).toBe("private needle");
    const search = await executeText(tools, "phase2_search", {
      query: "needle",
    });
    expect(search).toContain("memory/MEMORY.md:1: old needle");
    expect(search).toContain("memory/legacy.md:1: legacy needle");
    expect(search).toContain("inputs/raw-memories.md:1: private needle");
    expect(search).not.toContain("hidden needle");

    await executeText(tools, "phase2_write", {
      path: "memory/MEMORY.md",
      content: "new unique text",
    });
    await executeText(tools, "phase2_edit", {
      path: "memory/MEMORY.md",
      old_text: "unique",
      new_text: "edited",
    });
    await executeText(tools, "phase2_write", {
      path: "memory/memory_summary.md",
      content: "v1\n## User Profile\n",
    });
    await executeText(tools, "phase2_write", {
      path: "memory/skills/reusable/SKILL.md",
      content: "---\nname: reusable\ndescription: reusable\n---\n",
    });
    await executeText(tools, "phase2_write", {
      path: "memory/skills/reusable/reference.md",
      content: "temporary",
    });
    await executeText(tools, "phase2_remove", {
      path: "memory/skills/reusable/reference.md",
    });

    expect(await readFile(join(fixture.memoryRoot, "MEMORY.md"), "utf8")).toBe(
      "new edited text",
    );
    await expect(
      readFile(join(fixture.memoryRoot, "skills", "reusable", "reference.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(fixture.memoryRoot, "legacy.md"), "utf8")).toBe(
      "legacy needle",
    );
  });

  it("reports bounded summary numbers and leaves other outputs unchanged", async () => {
    const fixture = await roots();
    const tools = createPiMemoryPhase2Tools(fixture);

    expect(
      await executeText(tools, "phase2_write", {
        path: "memory/MEMORY.md",
        content: "# Task Group: unchanged feedback\n",
      }),
    ).toBe("written");
    expect(
      await executeText(tools, "phase2_write", {
        path: "memory/skills/reusable/SKILL.md",
        content: "---\nname: reusable\ndescription: reusable\n---\n",
      }),
    ).toBe("written");

    const summary = `v1\n## User Profile\n${" token".repeat(2936)}`;
    expect(encode(summary).length).toBe(2943);
    const written = await executeText(tools, "phase2_write", {
      path: "memory/memory_summary.md",
      content: summary,
    });
    expect(written).toBe(
      `written summary_bytes=${Buffer.byteLength(summary).toString()} summary_byte_limit=65536 summary_tokens=2943 summary_injection_target=2500`,
    );
    expect(written).not.toContain("token token");

    // The feedback describes the whole resulting file, not the edited fragment.
    const edited = await executeText(tools, "phase2_edit", {
      path: "memory/memory_summary.md",
      old_text: "## User Profile",
      new_text: "## User Profile\n- kept",
    });
    const updated = await readFile(
      join(fixture.memoryRoot, "memory_summary.md"),
      "utf8",
    );
    expect(edited).toBe(
      `edited summary_bytes=${Buffer.byteLength(updated).toString()} summary_byte_limit=65536 summary_tokens=${encode(updated).length.toString()} summary_injection_target=2500`,
    );
    expect(encode(updated).length).toBeGreaterThan(2500);
  });

  it("keeps summary feedback bounded above the source byte ceiling", async () => {
    const fixture = await roots();
    const tools = createPiMemoryPhase2Tools(fixture);
    // Tokenizing a multi-megabyte temporary source only to report that it
    // exceeds the byte ceiling would be unbounded work; bytes decide it.
    const oversized = `v1\n${"x".repeat(4 * 1024 * 1024)}`;

    expect(
      await executeText(tools, "phase2_write", {
        path: "memory/memory_summary.md",
        content: oversized,
      }),
    ).toBe(
      `written summary_bytes=${Buffer.byteLength(oversized).toString()} summary_byte_limit=65536 summary_tokens=unmeasured summary_injection_target=2500`,
    );
    expect(
      (await stat(join(fixture.memoryRoot, "memory_summary.md"))).size,
    ).toBe(Buffer.byteLength(oversized));
  });

  it("rejects every path escape and mutation outside the exact allowlist", async () => {
    const fixture = await roots();
    await put(fixture.memoryRoot, "legacy.md", "immutable-secret");
    await put(fixture.memoryRoot, "raw_memories.md", "root-raw-secret");
    await put(fixture.memoryRoot, "rollout_summaries/codex.md", "flat-secret");
    await put(
      fixture.memoryRoot,
      "rollout_summaries/pi/evidence.md",
      "pi-secret",
    );
    await put(
      fixture.memoryRoot,
      "extensions/preserved.txt",
      "extension-secret",
    );
    await put(fixture.memoryRoot, ".git/config", "git-secret");
    await put(fixture.inputsRoot, "other.md", "other-secret");
    const tools = createPiMemoryPhase2Tools(fixture);
    const hostilePaths = [
      "/etc/passwd",
      "../escape",
      "memory/../escape",
      "memory\\MEMORY.md",
      "memory//MEMORY.md",
      "C:/Windows/file",
      "memory/nul\0file",
      `memory/${"x".repeat(PI_MEMORY_PHASE2_TOOL_MAX_PATH_BYTES)}`,
      "memory/.git/config",
      "inputs/other.md",
    ];
    for (const path of hostilePaths) {
      await expectSanitizedFailure(
        executeText(tools, "phase2_read", { path }),
        "secret",
      );
    }

    const immutablePaths = [
      "memory/legacy.md",
      "memory/raw_memories.md",
      "memory/rollout_summaries/codex.md",
      "memory/rollout_summaries/pi/evidence.md",
      "memory/extensions/preserved.txt",
    ];
    for (const path of immutablePaths) {
      await expectSanitizedFailure(
        executeText(tools, "phase2_write", { path, content: "mutated" }),
        "secret",
      );
      await expectSanitizedFailure(
        executeText(tools, "phase2_remove", { path }),
        "secret",
      );
    }
    await expectSanitizedFailure(
      executeText(tools, "phase2_write", {
        path: "memory/MEMORY.md",
        content: "x".repeat(PI_MEMORY_PHASE2_TOOL_MAX_WRITE_BYTES + 1),
      }),
      "secret",
    );
    expect(await readFile(join(fixture.memoryRoot, "legacy.md"), "utf8")).toBe(
      "immutable-secret",
    );
  });

  it("revalidates symlinks and hard links at the filesystem boundary", async () => {
    const fixture = await roots();
    const outside = join(fixture.root, "outside");
    const safe = join(fixture.memoryRoot, "safe");
    const moved = join(fixture.memoryRoot, "safe-moved");
    await mkdir(outside);
    await put(outside, "secret.md", "outside-secret");
    await put(safe, "secret.md", "inside");
    let swapped = false;
    const tools = createPiMemoryPhase2Tools({
      ...fixture,
      testHooks: {
        async afterPathValidation(logicalPath) {
          if (logicalPath === "memory/safe/secret.md" && !swapped) {
            swapped = true;
            await rename(safe, moved);
            await symlink(outside, safe);
          }
        },
      },
    });
    await expectSanitizedFailure(
      executeText(tools, "phase2_read", {
        path: "memory/safe/secret.md",
      }),
      "outside-secret",
    );

    await put(fixture.memoryRoot, "hard-source.md", "hard secret");
    await link(
      join(fixture.memoryRoot, "hard-source.md"),
      join(fixture.memoryRoot, "hard-target.md"),
    );
    const plainTools = createPiMemoryPhase2Tools(fixture);
    await expectSanitizedFailure(
      executeText(plainTools, "phase2_read", {
        path: "memory/hard-target.md",
      }),
      "hard secret",
    );
    const outsideMemory = join(fixture.root, "outside-memory.md");
    await writeFile(outsideMemory, "outside memory unchanged");
    await link(outsideMemory, join(fixture.memoryRoot, "MEMORY.md"));
    await expectSanitizedFailure(
      executeText(plainTools, "phase2_write", {
        path: "memory/MEMORY.md",
        content: "mutated",
      }),
      "outside memory unchanged",
    );
    expect(await readFile(outsideMemory, "utf8")).toBe(
      "outside memory unchanged",
    );
    expect(await readFile(join(outside, "secret.md"), "utf8")).toBe(
      "outside-secret",
    );
  });

  it("keeps rendered multibyte output within its byte cap", async () => {
    const fixture = await roots();
    await put(
      fixture.memoryRoot,
      "large.md",
      "💡".repeat(PI_MEMORY_PHASE2_TOOL_MAX_RENDERED_BYTES),
    );
    const output = await executeText(
      createPiMemoryPhase2Tools(fixture),
      "phase2_read",
      { path: "memory/large.md" },
    );
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(
      PI_MEMORY_PHASE2_TOOL_MAX_RENDERED_BYTES,
    );
    expect(output).not.toContain("�");
  });
});
