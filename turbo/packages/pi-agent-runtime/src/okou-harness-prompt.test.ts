import { describe, expect, it } from "vitest";

import {
  buildOkouHarnessSystemPrompt,
  type OkouHarnessToolPrompt,
} from "./okou-harness-prompt";

const READ_TOOL: OkouHarnessToolPrompt = {
  name: "read",
  snippet: "Read file contents",
  guidelines: ["Use read to examine files instead of cat or sed."],
};

const BASH_TOOL: OkouHarnessToolPrompt = {
  name: "bash",
  snippet: "Execute bash commands (ls, grep, find, etc.)",
};

describe("Okou Harness base system prompt", () => {
  it("renders tools and guidelines in the order the session activates them", () => {
    const prompt = buildOkouHarnessSystemPrompt([
      READ_TOOL,
      BASH_TOOL,
      { name: "write", snippet: "Create or overwrite files" },
    ]);

    expect(prompt).toContain(
      [
        "Available tools:",
        "- read: Read file contents",
        "- bash: Execute bash commands (ls, grep, find, etc.)",
        "- write: Create or overwrite files",
      ].join("\n"),
    );
    expect(prompt).toContain(
      [
        "Guidelines:",
        "- Use bash for file operations like ls, rg, find",
        "- Use read to examine files instead of cat or sed.",
        "- Show file paths clearly when working with files",
      ].join("\n"),
    );
  });

  it("drops the shell file-operation guideline when a search tool is active", () => {
    const prompt = buildOkouHarnessSystemPrompt([
      BASH_TOOL,
      { name: "grep", snippet: "Search file contents for patterns" },
    ]);

    expect(prompt).not.toContain("Use bash for file operations");
    expect(prompt).toContain(
      "- Show file paths clearly when working with files",
    );
  });

  it("keeps the shell file-operation guideline out when no shell is active", () => {
    const prompt = buildOkouHarnessSystemPrompt([READ_TOOL]);

    expect(prompt).not.toContain("Use bash for file operations");
  });

  it("omits a tool without a snippet from the available tools section", () => {
    const prompt = buildOkouHarnessSystemPrompt([
      READ_TOOL,
      { name: "memories_search", guidelines: ["Search frozen memory first."] },
    ]);

    expect(prompt).not.toContain("- memories_search:");
    expect(prompt).toContain("- Search frozen memory first.");
  });

  it("reports an empty tool list rather than an empty section", () => {
    const prompt = buildOkouHarnessSystemPrompt([]);

    expect(prompt).toContain("Available tools:\n(none)");
  });

  it("keeps one copy of a guideline two tools both contribute", () => {
    const shared = "Prefer the smallest unique match.";
    const prompt = buildOkouHarnessSystemPrompt([
      { name: "edit", snippet: "Edit files", guidelines: [shared] },
      { name: "write", snippet: "Write files", guidelines: [shared, "  "] },
    ]);

    expect(prompt.match(new RegExp(`- ${shared}`, "gu"))).toHaveLength(1);
    expect(prompt).not.toContain("- \n");
  });

  it("names Okou Harness without naming the underlying harness package", () => {
    const prompt = buildOkouHarnessSystemPrompt([READ_TOOL, BASH_TOOL]);

    expect(prompt).toContain(
      "You are an agent running on Okou Harness, Okou's agent runtime.",
    );
    expect(prompt).toContain("Refer to your runtime as Okou Harness.");
    expect(prompt).toContain(
      "Your work is not limited to software engineering.",
    );
    expect(prompt).not.toContain("coding agent harness");
    expect(prompt).not.toContain("Pi documentation");
    expect(prompt).not.toContain("Be concise in your responses");
  });

  it("leaves the working directory line to the official builder", () => {
    const prompt = buildOkouHarnessSystemPrompt([READ_TOOL]);

    expect(prompt).not.toContain("Current working directory:");
  });
});
