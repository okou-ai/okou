import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, onTestFinished } from "vitest";
import { createPiAgentSessionForRuntime } from "./session-runtime";
import { createPiMemoryReader } from "./memory-reader-node";
import { PI_MEMORY_SUMMARY_EXCERPT_BYTES } from "@okouai/api-contracts/contracts/memory-reader";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-"));
  onTestFinished(() => {
    return rm(root, { recursive: true, force: true });
  });
  const agentDir = join(root, "agent");
  const memory = join(agentDir, "memory");
  await mkdir(memory, { recursive: true });
  async function session(snapshot: boolean = false) {
    const created = await createPiAgentSessionForRuntime({
      cwd: root,
      agentDir,
      sessionManager: SessionManager.inMemory(root, { id: randomUUID() }),
      model: {
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
        model: "openai/gpt-6-luna",
        dialect: "openai-responses",
        transport: "sse",
      },
      appendSystemPrompt: null,
      ...(snapshot
        ? {
            resourceSnapshot: {
              schemaVersion: 1 as const,
              agentsFiles: [],
              skills: [],
            },
          }
        : {}),
    });
    onTestFinished(() => {
      return created.session.dispose();
    });
    return created.session;
  }
  return { root, agentDir, memory, session };
}

async function call(
  session: AgentSession,
  name: string,
  params: {
    path: string;
    query: string;
    start_line?: number;
    line_count?: number;
  },
) {
  const tool = session.getToolDefinition(name);
  if (!tool) throw new Error(`Missing ${name}`);
  const result = await tool.execute(
    "memory-test",
    params,
    undefined,
    undefined,
    session.extensionRunner.createToolContext("memory-test", undefined),
  );
  return result.content
    .map((entry) => {
      return entry.type === "text" ? entry.text : "";
    })
    .join("\n");
}

