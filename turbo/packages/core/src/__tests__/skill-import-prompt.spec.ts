import { describe, expect, it } from "vitest";
import { buildSkillImportPrompt } from "../skill-import-prompt";

const limits = {
  maxSkillsPerSession: 50,
  maxInstructionBytes: 256 * 1024,
  maxFilesPerSkill: 50,
  maxFileBytes: 64 * 1024,
  maxTotalFileBytes: 1024 * 1024,
  maxRequestBytes: 2 * 1024 * 1024,
};

function prompt(overrides: Partial<typeof limits> = {}): string {
  return buildSkillImportPrompt({
    uploadUrl: "https://api.okou.ai/api/skill-import/skills",
    token: "vm0_skillimport_test-token",
    limits: { ...limits, ...overrides },
  });
}

describe("skill import prompt", () => {
  it("carries the session's upload URL and token", () => {
    const text = prompt();

    expect(text).toContain("https://api.okou.ai/api/skill-import/skills");
    expect(text).toContain("Bearer vm0_skillimport_test-token");
  });

  it("names every location a local skill can live in", () => {
    const text = prompt();

    expect(text).toContain("~/.claude/skills/*/SKILL.md");
    expect(text).toContain("~/.codex/skills/*/SKILL.md");
    expect(text).toContain(".claude/skills/*/SKILL.md");
  });

  it("maps frontmatter to metadata and the body to the instruction", () => {
    const text = prompt();

    expect(text).toContain("frontmatter");
    expect(text).toContain("`name` and\n  `description`");
    expect(text).toContain("Everything after the frontmatter is the");
  });

  it("keeps SKILL.md out of the uploaded files", () => {
    expect(prompt()).toContain("Never upload `SKILL.md` itself as a file");
  });

  it("gates attachments on a text extension and a NUL-byte check", () => {
    const text = prompt();

    expect(text).toContain("`.md`");
    expect(text).toContain("`.yaml`");
    expect(text).toContain("NUL byte");
  });

  it("refuses credentials and secret-looking files", () => {
    const text = prompt();

    expect(text).toContain("`.env`");
    expect(text).toContain("`*.pem`");
    expect(text).toContain("It is not a credential");
    expect(text).toContain("Never include this session's token");
  });

  it("uploads one skill per request", () => {
    expect(prompt()).toContain("Upload one skill per request");
  });

  it("states the metadata rules the upload route enforces", () => {
    const text = prompt();

    expect(text).toContain("`My Skill` arrives as");
    expect(text).toContain("at most 256 characters");
    expect(text).toContain("at most 1024\n  characters");
  });

  it("renders the limits it was given rather than fixed defaults", () => {
    const text = prompt({
      maxSkillsPerSession: 7,
      maxInstructionBytes: 8 * 1024,
      maxRequestBytes: 3 * 1024 * 1024,
    });

    expect(text).toContain("At most 7 skills in this session");
    expect(text).toContain("8 KB (8192 bytes)");
    expect(text).toContain("3 MB (3145728 bytes)");
    expect(text).not.toContain("At most 50 skills in this session");
  });

  it("states the retry rule for each upload status", () => {
    const text = prompt();

    expect(text).toContain("`409`: the name is taken");
    expect(text).toContain("`-imported` appended to the name");
    expect(text).toContain("`413`: too large. Retry that skill once without");
    expect(text).toContain("`401`: the session has expired");
    expect(text).toContain("ask me for a fresh import link");
  });

  it("ends with an imported, skipped, and failed summary", () => {
    const text = prompt();

    expect(text).toContain(
      "print one summary listing imported, skipped, and failed",
    );
  });
});
