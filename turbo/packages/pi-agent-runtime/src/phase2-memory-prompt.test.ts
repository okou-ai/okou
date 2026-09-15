import { createHash } from "node:crypto";

import {
  PI_MEMORY_SUMMARY_MAX_BYTES,
  PI_MEMORY_SUMMARY_MAX_TOKENS,
} from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";

import {
  PI_MEMORY_PHASE2_ADAPTED_TEMPLATE_SHA256,
  PI_MEMORY_PHASE2_UPSTREAM_COMMIT,
  PI_MEMORY_PHASE2_UPSTREAM_LICENSE,
  PI_MEMORY_PHASE2_UPSTREAM_TEMPLATE_PATH,
  PI_MEMORY_PHASE2_UPSTREAM_TEMPLATE_SHA256,
  renderPiMemoryPhase2Prompt,
} from "./phase2-memory-prompt";

describe("Pi memory Phase 2 prompt", () => {
  it("pins the attributed Codex source and adapted template digest", () => {
    expect(PI_MEMORY_PHASE2_UPSTREAM_COMMIT).toBe(
      "5adb68a49933ae446bf11935662c83dba55a0804",
    );
    expect(PI_MEMORY_PHASE2_UPSTREAM_TEMPLATE_PATH).toBe(
      "codex-rs/memories/write/templates/memories/consolidation.md",
    );
    expect(PI_MEMORY_PHASE2_UPSTREAM_TEMPLATE_SHA256).toBe(
      "1450e24f84c03375aa5114c6c0857f515395129dcc00f65263221d03866852a0",
    );
    expect(PI_MEMORY_PHASE2_UPSTREAM_LICENSE).toBe("Apache-2.0");

    const prompt = renderPiMemoryPhase2Prompt();
    expect(createHash("sha256").update(prompt).digest("hex")).toBe(
      PI_MEMORY_PHASE2_ADAPTED_TEMPLATE_SHA256,
    );
  });

  it("pins output schemas, private inputs, immutable data, and disabled capabilities", () => {
    const prompt = renderPiMemoryPhase2Prompt();
    const requiredBlocks = [
      "untrusted source data",
      "inputs/raw-memories.md",
      "inputs/workspace-diff.md",
      "memory/rollout_summaries/pi/",
      "memory/MEMORY.md",
      "memory/memory_summary.md",
      "memory/skills/**",
      "memory/.git/**",
      "memory/rollout_summaries/*.md",
      "memory/raw_memories.md",
      "first line must be exactly `v1`",
      "# Task Group:",
      "### rollout_summary_files",
      "### keywords",
      "original session JSONL",
      "recursive memory generation",
      "collaboration or",
      "subagent",
      "connector or MCP",
      "network/fetch capability",
      "approval path",
      "notification",
      "app, plugin, extension",
      "user-visible chat output",
      "no shell, Bash, process execution",
    ];
    for (const block of requiredBlocks) {
      expect(prompt).toContain(block);
    }
  });

  it("states the injection target and the hard byte limit as separate numbers", () => {
    const prompt = renderPiMemoryPhase2Prompt();
    expect(prompt).toContain(
      `at most ${PI_MEMORY_SUMMARY_MAX_TOKENS.toString()} exact o200k tokens`,
    );
    expect(prompt).toContain(
      `within ${PI_MEMORY_SUMMARY_MAX_BYTES.toString()} UTF-8 bytes`,
    );
    expect(prompt).toContain(
      "A file above the 2500-token target is still valid and is stored in full",
    );
  });
});