describe("personal Memory session reader", () => {
  it.each([false, true])(
    "injects only the summary into the actual session prompt (snapshot=%s)",
    async (snapshot) => {
      const f = await fixture();
      await writeFile(
        join(f.memory, "memory_summary.md"),
        "v1\n## User Profile\nA remembered overview 🐱",
      );
      await writeFile(
        join(f.memory, "MEMORY.md"),
        "Index-only hidden detail pointer: notes/fact.md",
      );
      const session = await f.session(snapshot);
      expect(session.systemPrompt).toContain("A remembered overview 🐱");
      expect(session.systemPrompt).toContain("lower-priority context");
      expect(session.systemPrompt).toContain("current user corrections");
      expect(session.systemPrompt).not.toContain(
        "Index-only hidden detail pointer",
      );
      expect(session.getActiveToolNames()).toEqual(
        expect.arrayContaining([
          "memories_list",
          "memories_search",
          "memories_read",
        ]),
      );
    },
  );

  it("preserves official APPEND_SYSTEM.md discovery alongside Memory", async () => {
    const f = await fixture();
    await writeFile(
      join(f.agentDir, "APPEND_SYSTEM.md"),
      "Discovered append instructions",
    );
    await writeFile(join(f.memory, "memory_summary.md"), "Selected summary");
    const session = await f.session();
    expect(session.systemPrompt).toContain("Discovered append instructions");
    expect(session.systemPrompt).toContain("Selected summary");
  });

  it.each([
    "missing",
    "empty-directory",
    "empty",
    "index-only",
    "oversized",
    "invalid-utf8",
    "binary",
    "symlink",
  ])("starts a valid session with %s summary", async (mode) => {
    const f = await fixture();
    if (mode !== "empty-directory")
      await writeFile(join(f.memory, "MEMORY.md"), "Registry still readable");
    if (mode === "empty")
      await writeFile(join(f.memory, "memory_summary.md"), " \n");
    if (mode === "oversized")
      await writeFile(join(f.memory, "memory_summary.md"), "x".repeat(65537));
    if (mode === "invalid-utf8")
      await writeFile(join(f.memory, "memory_summary.md"), Buffer.from([0xff]));
    if (mode === "binary")
      await writeFile(join(f.memory, "memory_summary.md"), "bad\u0000summary");
    if (mode === "symlink") {
      await writeFile(join(f.root, "outside"), "Private outside summary");
      await symlink(
        join(f.root, "outside"),
        join(f.memory, "memory_summary.md"),
      );
    }
    if (mode === "missing") await rm(f.memory, { recursive: true });
    const session = await f.session();
    expect(session.systemPrompt).toContain("Okou Harness");
    const reader = await createPiMemoryReader(f.memory);
    expect(reader.observation.injectedBytes).toBe(0);
    if (mode !== "missing") {
      expect(session.systemPrompt).toContain("No usable summary was loaded");
      if (mode !== "empty-directory") {
        expect(
          await call(session, "memories_read", {
            path: "MEMORY.md",
            query: "",
          }),
        ).toContain("Registry still readable");
      } else {
        expect(
          await call(session, "memories_list", { path: "", query: "" }),
        ).toContain("lower-priority context");
      }
    }
  });

  it("bounds Unicode summaries including their truncation disclosure", async () => {
    const f = await fixture();
    await writeFile(join(f.memory, "memory_summary.md"), "🐱记忆".repeat(3000));
    const session = await f.session();
    const excerpt = session.systemPrompt
      .split("<personal_memory_summary>\n")[1]
      ?.split("\n</personal_memory_summary>")[0];
    expect(excerpt).toContain("[truncated:");
    expect(excerpt).not.toContain("�");
    expect(Buffer.byteLength(excerpt ?? "")).toBeLessThanOrEqual(
      PI_MEMORY_SUMMARY_EXCERPT_BYTES,
    );
  });

  it("accepts the source byte ceiling and rejects a symlink root without failing startup", async () => {
    const f = await fixture();
    await writeFile(join(f.memory, "memory_summary.md"), "s".repeat(65536));
    expect((await f.session()).systemPrompt).toContain("[truncated:");
    await rename(f.memory, join(f.root, "outside-memory"));
    await symlink(join(f.root, "outside-memory"), f.memory);
    const session = await f.session();
    expect(session.systemPrompt).toContain("Okou Harness");
    await expect(
      call(session, "memories_read", { path: "memory_summary.md", query: "" }),
    ).rejects.toThrow("unavailable");
  });

  it("lists, searches the registry and follows root-relative detail references", async () => {
    const f = await fixture();
    await mkdir(join(f.memory, "custom-details"));
    await writeFile(
      join(f.memory, "MEMORY.md"),
      "Project alpha: custom-details/fact:2026.md",
    );
    await writeFile(
      join(f.memory, "custom-details/fact:2026.md"),
      "Source: prior Run\nAlpha fact 🐱\nThird line",
    );
    const session = await f.session();
    expect(
      await call(session, "memories_list", { path: "", query: "" }),
    ).toContain("file\tMEMORY.md");
    expect(
      await call(session, "memories_search", {
        path: "MEMORY.md",
        query: "ALPHA",
      }),
    ).toContain("MEMORY.md:1: Project alpha");
    expect(
      await call(session, "memories_search", { path: "", query: "Alpha fact" }),
    ).toContain("custom-details/fact:2026.md:2:");
    expect(
      await call(session, "memories_read", {
        path: "custom-details/fact:2026.md",
        query: "",
        start_line: 2,
        line_count: 1,
      }),
    ).toContain("2: Alpha fact 🐱");
    await expect(
      call(session, "memories_list", { path: "MEMORY.md", query: "" }),
    ).rejects.toThrow("directory");
  });

  it.each([
    "../outside",
    "/etc/passwd",
    "notes/../../outside",
    "notes\\outside",
    "C:/outside",
    "link",
    "linked-dir/outside",
  ])("rejects escaping or symlink paths: %s", async (path) => {
    const f = await fixture();
    await writeFile(join(f.root, "outside"), "Other user's fact");
    await symlink(join(f.root, "outside"), join(f.memory, "link"));
    await symlink(f.root, join(f.memory, "linked-dir"));
    const session = await f.session();
    await expect(
      call(session, "memories_read", { path, query: "" }),
    ).rejects.toThrow();
    expect(
      await call(session, "memories_search", {
        path: "",
        query: "Other user's fact",
      }),
    ).not.toContain("Other user's fact");
  });

  it("rejects a replaced mount rather than switching a running session to another version", async () => {
    const f = await fixture();
    await writeFile(join(f.memory, "MEMORY.md"), "Selected version");
    const session = await f.session();
    await rename(f.memory, join(f.agentDir, "original"));
    await mkdir(f.memory);
    await writeFile(join(f.memory, "MEMORY.md"), "Later unselected version");
    await expect(
      call(session, "memories_read", { path: "MEMORY.md", query: "" }),
    ).rejects.toThrow("Selected Memory mount changed");
  });

  it("bounds reads and search results, and reports partial coverage", async () => {
    const f = await fixture();
    await writeFile(join(f.memory, "MEMORY.md"), "needle 🐱".repeat(10000));
    await writeFile(join(f.memory, "large"), "x".repeat(1024 * 1024 + 1));
    const session = await f.session();
    const read = await call(session, "memories_read", {
      path: "MEMORY.md",
      query: "",
    });
    expect(Buffer.byteLength(read)).toBeLessThanOrEqual(16 * 1024);
    expect(read).toContain("[truncated:");
    expect(read).not.toContain("�");
    await expect(
      call(session, "memories_read", { path: "large", query: "" }),
    ).rejects.toThrow("bounded regular file");
    expect(
      await call(session, "memories_search", { path: "", query: "needle" }),
    ).toContain("[truncated:");
    await writeFile(join(f.memory, "many.md"), "needle\n".repeat(100));
    const matches = await call(session, "memories_search", {
      path: "many.md",
      query: "needle",
    });
    expect(matches.match(/^many.md:/gmu)).toHaveLength(50);
    expect(matches).toContain("[truncated:");
  });
});
